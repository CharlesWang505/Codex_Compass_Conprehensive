use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::codex_adapter::CodexProject;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedWorkspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub allow_write: bool,
    pub allow_commands: bool,
    #[serde(default)]
    pub allow_uploads: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportResult {
    pub workspaces: Vec<AuthorizedWorkspace>,
    pub discovered: usize,
    pub imported: usize,
    pub skipped: usize,
}

pub struct WorkspaceStore {
    root: PathBuf,
}

impl WorkspaceStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn path(&self) -> PathBuf {
        self.root.join("workspaces.json")
    }

    pub fn load(&self) -> Result<Vec<AuthorizedWorkspace>, String> {
        let path = self.path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        let bytes = fs::read(path).map_err(|_| "无法读取远控工作区".to_string())?;
        serde_json::from_slice(&bytes).map_err(|_| "远控工作区设置格式无效".to_string())
    }

    pub fn save(&self, workspaces: &[AuthorizedWorkspace]) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|_| "无法创建远控数据目录".to_string())?;
        let path = self.path();
        let temporary = self.root.join("workspaces.json.tmp");
        let bytes = serde_json::to_vec_pretty(workspaces)
            .map_err(|_| "无法序列化远控工作区".to_string())?;
        fs::write(&temporary, bytes).map_err(|_| "无法写入远控工作区".to_string())?;
        if path.exists() {
            fs::remove_file(&path).map_err(|_| "无法替换远控工作区".to_string())?;
        }
        fs::rename(temporary, path).map_err(|_| "无法完成远控工作区写入".to_string())
    }

    pub fn add(
        &self,
        name: String,
        path: String,
        allow_write: bool,
        allow_commands: bool,
        allow_uploads: bool,
    ) -> Result<Vec<AuthorizedWorkspace>, String> {
        let canonical = validate_workspace_path(Path::new(path.trim()))?;
        let mut workspaces = self.load()?;
        if workspaces
            .iter()
            .any(|item| Path::new(&item.path) == canonical)
        {
            return Err("该工作区已经授权".to_string());
        }
        workspaces.push(AuthorizedWorkspace {
            id: uuid::Uuid::new_v4().to_string(),
            name: if name.trim().is_empty() {
                canonical
                    .file_name()
                    .and_then(|item| item.to_str())
                    .unwrap_or("工作区")
                    .to_string()
            } else {
                name.trim().to_string()
            },
            path: canonical.to_string_lossy().into_owned(),
            allow_write,
            allow_commands,
            allow_uploads,
        });
        self.save(&workspaces)?;
        Ok(workspaces)
    }

    pub fn remove(&self, id: &str) -> Result<Vec<AuthorizedWorkspace>, String> {
        let mut workspaces = self.load()?;
        workspaces.retain(|item| item.id != id);
        self.save(&workspaces)?;
        Ok(workspaces)
    }

    pub fn update_permissions(
        &self,
        id: &str,
        allow_write: bool,
        allow_commands: bool,
        allow_uploads: bool,
    ) -> Result<Vec<AuthorizedWorkspace>, String> {
        let mut workspaces = self.load()?;
        let workspace = workspaces
            .iter_mut()
            .find(|workspace| workspace.id == id)
            .ok_or_else(|| "工作区不存在或已被撤销".to_string())?;
        workspace.allow_write = allow_write;
        workspace.allow_commands = allow_commands;
        workspace.allow_uploads = allow_uploads;
        self.save(&workspaces)?;
        Ok(workspaces)
    }

    pub fn update_all_permissions(
        &self,
        allow_write: Option<bool>,
        allow_commands: Option<bool>,
        allow_uploads: Option<bool>,
    ) -> Result<Vec<AuthorizedWorkspace>, String> {
        if allow_write.is_none() && allow_commands.is_none() && allow_uploads.is_none() {
            return Err("没有需要更新的工作区权限".to_string());
        }
        let mut workspaces = self.load()?;
        for workspace in &mut workspaces {
            if let Some(value) = allow_write {
                workspace.allow_write = value;
            }
            if let Some(value) = allow_commands {
                workspace.allow_commands = value;
            }
            if let Some(value) = allow_uploads {
                workspace.allow_uploads = value;
            }
        }
        self.save(&workspaces)?;
        Ok(workspaces)
    }

    pub fn import_codex_projects(
        &self,
        projects: &[CodexProject],
    ) -> Result<WorkspaceImportResult, String> {
        let mut workspaces = self.load()?;
        let mut imported = 0;
        let mut skipped = 0;

        for project in projects {
            let canonical = match validate_workspace_path(Path::new(&project.path)) {
                Ok(path) => path,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            let duplicate = workspaces.iter().any(|workspace| {
                fs::canonicalize(&workspace.path)
                    .ok()
                    .as_ref()
                    .is_some_and(|existing| existing == &canonical)
            });
            if duplicate {
                skipped += 1;
                continue;
            }
            workspaces.push(AuthorizedWorkspace {
                id: uuid::Uuid::new_v4().to_string(),
                name: project.name.clone(),
                path: canonical.to_string_lossy().into_owned(),
                allow_write: false,
                allow_commands: false,
                allow_uploads: false,
            });
            imported += 1;
        }

        if imported > 0 {
            self.save(&workspaces)?;
        }
        Ok(WorkspaceImportResult {
            workspaces,
            discovered: projects.len(),
            imported,
            skipped,
        })
    }
}

