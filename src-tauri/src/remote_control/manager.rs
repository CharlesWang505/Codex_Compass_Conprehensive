use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::AppHandle;
use tokio::sync::{Mutex, RwLock, watch};

use super::codex_adapter::{CodexProject, CodexProjectCatalog};
use super::crypto::ReplayGuard;
use super::lan_pairing::{
    LanPairingInvitation, LanPairingManager, LanPairingRuntimeTask, LanPairingSnapshot,
};
use super::monitor::{RemoteMonitor, RemoteMonitorSnapshot};
use super::relay_client::{self, CommandCache, RuntimeStatus};
use super::settings::{PublicSettings, RemoteSettings, SettingsStore};
use super::workspace::{AuthorizedWorkspace, WorkspaceImportResult, WorkspaceStore};

#[derive(Clone)]
pub struct RemoteControlManager {
    root: PathBuf,
    status: Arc<RwLock<RuntimeStatus>>,
    replay: Arc<Mutex<HashMap<String, ReplayGuard>>>,
    commands: Arc<Mutex<HashMap<String, CommandCache>>>,
    task: Arc<Mutex<Option<RemoteRuntimeTask>>>,
    lan_task: Arc<Mutex<Option<LanPairingRuntimeTask>>>,
    lan_pairing: LanPairingManager,
    monitor: RemoteMonitor,
}

struct RemoteRuntimeTask {
    stop: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlSnapshot {
    pub settings: PublicSettings,
    pub workspaces: Vec<AuthorizedWorkspace>,
    pub connection: String,
    pub codex_version: Option<String>,
    pub auth_type: Option<String>,
    pub last_connected_at: Option<u64>,
    pub last_mobile_at: Option<u64>,
    pub last_error: Option<String>,
    pub active_sessions: usize,
    pub lan_pairing: LanPairingSnapshot,
}

impl RemoteControlManager {
    pub fn new(root: PathBuf, app: AppHandle) -> Self {
        Self {
            root,
            status: Arc::new(RwLock::new(RuntimeStatus {
                connection: "disabled".into(),
                ..RuntimeStatus::default()
            })),
            replay: Arc::new(Mutex::new(HashMap::new())),
            commands: Arc::new(Mutex::new(HashMap::new())),
            task: Arc::new(Mutex::new(None)),
            lan_task: Arc::new(Mutex::new(None)),
            lan_pairing: LanPairingManager::new(),
            monitor: RemoteMonitor::new(app),
        }
    }

    pub async fn monitor_snapshot(&self) -> RemoteMonitorSnapshot {
        self.monitor.snapshot().await
    }

    fn settings_store(&self) -> SettingsStore {
        SettingsStore::new(self.root.clone())
    }
    fn workspace_store(&self) -> WorkspaceStore {
        WorkspaceStore::new(self.root.clone())
    }

    pub async fn snapshot(&self) -> Result<RemoteControlSnapshot, String> {
        let settings = self.settings_store().load_or_create()?;
        let workspaces = self.workspace_store().load()?;
        let status = self.status.read().await.clone();
        let lan_pairing = self.lan_pairing.snapshot().await;
        Ok(RemoteControlSnapshot {
            settings: PublicSettings::from(&settings),
            workspaces,
            connection: status.connection,
            codex_version: status.codex_version,
            auth_type: status.auth_type,
            last_connected_at: status.last_connected_at,
            last_mobile_at: status.last_mobile_at,
            last_error: status.last_error,
            active_sessions: status.active_sessions,
            lan_pairing,
        })
    }

    pub async fn save_settings(
        &self,
        public: PublicSettings,
    ) -> Result<RemoteControlSnapshot, String> {
        let current = self.settings_store().load_or_create()?;
        let settings = public.merge_sensitive(&current);
        self.settings_store().save(&settings)?;
        self.restart().await?;
        self.snapshot().await
    }

    pub async fn start_if_enabled(&self) -> Result<(), String> {
        let settings = self.settings_store().load_or_create()?;
        if settings.enabled {
            self.restart().await?;
        }
        Ok(())
    }

