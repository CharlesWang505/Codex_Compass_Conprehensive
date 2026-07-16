use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use super::codex_adapter::{AppServerClient, CodexProjectCatalog};
use super::workspace::{AuthorizedWorkspace, authorized_workspace_for_path};

const DEFAULT_PAGE_SIZE: usize = 40;
const MAX_PAGE_SIZE: usize = 80;
const MAX_SEARCH_LENGTH: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionStatus {
    All,
    Active,
    Archived,
}

impl SessionStatus {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("active") {
            "all" => Ok(Self::All),
            "active" => Ok(Self::Active),
            "archived" => Ok(Self::Archived),
            _ => Err("会话状态筛选无效".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Active => "active",
            Self::Archived => "archived",
        }
    }
}

#[derive(Debug, Clone)]
struct SessionListRequest {
    offset: usize,
    limit: usize,
    status: SessionStatus,
    workspace_id: Option<String>,
    query: String,
}

impl SessionListRequest {
    fn parse(payload: &Value) -> Result<Self, String> {
        let offset = payload
            .get("cursor")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::parse::<usize>)
            .transpose()
            .map_err(|_| "会话分页游标无效".to_string())?
            .unwrap_or(0);
        let limit = payload
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_PAGE_SIZE as u64)
            .clamp(1, MAX_PAGE_SIZE as u64) as usize;
        let workspace_id = payload
            .get("workspaceId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let query = payload
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if query.chars().count() > MAX_SEARCH_LENGTH {
            return Err("搜索内容超过 200 个字符".to_string());
        }
        Ok(Self {
            offset,
            limit,
            status: SessionStatus::parse(payload.get("status").and_then(Value::as_str))?,
            workspace_id,
            query,
        })
    }
}

#[derive(Debug, Clone)]
struct IndexedSession {
    id: String,
    project_id: String,
    can_continue: bool,
    archived: bool,
    updated_at: i64,
    value: Value,
}

pub async fn list_remote_sessions(
    app_server: &AppServerClient,
    workspaces: &[AuthorizedWorkspace],
    payload: &Value,
) -> Result<Value, String> {
    let request = SessionListRequest::parse(payload)?;
    let projects = CodexProjectCatalog::load(workspaces)?;

    let (active, archived) = tokio::try_join!(
        app_server.list_all_sessions(false),
        app_server.list_all_sessions(true)
    )?;

    Ok(build_session_list_payload(
        active, archived, &projects, workspaces, &request,
    ))
}

fn build_session_list_payload(
    active: Vec<Value>,
    archived: Vec<Value>,
    projects: &CodexProjectCatalog,
    workspaces: &[AuthorizedWorkspace],
    request: &SessionListRequest,
) -> Value {
    let mut sessions = active
        .into_iter()
        .filter_map(|thread| {
            index_session(
                thread,
                false,
                projects,
                workspaces,
                request.workspace_id.as_deref(),
                &request.query,
            )
        })
        .chain(archived.into_iter().filter_map(|thread| {
            index_session(
                thread,
                true,
                projects,
                workspaces,
                request.workspace_id.as_deref(),
                &request.query,
            )
        }))
        .collect::<Vec<_>>();
    sessions.sort_by_key(|session| (Reverse(session.updated_at), Reverse(session.id.clone())));
    let mut seen = HashSet::new();
    sessions.retain(|session| seen.insert(session.id.clone()));

    let active_count = sessions.iter().filter(|session| !session.archived).count();
    let archived_count = sessions.len().saturating_sub(active_count);
    let visible_sessions = sessions
        .iter()
        .filter(|session| match request.status {
            SessionStatus::All => true,
            SessionStatus::Active => !session.archived,
            SessionStatus::Archived => session.archived,
        })
        .collect::<Vec<_>>();
    let total = visible_sessions.len();
    let start = request.offset.min(total);
    let end = start.saturating_add(request.limit).min(total);
    let page = visible_sessions[start..end]
        .iter()
        .map(|session| session.value.clone())
        .collect::<Vec<_>>();
    let next_cursor = (end < total).then(|| end.to_string());

    let mut project_counts: HashMap<&str, (usize, usize, usize, i64)> = HashMap::new();
    for session in &sessions {
        let counts =
            project_counts
                .entry(&session.project_id)
                .or_insert((0, 0, 0, session.updated_at));
        if session.archived {
            counts.1 += 1;
        } else {
            counts.0 += 1;
        }
        if session.can_continue {
            counts.2 += 1;
        }
        counts.3 = counts.3.max(session.updated_at);
    }
    let projects = projects
        .projects()
        .iter()
        .filter(|project| {
            request
                .workspace_id
                .as_deref()
                .is_none_or(|project_id| project.id == project_id)
        })
        .map(|project| {
            let (active, archived, continuable, latest_updated_at) = project_counts
                .get(project.id.as_str())
                .copied()
                .unwrap_or_default();
            json!({
                "id": project.id,
                "name": project.name,
                "path": project.path,
                "total": active + archived,
                "active": active,
                "archived": archived,
                "continuable": continuable,
                "authorized": project.authorized,
                "latestUpdatedAt": latest_updated_at,
            })
        })
        .collect::<Vec<_>>();

    json!({
        "sessions": page,
        "projects": projects,
        "cursor": request.offset.to_string(),
        "nextCursor": next_cursor,
        "hasMore": next_cursor.is_some(),
        "loaded": end,
        "total": total,
        "active": active_count,
        "archived": archived_count,
        "status": request.status.as_str(),
        "query": request.query,
    })
}

