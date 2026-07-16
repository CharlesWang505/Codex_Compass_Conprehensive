use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::super::workspace::AuthorizedWorkspace;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProject {
    pub id: String,
    pub name: String,
    pub path: String,
    pub authorized: bool,
}

#[derive(Debug, Clone, Default)]
pub struct CodexProjectCatalog {
    projects: Vec<CatalogProject>,
    thread_hints: HashMap<String, String>,
}

#[derive(Debug, Clone)]
struct CatalogProject {
    public: CodexProject,
    path_key: String,
}

#[derive(Debug, Default, Deserialize)]
struct CodexGlobalState {
    #[serde(default, rename = "project-order")]
    project_order: Vec<String>,
    #[serde(default, rename = "electron-saved-workspace-roots")]
    saved_workspace_roots: Vec<String>,
    #[serde(default, rename = "thread-workspace-root-hints")]
    thread_workspace_root_hints: HashMap<String, String>,
}

impl CodexProjectCatalog {
    pub fn load(workspaces: &[AuthorizedWorkspace]) -> Result<Self, String> {
        let path = codex_home_dir().join(".codex-global-state.json");
        let state = if path.exists() {
            let bytes = fs::read(path).map_err(|_| "无法读取 Codex 项目列表".to_string())?;
            serde_json::from_slice::<CodexGlobalState>(&bytes)
                .map_err(|_| "Codex 项目列表格式无效".to_string())?
        } else {
            CodexGlobalState::default()
        };
        Ok(Self::from_state(state, workspaces))
    }

    fn from_state(state: CodexGlobalState, workspaces: &[AuthorizedWorkspace]) -> Self {
        let workspace_keys = workspaces
            .iter()
            .filter_map(|workspace| normalized_path_key(&workspace.path))
            .collect::<Vec<_>>();
        let source_paths = if state.project_order.is_empty() {
            state.saved_workspace_roots
        } else {
            state.project_order
        };
        let mut seen = HashSet::new();
        let mut projects = Vec::new();

        for path in source_paths {
            let Some((display_path, path_key)) = normalized_project_path(&path) else {
                continue;
            };
            if !seen.insert(path_key.clone()) {
                continue;
            }
            projects.push(CatalogProject {
                public: CodexProject {
                    id: project_id(&path_key),
                    name: project_name(&display_path),
                    path: display_path,
                    authorized: workspace_keys
                        .iter()
                        .any(|workspace_key| path_contains(&path_key, workspace_key)),
                },
                path_key,
            });
        }

        for workspace in workspaces {
            let Some(path_key) = normalized_path_key(&workspace.path) else {
                continue;
            };
            if projects
                .iter()
                .any(|project| path_contains(&project.path_key, &path_key))
            {
                continue;
            }
            if !seen.insert(path_key.clone()) {
                continue;
            }
            projects.push(CatalogProject {
                public: CodexProject {
                    id: project_id(&path_key),
                    name: workspace.name.clone(),
                    path: clean_display_path(&workspace.path),
                    authorized: true,
                },
                path_key,
            });
        }

        Self {
            projects,
            thread_hints: state.thread_workspace_root_hints,
        }
    }

    pub fn projects(&self) -> Vec<CodexProject> {
        self.projects
            .iter()
            .map(|project| project.public.clone())
            .collect()
    }

    pub fn project_for_thread(&self, thread_id: &str, cwd: &str) -> Option<CodexProject> {
        if let Some(hint) = self.thread_hints.get(thread_id)
            && let Some(project) = self.project_for_path(hint)
        {
            return Some(project);
        }
        self.project_for_path(cwd)
    }

    pub fn project_for_path(&self, path: &str) -> Option<CodexProject> {
        let candidate_key = normalized_path_key(path)?;
        self.projects
            .iter()
            .filter(|project| path_contains(&project.path_key, &candidate_key))
            .max_by_key(|project| project.path_key.len())
            .map(|project| project.public.clone())
    }

    #[cfg(test)]
    pub fn from_project_paths(paths: &[PathBuf], workspaces: &[AuthorizedWorkspace]) -> Self {
        Self::from_state(
            CodexGlobalState {
                project_order: paths
                    .iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect(),
                ..CodexGlobalState::default()
            },
            workspaces,
        )
    }
}

fn codex_home_dir() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| directories::BaseDirs::new().map(|dirs| dirs.home_dir().join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}

fn normalized_project_path(value: &str) -> Option<(String, String)> {
    let trimmed = value.trim();
    let path = Path::new(trimmed);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return None;
    }
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let display = clean_display_path(&resolved.to_string_lossy());
    let key = normalized_path_key(&display)?;
    Some((display, key))
}

pub fn normalized_path_key(value: &str) -> Option<String> {
    let trimmed = clean_display_path(value.trim());
    if trimmed.is_empty() || !Path::new(&trimmed).is_absolute() {
        return None;
    }
    let normalized = trimmed
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    (!normalized.is_empty()).then_some(normalized)
}

fn clean_display_path(value: &str) -> String {
    value
        .strip_prefix(r"\\?\UNC\")
        .map(|path| format!(r"\\{path}"))
        .or_else(|| value.strip_prefix(r"\\?\").map(str::to_string))
        .unwrap_or_else(|| value.to_string())
}

fn path_contains(root: &str, candidate: &str) -> bool {
    candidate == root
        || candidate
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('\\'))
}

fn project_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Codex 项目")
        .to_string()
}

fn project_id(path_key: &str) -> String {
    let digest = Sha256::digest(path_key.as_bytes());
    let suffix = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("codex-project-{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(path: &Path) -> AuthorizedWorkspace {
        AuthorizedWorkspace {
            id: "workspace".into(),
            name: "授权子目录".into(),
            path: fs::canonicalize(path)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            allow_write: false,
            allow_commands: false,
            allow_uploads: false,
        }
    }

    #[test]
    fn project_order_controls_visible_projects_and_thread_hints() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("正式项目");
        let child = project.join("packages").join("app");
        fs::create_dir_all(&child).unwrap();
        let state = CodexGlobalState {
            project_order: vec![project.to_string_lossy().into_owned()],
            thread_workspace_root_hints: HashMap::from([(
                "thread-1".into(),
                project.to_string_lossy().into_owned(),
            )]),
            ..CodexGlobalState::default()
        };
        let catalog = CodexProjectCatalog::from_state(state, &[]);

        assert_eq!(catalog.projects().len(), 1);
        assert_eq!(
            catalog
                .project_for_thread("thread-1", child.to_str().unwrap())
                .unwrap()
                .name,
            "正式项目"
        );
    }

    #[test]
    fn authorized_child_marks_parent_project_authorized() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("项目");
        let child = project.join("child");
        fs::create_dir_all(&child).unwrap();
        let state = CodexGlobalState {
            project_order: vec![project.to_string_lossy().into_owned()],
            ..CodexGlobalState::default()
        };
        let catalog = CodexProjectCatalog::from_state(state, &[workspace(&child)]);

        assert!(catalog.projects()[0].authorized);
        assert_eq!(
            catalog
                .project_for_path(child.to_str().unwrap())
                .unwrap()
                .name,
            "项目"
        );
    }
}