    pub async fn restart(&self) -> Result<(), String> {
        self.stop().await;
        let settings = self.settings_store().load_or_create()?;
        if !settings.enabled {
            self.status.write().await.connection = "disabled".into();
            return Ok(());
        }
        if settings.lan_pairing_enabled && !settings.paused {
            match super::lan_pairing::start_server(
                settings.lan_pairing_port,
                settings.lan_allow_tailscale,
                self.lan_pairing.clone(),
                &settings,
            )
            .await
            {
                Ok((task, _)) => {
                    *self.lan_task.lock().await = Some(task);
                }
                Err(error) => {
                    self.lan_pairing.set_runtime_error(error).await;
                }
            }
        }
        let workspaces = self.workspace_store().load()?;
        let manager = self.clone();
        let (stop, mut stop_rx) = watch::channel(false);
        let task = tokio::spawn(async move {
            loop {
                let result = relay_client::run(
                    settings.clone(),
                    workspaces.clone(),
                    manager.status.clone(),
                    manager.replay.clone(),
                    manager.commands.clone(),
                    manager.monitor.clone(),
                    stop_rx.clone(),
                )
                .await;
                if let Err(error) = result {
                    let mut status = manager.status.write().await;
                    status.connection = "disconnected".into();
                    status.last_error = Some(error);
                }
                if !settings.auto_reconnect || *stop_rx.borrow() {
                    break;
                }
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {}
                    changed = stop_rx.changed() => {
                        if changed.is_err() || *stop_rx.borrow() { break; }
                    }
                }
            }
        });
        *self.task.lock().await = Some(RemoteRuntimeTask { stop, handle: task });
        Ok(())
    }

    pub async fn stop(&self) {
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.stop.send(true);
            let mut handle = task.handle;
            if tokio::time::timeout(std::time::Duration::from_secs(5), &mut handle)
                .await
                .is_err()
            {
                handle.abort();
                let _ = handle.await;
            }
        }
        if let Some(task) = self.lan_task.lock().await.take() {
            super::lan_pairing::stop_runtime_task(task).await;
        }
        self.lan_pairing.stop_runtime().await;
        self.status.write().await.connection = "disabled".into();
        self.monitor.disconnected().await;
    }

    pub async fn set_paused(&self, paused: bool) -> Result<RemoteControlSnapshot, String> {
        let mut settings = self.settings_store().load_or_create()?;
        settings.paused = paused;
        self.settings_store().save(&settings)?;
        self.restart().await?;
        self.snapshot().await
    }

    pub fn private_settings(&self) -> Result<RemoteSettings, String> {
        self.settings_store().load_or_create()
    }

    pub async fn create_lan_pairing(&self) -> Result<LanPairingInvitation, String> {
        self.lan_pairing.create_invitation().await
    }

    pub async fn cancel_lan_pairing(&self) {
        self.lan_pairing.cancel_invitation().await;
    }

    pub async fn approve_lan_pairing(&self, request_id: &str) -> Result<(), String> {
        self.lan_pairing.approve(request_id).await
    }

    pub async fn reject_lan_pairing(&self, request_id: &str) -> Result<(), String> {
        self.lan_pairing.reject(request_id).await
    }

    pub fn add_workspace(
        &self,
        name: String,
        path: String,
        allow_write: bool,
        allow_commands: bool,
        allow_uploads: bool,
    ) -> Result<Vec<AuthorizedWorkspace>, String> {
        self.workspace_store()
            .add(name, path, allow_write, allow_commands, allow_uploads)
    }

    pub fn remove_workspace(&self, id: &str) -> Result<Vec<AuthorizedWorkspace>, String> {
        self.workspace_store().remove(id)
    }

    pub fn update_workspace_permissions(
        &self,
        id: &str,
        allow_write: bool,
        allow_commands: bool,
        allow_uploads: bool,
    ) -> Result<Vec<AuthorizedWorkspace>, String> {
        self.workspace_store()
            .update_permissions(id, allow_write, allow_commands, allow_uploads)
    }

    pub fn update_all_workspace_permissions(
        &self,
        allow_write: Option<bool>,
        allow_commands: Option<bool>,
        allow_uploads: Option<bool>,
    ) -> Result<Vec<AuthorizedWorkspace>, String> {
        self.workspace_store()
            .update_all_permissions(allow_write, allow_commands, allow_uploads)
    }

    pub fn discover_codex_projects(&self) -> Result<Vec<CodexProject>, String> {
        let workspaces = self.workspace_store().load()?;
        Ok(CodexProjectCatalog::load(&workspaces)?.projects())
    }

    pub fn import_codex_projects(&self) -> Result<WorkspaceImportResult, String> {
        let workspaces = self.workspace_store().load()?;
        let projects = CodexProjectCatalog::load(&workspaces)?.projects();
        self.workspace_store().import_codex_projects(&projects)
    }
}