fn index_session(
    thread: Value,
    archived: bool,
    projects: &CodexProjectCatalog,
    workspaces: &[AuthorizedWorkspace],
    project_filter: Option<&str>,
    query: &str,
) -> Option<IndexedSession> {
    let id = thread.get("id").and_then(Value::as_str)?.to_string();
    let cwd = thread.get("cwd").and_then(Value::as_str)?;
    let project = projects.project_for_thread(&id, cwd)?;
    if project_filter.is_some_and(|project_id| project_id != project.id) {
        return None;
    }
    let workspace = authorized_workspace_for_path(workspaces, cwd);
    let title = thread
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| thread.get("preview").and_then(Value::as_str))
        .unwrap_or("未命名会话");
    let preview = thread
        .get("preview")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !query.is_empty() {
        let needle = query.to_lowercase();
        let matches = [title, preview, &project.name, &project.path]
            .iter()
            .any(|value| value.to_lowercase().contains(&needle));
        if !matches {
            return None;
        }
    }
    let updated_at = thread
        .get("updatedAt")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let workspace_id = workspace.as_ref().map(|workspace| workspace.id.clone());
    let workspace_name = workspace
        .as_ref()
        .map(|workspace| workspace.name.clone())
        .unwrap_or_else(|| project.name.clone());
    let can_continue = workspace.is_some();
    let project_id = project.id.clone();
    let value = json!({
        "id": id,
        "title": title,
        "preview": preview,
        "cwd": cwd,
        "projectId": project.id,
        "projectName": project.name,
        "projectPath": project.path,
        "workspaceId": workspace_id,
        "workspaceName": workspace_name,
        "canViewHistory": true,
        "canContinue": can_continue,
        "archived": archived,
        "status": thread.pointer("/status/type").cloned().unwrap_or(Value::Null),
        "modelProvider": thread.get("modelProvider").cloned().unwrap_or(Value::Null),
        "source": thread.get("source").cloned().unwrap_or(Value::Null),
        "cliVersion": thread.get("cliVersion").cloned().unwrap_or(Value::Null),
        "createdAt": thread.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": updated_at,
    });
    Some(IndexedSession {
        id,
        project_id,
        can_continue,
        archived,
        updated_at,
        value,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(id: &str, name: &str, path: &std::path::Path) -> AuthorizedWorkspace {
        AuthorizedWorkspace {
            id: id.into(),
            name: name.into(),
            path: std::fs::canonicalize(path)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            allow_write: false,
            allow_commands: false,
            allow_uploads: false,
        }
    }

    fn thread(id: &str, title: &str, cwd: &str, updated_at: i64) -> Value {
        json!({
            "id": id,
            "name": title,
            "preview": title,
            "cwd": cwd,
            "status": {"type": "idle"},
            "modelProvider": "openai",
            "createdAt": updated_at - 10,
            "updatedAt": updated_at
        })
    }

    #[test]
    fn lists_formal_unauthorized_projects_as_view_only_and_paginates() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let outsider = tempfile::tempdir().unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let workspaces = vec![
            workspace("one", "项目一", first.path()),
            workspace("two", "项目二", second.path()),
        ];
        let projects = CodexProjectCatalog::from_project_paths(
            &[
                first.path().to_path_buf(),
                second.path().to_path_buf(),
                outsider.path().to_path_buf(),
            ],
            &workspaces,
        );
        let active = vec![
            thread("one-new", "新任务", &workspaces[0].path, 30),
            thread("two", "第二项目任务", &workspaces[1].path, 20),
            thread(
                "outside",
                "未授权任务",
                std::fs::canonicalize(outsider.path())
                    .unwrap()
                    .to_str()
                    .unwrap(),
                40,
            ),
            thread(
                "temporary",
                "临时任务",
                std::fs::canonicalize(temporary.path())
                    .unwrap()
                    .to_str()
                    .unwrap(),
                50,
            ),
        ];
        let archived = vec![thread("one-old", "归档任务", &workspaces[0].path, 10)];
        let request = SessionListRequest {
            offset: 0,
            limit: 2,
            status: SessionStatus::All,
            workspace_id: None,
            query: String::new(),
        };

        let payload =
            build_session_list_payload(active, archived, &projects, &workspaces, &request);
        assert_eq!(payload["total"], 4);
        assert_eq!(payload["active"], 3);
        assert_eq!(payload["archived"], 1);
        assert_eq!(payload["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(payload["nextCursor"], "2");
        assert_eq!(payload["sessions"][0]["id"], "outside");
        assert_eq!(payload["sessions"][0]["canContinue"], false);
        assert_eq!(payload["projects"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn search_matches_codex_project_name_without_leaking_other_projects() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("API检测模块");
        let second = root.path().join("其他项目");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let workspaces = vec![
            workspace("one", "API检测模块", &first),
            workspace("two", "其他项目", &second),
        ];
        let projects =
            CodexProjectCatalog::from_project_paths(&[first.clone(), second.clone()], &workspaces);
        let active = vec![
            thread("one", "普通任务", &workspaces[0].path, 30),
            thread("two", "普通任务", &workspaces[1].path, 20),
        ];
        let request = SessionListRequest {
            offset: 0,
            limit: 40,
            status: SessionStatus::Active,
            workspace_id: None,
            query: "API检测".into(),
        };

        let payload =
            build_session_list_payload(active, Vec::new(), &projects, &workspaces, &request);
        assert_eq!(payload["total"], 1);
        assert_eq!(payload["sessions"][0]["workspaceId"], "one");
        assert_eq!(payload["projects"][0]["total"], 1);
    }
}