pub fn validate_workspace_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("工作区必须是不存在路径穿越的绝对路径".to_string());
    }
    let canonical = fs::canonicalize(path).map_err(|_| "工作区不存在或无法访问".to_string())?;
    if canonical.parent().is_none() {
        return Err("不能授权磁盘根目录".to_string());
    }
    if let Some(home) = directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf()) {
        if canonical == fs::canonicalize(home).unwrap_or_default() {
            return Err("不能直接授权整个用户主目录".to_string());
        }
    }
    Ok(canonical)
}

pub fn authorized_workspace_for_path(
    workspaces: &[AuthorizedWorkspace],
    candidate: &str,
) -> Option<AuthorizedWorkspace> {
    let canonical = fs::canonicalize(candidate).ok()?;
    workspaces
        .iter()
        .filter_map(|workspace| {
            let root = fs::canonicalize(&workspace.path).ok()?;
            canonical
                .starts_with(&root)
                .then_some((root.components().count(), workspace))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, workspace)| workspace)
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_and_parent_paths() {
        assert!(validate_workspace_path(Path::new("relative")).is_err());
        assert!(validate_workspace_path(Path::new("C:\\work\\..\\Windows")).is_err());
    }

    #[test]
    fn canonical_workspace_matches_root_and_descendants_only() {
        let root = tempfile::tempdir().unwrap();
        let child = root.path().join("packages").join("app");
        let sibling = tempfile::tempdir().unwrap();
        fs::create_dir_all(&child).unwrap();
        let canonical = fs::canonicalize(root.path()).unwrap();
        let workspace = AuthorizedWorkspace {
            id: "one".into(),
            name: "test".into(),
            path: canonical.to_string_lossy().into_owned(),
            allow_write: false,
            allow_commands: false,
            allow_uploads: false,
        };
        assert!(
            authorized_workspace_for_path(
                std::slice::from_ref(&workspace),
                canonical.to_str().unwrap()
            )
            .is_some()
        );
        assert!(
            authorized_workspace_for_path(
                std::slice::from_ref(&workspace),
                child.to_str().unwrap()
            )
            .is_some()
        );
        assert!(
            authorized_workspace_for_path(&[workspace], sibling.path().to_str().unwrap()).is_none()
        );
    }

    #[test]
    fn legacy_workspace_defaults_upload_permission_to_false() {
        let value = serde_json::json!({
            "id": "legacy",
            "name": "legacy",
            "path": "C:\\legacy",
            "allowWrite": true,
            "allowCommands": true
        });
        let workspace: AuthorizedWorkspace = serde_json::from_value(value).unwrap();
        assert!(!workspace.allow_uploads);
    }

    #[test]
    fn imports_codex_projects_with_conservative_permissions() {
        let store_root = tempfile::tempdir().unwrap();
        let project_root = tempfile::tempdir().unwrap();
        let project = CodexProject {
            id: "project".into(),
            name: "Codex 项目".into(),
            path: project_root.path().to_string_lossy().into_owned(),
            authorized: false,
        };
        let store = WorkspaceStore::new(store_root.path().to_path_buf());

        let result = store.import_codex_projects(&[project]).unwrap();

        assert_eq!(result.imported, 1);
        assert_eq!(result.workspaces.len(), 1);
        assert!(!result.workspaces[0].allow_write);
        assert!(!result.workspaces[0].allow_commands);
        assert!(!result.workspaces[0].allow_uploads);
    }

    #[test]
    fn bulk_permission_update_preserves_unspecified_permissions() {
        let store_root = tempfile::tempdir().unwrap();
        let first_root = tempfile::tempdir().unwrap();
        let second_root = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(store_root.path().to_path_buf());
        store
            .add(
                "first".into(),
                first_root.path().to_string_lossy().into_owned(),
                false,
                false,
                false,
            )
            .unwrap();
        store
            .add(
                "second".into(),
                second_root.path().to_string_lossy().into_owned(),
                false,
                true,
                false,
            )
            .unwrap();

        let updated = store
            .update_all_permissions(Some(true), None, Some(true))
            .unwrap();

        assert!(updated.iter().all(|workspace| workspace.allow_write));
        assert!(updated.iter().all(|workspace| workspace.allow_uploads));
        assert!(!updated[0].allow_commands);
        assert!(updated[1].allow_commands);
        assert!(store.update_all_permissions(None, None, None).is_err());
    }
}
