use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use codex_plus_core::model_health::{
    MODEL_HEALTH_INTERVAL, MODEL_HEALTH_MAX_CONCURRENCY, ModelHealthAvailability,
    ModelHealthTransition, ProbeTargetStatus, resolve_probe_target, transition_for,
};
use codex_plus_core::relay_config::{
    relay_profile_api_key, relay_profile_base_url, test_relay_profile,
};
use codex_plus_core::settings::{BackendSettings, RelayProfile, SettingsStore};
use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Mutex, Notify, OwnedMutexGuard, RwLock};

pub const MODEL_HEALTH_UPDATED_EVENT: &str = "model-health-check:updated";
pub const MODEL_HEALTH_FAILED_EVENT: &str = "model-health-check:failed";
pub const MODEL_HEALTH_RECOVERED_EVENT: &str = "model-health-check:recovered";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelHealthResult {
    pub relay_id: String,
    pub relay_name: String,
    pub model: String,
    pub status: ModelHealthAvailability,
    pub detail: String,
    pub checked_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelHealthSnapshot {
    pub enabled: bool,
    pub checking: bool,
    pub paused: bool,
    pub last_checked_at: Option<u64>,
    pub available_count: usize,
    pub unavailable_count: usize,
    pub skipped_count: usize,
    pub results: Vec<ModelHealthResult>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelHealthNotification {
    pub tone: String,
    pub text: String,
}

#[derive(Debug, Clone)]
struct ModelHealthChange {
    relay_name: String,
    model: String,
    transition: ModelHealthTransition,
}

#[derive(Default)]
struct ModelHealthRuntimeState {
    checking: bool,
    last_checked_at: Option<u64>,
    results: Vec<ModelHealthResult>,
    previous: HashMap<String, ModelHealthAvailability>,
    error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModelHealthSchedulerAction {
    WaitForWake,
    RunThenDelay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModelHealthNotificationPolicy {
    TrackAndNotify,
    Clear,
    Preserve,
}

#[derive(Clone)]
pub struct ModelHealthManager {
    app: AppHandle,
    state: Arc<RwLock<ModelHealthRuntimeState>>,
    run_lock: Arc<Mutex<()>>,
    commit_lock: Arc<Mutex<()>>,
    wake: Arc<Notify>,
    settings_revision: Arc<AtomicU64>,
}

impl ModelHealthManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            state: Arc::new(RwLock::new(ModelHealthRuntimeState::default())),
            run_lock: Arc::new(Mutex::new(())),
            commit_lock: Arc::new(Mutex::new(())),
            wake: Arc::new(Notify::new()),
            settings_revision: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn start(&self) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager.run_scheduler().await;
        });
    }

    async fn run_scheduler(self) {
        loop {
            let settings = SettingsStore::default().load();
            let action = scheduler_action(settings.as_ref().ok());
            if action == ModelHealthSchedulerAction::RunThenDelay {
                let _ = self.run_automatic_now().await;
            }
            wait_for_scheduler_window(action, &self.wake, MODEL_HEALTH_INTERVAL).await;
        }
    }

    async fn run_automatic_now(&self) -> Result<ModelHealthSnapshot, String> {
        self.run_now_with_mode(true).await
    }

    pub async fn snapshot(&self) -> Result<ModelHealthSnapshot, String> {
        let settings = SettingsStore::default().load();
        let state = self.state.read().await;
        let (enabled, paused, settings_error) = match settings {
            Ok(settings) => (
                settings.model_health_check_enabled,
                settings.model_health_check_enabled && !settings.relay_profiles_enabled,
                None,
            ),
            Err(error) => (false, false, Some(format!("读取模型自检设置失败：{error}"))),
        };
        Ok(snapshot_from_results(
            enabled,
            state.checking,
            paused,
            state.last_checked_at,
            state.results.clone(),
            visible_snapshot_error(settings_error, state.error.clone()),
        ))
    }

    pub async fn lock_configuration_changes(&self) -> OwnedMutexGuard<()> {
        self.commit_lock.clone().lock_owned().await
    }

    pub async fn invalidate_probe_configuration_locked(&self) {
        self.settings_revision.fetch_add(1, Ordering::AcqRel);
        {
            let mut state = self.state.write().await;
            state.checking = false;
            state.last_checked_at = None;
            state.results.clear();
            state.previous.clear();
            state.error = None;
        }
        if let Ok(snapshot) = self.snapshot().await {
            let _ = self.app.emit(MODEL_HEALTH_UPDATED_EVENT, &snapshot);
        }
        self.wake.notify_one();
    }

    pub async fn set_enabled(&self, enabled: bool) -> Result<ModelHealthSnapshot, String> {
        let _commit_guard = self.commit_lock.lock().await;
        SettingsStore::default()
            .update(json!({ "modelHealthCheckEnabled": enabled }))
            .map_err(|error| format!("保存模型自检开关失败：{error}"))?;
        self.settings_revision.fetch_add(1, Ordering::AcqRel);

        if !enabled {
            let mut state = self.state.write().await;
            state.checking = false;
            state.previous.clear();
            state.error = None;
        }
        self.wake.notify_one();
        let snapshot = self.snapshot().await?;
        let _ = self.app.emit(MODEL_HEALTH_UPDATED_EVENT, &snapshot);
        Ok(snapshot)
    }

    pub async fn run_now(&self) -> Result<ModelHealthSnapshot, String> {
        self.run_now_with_mode(false).await
    }

    async fn run_now_with_mode(
        &self,
        require_enabled: bool,
    ) -> Result<ModelHealthSnapshot, String> {
        let Ok(_run_guard) = self.run_lock.try_lock() else {
            return self.snapshot().await;
        };
        let round_revision = self.settings_revision.load(Ordering::Acquire);
        let settings = match SettingsStore::default().load() {
            Ok(settings) => settings,
            Err(error) => {
                let message = format!("读取模型自检设置失败：{error}");
                let mut state = self.state.write().await;
                state.checking = false;
                state.error = Some(message.clone());
                drop(state);
                let snapshot = self.snapshot().await.unwrap_or_else(|_| {
                    snapshot_from_results(false, false, false, None, Vec::new(), Some(message))
                });
                let _ = self.app.emit(MODEL_HEALTH_UPDATED_EVENT, &snapshot);
                return Ok(snapshot);
            }
        };

        if require_enabled && !should_run_automatic_probe(&settings) {
            return self.snapshot().await;
        }

        {
            let mut state = self.state.write().await;
            state.checking = true;
            state.error = None;
        }
        if let Ok(snapshot) = self.snapshot().await {
            let _ = self.app.emit(MODEL_HEALTH_UPDATED_EVENT, snapshot);
        }

        if !settings.relay_profiles_enabled {
            let mut state = self.state.write().await;
            state.checking = false;
            drop(state);
            let snapshot = self.snapshot().await?;
            let _ = self.app.emit(MODEL_HEALTH_UPDATED_EVENT, &snapshot);
            return Ok(snapshot);
        }

        let checked_at = unix_timestamp_ms();
        let round_configuration = probe_configuration_key(&settings);
        let relay_test_model = settings.relay_test_model;
        let relay_profiles = settings.relay_profiles;
        let state_keys = runtime_state_keys(&relay_profiles, &relay_test_model);
        let targets = relay_profiles
            .into_iter()
            .zip(state_keys)
            .enumerate()
            .map(|(index, (profile, state_key))| {
                let target = resolve_probe_target(&profile, &relay_test_model);
                (index, state_key, profile, target)
            })
            .collect::<Vec<_>>();

        let mut completed = stream::iter(targets)
            .map(|(index, state_key, profile, target)| async move {
                let result = if target.status == ProbeTargetStatus::Skipped {
                    ModelHealthResult {
                        relay_id: target.relay_id,
                        relay_name: target.relay_name,
                        model: target.model,
                        status: ModelHealthAvailability::Skipped,
                        detail: target.detail,
                        checked_at: Some(checked_at),
                    }
                } else {
                    match test_relay_profile(&profile, &target.model).await {
                        Ok(response) if response.http_status < 400 => ModelHealthResult {
                            relay_id: target.relay_id,
                            relay_name: target.relay_name,
                            model: target.model,
                            status: ModelHealthAvailability::Available,
                            detail: format!("HTTP {}", response.http_status),
                            checked_at: Some(checked_at),
                        },
                        Ok(response) => ModelHealthResult {
                            relay_id: target.relay_id,
                            relay_name: target.relay_name,
                            model: target.model,
                            status: ModelHealthAvailability::Unavailable,
                            detail: format!("HTTP {}", response.http_status),
                            checked_at: Some(checked_at),
                        },
                        Err(error) => ModelHealthResult {
                            relay_id: target.relay_id,
                            relay_name: target.relay_name,
                            model: target.model,
                            status: ModelHealthAvailability::Unavailable,
                            detail: safe_probe_error(&error.to_string()),
                            checked_at: Some(checked_at),
                        },
                    }
                };
                (index, state_key, result)
            })
            .buffer_unordered(MODEL_HEALTH_MAX_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;
        completed.sort_by_key(|(index, _, _)| *index);

        let _commit_guard = self.commit_lock.lock().await;
        let latest_settings = match SettingsStore::default().load() {
            Ok(settings) => settings,
            Err(error) => {
                let mut state = self.state.write().await;
                state.checking = false;
                state.error = Some(format!("读取模型自检设置失败：{error}"));
                drop(state);
                let snapshot = self.snapshot().await?;
                let _ = self.app.emit(MODEL_HEALTH_UPDATED_EVENT, &snapshot);
                return Ok(snapshot);
            }
        };
        let current_revision = self.settings_revision.load(Ordering::Acquire);
        if !should_commit_round(
            require_enabled,
            round_revision,
            current_revision,
            &round_configuration,
            &latest_settings,
        ) {
            let configuration_changed =
                probe_configuration_key(&latest_settings) != round_configuration;
            let mut state = self.state.write().await;
            state.checking = false;
            state.error = None;
            if !latest_settings.model_health_check_enabled {
                state.previous.clear();
            }
            if configuration_changed {
                state.last_checked_at = None;
                state.results.clear();
            }
            drop(state);
            let snapshot = self.snapshot().await?;
            let _ = self.app.emit(MODEL_HEALTH_UPDATED_EVENT, &snapshot);
            return Ok(snapshot);
        }

        let notification_policy = notification_state_policy(Some(&latest_settings));
        let previous = self.state.read().await.previous.clone();
        let mut changes = Vec::new();
        let mut next_previous = HashMap::new();
        let results = completed
            .into_iter()
            .map(|(_, state_key, result)| {
                if notification_policy == ModelHealthNotificationPolicy::TrackAndNotify {
                    if let Some(transition) =
                        transition_for(previous.get(&state_key).copied(), result.status)
                    {
                        changes.push(ModelHealthChange {
                            relay_name: result.relay_name.clone(),
                            model: result.model.clone(),
                            transition,
                        });
                    }
                    next_previous.insert(state_key, result.status);
                }
                result
            })
            .collect::<Vec<_>>();

        {
            let mut state = self.state.write().await;
            state.checking = false;
            state.last_checked_at = Some(checked_at);
            state.results = results;
            state.error = None;
            match notification_policy {
                ModelHealthNotificationPolicy::TrackAndNotify => {
                    state.previous = next_previous;
                }
                ModelHealthNotificationPolicy::Clear => {
                    state.previous.clear();
                }
                ModelHealthNotificationPolicy::Preserve => {}
            }
        }

        let snapshot = self.snapshot().await?;
        let _ = self.app.emit(MODEL_HEALTH_UPDATED_EVENT, &snapshot);
        if notification_policy == ModelHealthNotificationPolicy::TrackAndNotify
            && let Some(notification) = notification_message(&changes)
        {
            let event = if notification.tone == "error" {
                MODEL_HEALTH_FAILED_EVENT
            } else {
                MODEL_HEALTH_RECOVERED_EVENT
            };
            let _ = self.app.emit(event, notification);
        }
        Ok(snapshot)
    }
}

fn should_run_automatic_probe(settings: &BackendSettings) -> bool {
    settings.model_health_check_enabled && settings.relay_profiles_enabled
}

fn scheduler_action(settings: Option<&BackendSettings>) -> ModelHealthSchedulerAction {
    match settings {
        Some(settings) if !should_run_automatic_probe(settings) => {
            ModelHealthSchedulerAction::WaitForWake
        }
        Some(_) | None => ModelHealthSchedulerAction::RunThenDelay,
    }
}

async fn wait_for_scheduler_window(
    action: ModelHealthSchedulerAction,
    wake: &Notify,
    interval: std::time::Duration,
) {
    match action {
        ModelHealthSchedulerAction::WaitForWake => wake.notified().await,
        ModelHealthSchedulerAction::RunThenDelay => {
            tokio::select! {
                _ = tokio::time::sleep(interval) => {}
                _ = wake.notified() => {}
            }
        }
    }
}

fn notification_state_policy(settings: Option<&BackendSettings>) -> ModelHealthNotificationPolicy {
    match settings {
        Some(settings)
            if settings.model_health_check_enabled && settings.relay_profiles_enabled =>
        {
            ModelHealthNotificationPolicy::TrackAndNotify
        }
        Some(settings) if !settings.model_health_check_enabled => {
            ModelHealthNotificationPolicy::Clear
        }
        Some(_) => ModelHealthNotificationPolicy::Preserve,
        None => ModelHealthNotificationPolicy::Preserve,
    }
}

fn visible_snapshot_error(
    settings_load_error: Option<String>,
    runtime_error: Option<String>,
) -> Option<String> {
    settings_load_error.map(|fallback| runtime_error.unwrap_or(fallback))
}

#[tauri::command]
pub async fn get_model_health_status(
    manager: State<'_, ModelHealthManager>,
) -> Result<ModelHealthSnapshot, String> {
    manager.snapshot().await
}

#[tauri::command]
pub async fn run_model_health_check_now(
    manager: State<'_, ModelHealthManager>,
) -> Result<ModelHealthSnapshot, String> {
    manager.run_now().await
}

#[tauri::command]
pub async fn set_model_health_check_enabled(
    manager: State<'_, ModelHealthManager>,
    enabled: bool,
) -> Result<ModelHealthSnapshot, String> {
    manager.set_enabled(enabled).await
}

fn snapshot_from_results(
    enabled: bool,
    checking: bool,
    paused: bool,
    last_checked_at: Option<u64>,
    results: Vec<ModelHealthResult>,
    error: Option<String>,
) -> ModelHealthSnapshot {
    ModelHealthSnapshot {
        enabled,
        checking,
        paused,
        last_checked_at,
        available_count: results
            .iter()
            .filter(|result| result.status == ModelHealthAvailability::Available)
            .count(),
        unavailable_count: results
            .iter()
            .filter(|result| result.status == ModelHealthAvailability::Unavailable)
            .count(),
        skipped_count: results
            .iter()
            .filter(|result| result.status == ModelHealthAvailability::Skipped)
            .count(),
        results,
        error,
    }
}

fn notification_message(changes: &[ModelHealthChange]) -> Option<ModelHealthNotification> {
    let failed = changes
        .iter()
        .filter(|change| change.transition == ModelHealthTransition::Failed)
        .collect::<Vec<_>>();
    let recovered = changes
        .iter()
        .filter(|change| change.transition == ModelHealthTransition::Recovered)
        .collect::<Vec<_>>();

    if !failed.is_empty() {
        let mut text = format!(
            "模型自检发现 {} 个不可用：{}",
            failed.len(),
            format_change_names(&failed)
        );
        if !recovered.is_empty() {
            text.push_str(&format!("；另有 {} 个模型已恢复", recovered.len()));
        }
        return Some(ModelHealthNotification {
            tone: "error".to_string(),
            text,
        });
    }
    if !recovered.is_empty() {
        return Some(ModelHealthNotification {
            tone: "ok".to_string(),
            text: format!(
                "{} 个模型已恢复：{}",
                recovered.len(),
                format_change_names(&recovered)
            ),
        });
    }
    None
}

fn format_change_names(changes: &[&ModelHealthChange]) -> String {
    let mut names = changes
        .iter()
        .take(3)
        .map(|change| format!("{}（{}）", change.relay_name, change.model))
        .collect::<Vec<_>>();
    if changes.len() > names.len() {
        names.push(format!("等 {} 个", changes.len()));
    }
    names.join("、")
}

fn runtime_state_key(relay_id: &str, occurrence: usize) -> String {
    let relay_id = if relay_id.trim().is_empty() {
        "<empty>"
    } else {
        relay_id.trim()
    };
    format!("{relay_id}#{occurrence}")
}

fn runtime_state_keys(profiles: &[RelayProfile], global_test_model: &str) -> Vec<String> {
    let mut occurrences = HashMap::<String, usize>::new();
    profiles
        .iter()
        .map(|profile| {
            let target = resolve_probe_target(profile, global_test_model);
            let identity = relay_profile_identity(profile, &target.model);
            let occurrence = occurrences.entry(identity.clone()).or_default();
            let key = runtime_state_key(&identity, *occurrence);
            *occurrence += 1;
            key
        })
        .collect()
}

fn probe_configuration_key(settings: &BackendSettings) -> String {
    let mut identities = runtime_state_keys(&settings.relay_profiles, &settings.relay_test_model);
    identities.sort_unstable();
    let mut hasher = Sha256::new();
    hasher.update([u8::from(settings.relay_profiles_enabled)]);
    for identity in identities {
        hasher.update(identity.len().to_le_bytes());
        hasher.update(identity.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

pub fn probe_configuration_changed(current: &BackendSettings, next: &BackendSettings) -> bool {
    probe_configuration_key(current) != probe_configuration_key(next)
}

fn should_commit_round(
    require_enabled: bool,
    round_revision: u64,
    current_revision: u64,
    round_configuration: &str,
    latest_settings: &BackendSettings,
) -> bool {
    round_revision == current_revision
        && latest_settings.relay_profiles_enabled
        && (!require_enabled || latest_settings.model_health_check_enabled)
        && probe_configuration_key(latest_settings) == round_configuration
}

fn relay_profile_identity(profile: &RelayProfile, model: &str) -> String {
    let mut hasher = Sha256::new();
    let base_url = relay_profile_base_url(profile);
    let api_key = relay_profile_api_key(profile);
    let protocol = format!("{:?}", profile.protocol);
    let relay_mode = format!("{:?}", profile.relay_mode);
    for request_field in [
        base_url.trim(),
        api_key.trim(),
        protocol.as_str(),
        relay_mode.as_str(),
        model.trim(),
    ] {
        hasher.update(request_field.len().to_le_bytes());
        hasher.update(request_field.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn safe_probe_error(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("timeout") || lower.contains("timed out") {
        "请求超时".to_string()
    } else if lower.contains("connect")
        || lower.contains("connection")
        || lower.contains("dns")
        || lower.contains("refused")
    {
        "无法连接上游".to_string()
    } else if lower.contains("certificate") || lower.contains("tls") {
        "TLS 证书错误".to_string()
    } else {
        "请求失败".to_string()
    }
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_plus_core::model_health::{ModelHealthAvailability, ModelHealthTransition};

    fn result(
        relay_id: &str,
        relay_name: &str,
        status: ModelHealthAvailability,
    ) -> ModelHealthResult {
        ModelHealthResult {
            relay_id: relay_id.to_string(),
            relay_name: relay_name.to_string(),
            model: "gpt-test".to_string(),
            status,
            detail: "HTTP 200".to_string(),
            checked_at: Some(1_000),
        }
    }

    fn profile(id: &str, name: &str) -> RelayProfile {
        RelayProfile {
            id: id.to_string(),
            name: name.to_string(),
            base_url: format!("https://{name}.example/v1"),
            upstream_base_url: format!("https://{name}.example/v1"),
            api_key: format!("key-{name}"),
            ..RelayProfile::default()
        }
    }

    #[test]
    fn snapshot_counts_available_unavailable_and_skipped_results() {
        let snapshot = snapshot_from_results(
            true,
            false,
            false,
            Some(1_000),
            vec![
                result("a", "A", ModelHealthAvailability::Available),
                result("b", "B", ModelHealthAvailability::Unavailable),
                result("c", "C", ModelHealthAvailability::Skipped),
            ],
            None,
        );

        assert_eq!(snapshot.available_count, 1);
        assert_eq!(snapshot.unavailable_count, 1);
        assert_eq!(snapshot.skipped_count, 1);
        assert_eq!(snapshot.results.len(), 3);
    }

    #[test]
    fn failure_notification_takes_priority_and_includes_recovery_count() {
        let notification = notification_message(&[
            ModelHealthChange {
                relay_name: "A".to_string(),
                model: "gpt-a".to_string(),
                transition: ModelHealthTransition::Failed,
            },
            ModelHealthChange {
                relay_name: "B".to_string(),
                model: "gpt-b".to_string(),
                transition: ModelHealthTransition::Recovered,
            },
        ])
        .unwrap();

        assert_eq!(notification.tone, "error");
        assert!(notification.text.contains("A"));
        assert!(notification.text.contains("gpt-a"));
        assert!(notification.text.contains("另有 1 个模型已恢复"));
    }

    #[test]
    fn recovery_only_notification_is_successful() {
        let notification = notification_message(&[ModelHealthChange {
            relay_name: "A".to_string(),
            model: "gpt-a".to_string(),
            transition: ModelHealthTransition::Recovered,
        }])
        .unwrap();

        assert_eq!(notification.tone, "ok");
        assert!(notification.text.contains("已恢复"));
    }

    #[test]
    fn runtime_state_keys_are_stable_for_unique_ids_and_disambiguate_duplicates() {
        assert_eq!(runtime_state_key("relay-a", 0), "relay-a#0");
        assert_eq!(runtime_state_key("relay-a", 1), "relay-a#1");
        assert_eq!(runtime_state_key("", 0), "<empty>#0");
        assert_ne!(
            runtime_state_key("relay-a", 0),
            runtime_state_key("relay-a", 1)
        );
    }

    #[test]
    fn runtime_state_key_list_survives_unique_id_insertion_and_reordering() {
        let relay_a = profile("relay-a", "a");
        let relay_b = profile("relay-b", "b");
        let original = runtime_state_keys(&[relay_a.clone(), relay_b.clone()], "");
        let inserted = runtime_state_keys(
            &[
                profile("relay-new", "new"),
                relay_a.clone(),
                relay_b.clone(),
            ],
            "",
        );
        let reordered = runtime_state_keys(&[relay_b.clone(), relay_a.clone()], "");
        let duplicates = runtime_state_keys(&[relay_a.clone(), relay_a, profile("", "empty")], "");

        assert_eq!(&inserted[1..], &original);
        assert_eq!(reordered, vec![original[1].clone(), original[0].clone()]);
        assert_ne!(duplicates[0], duplicates[1]);
        assert_ne!(duplicates[0], duplicates[2]);
    }

    #[test]
    fn safe_probe_error_does_not_expose_urls_keys_or_response_text() {
        assert_eq!(
            safe_probe_error("error sending request for url (https://relay.example/v1?key=secret)"),
            "请求失败",
        );
        assert_eq!(safe_probe_error("operation timed out"), "请求超时");
        assert_eq!(safe_probe_error("connection refused"), "无法连接上游");
    }

    #[test]
    fn automatic_probe_is_cancelled_when_setting_is_disabled() {
        let enabled = BackendSettings {
            model_health_check_enabled: true,
            ..BackendSettings::default()
        };
        let disabled = BackendSettings {
            model_health_check_enabled: false,
            ..BackendSettings::default()
        };

        assert!(should_run_automatic_probe(&enabled));
        assert!(!should_run_automatic_probe(&disabled));
    }

    #[test]
    fn automatic_probe_is_paused_when_suppliers_are_disabled() {
        let settings = BackendSettings {
            model_health_check_enabled: true,
            relay_profiles_enabled: false,
            ..BackendSettings::default()
        };

        assert!(!should_run_automatic_probe(&settings));
    }

    #[test]
    fn scheduler_retries_after_settings_load_error() {
        let enabled = BackendSettings {
            model_health_check_enabled: true,
            ..BackendSettings::default()
        };
        let disabled = BackendSettings {
            model_health_check_enabled: false,
            ..BackendSettings::default()
        };

        assert_eq!(
            scheduler_action(Some(&enabled)),
            ModelHealthSchedulerAction::RunThenDelay
        );
        assert_eq!(
            scheduler_action(Some(&disabled)),
            ModelHealthSchedulerAction::WaitForWake
        );
        assert_eq!(
            scheduler_action(None),
            ModelHealthSchedulerAction::RunThenDelay
        );
    }

    #[test]
    fn duplicate_ids_keep_supplier_identity_after_reordering() {
        let first = RelayProfile {
            id: "duplicate".to_string(),
            name: "供应商 A".to_string(),
            upstream_base_url: "https://a.example/v1".to_string(),
            api_key: "key-a".to_string(),
            ..RelayProfile::default()
        };
        let second = RelayProfile {
            id: "duplicate".to_string(),
            name: "供应商 B".to_string(),
            upstream_base_url: "https://b.example/v1".to_string(),
            api_key: "key-b".to_string(),
            ..RelayProfile::default()
        };

        let original = runtime_state_keys(&[first.clone(), second.clone()], "");
        let reordered = runtime_state_keys(&[second, first], "");

        assert_eq!(original[0], reordered[1]);
        assert_eq!(original[1], reordered[0]);
        assert_ne!(original[0], original[1]);
        assert!(!original[0].contains("key-a"));
        assert!(!original[1].contains("key-b"));
    }

    #[test]
    fn completion_settings_error_preserves_notification_baseline() {
        let enabled = BackendSettings {
            model_health_check_enabled: true,
            ..BackendSettings::default()
        };
        let disabled = BackendSettings {
            model_health_check_enabled: false,
            ..BackendSettings::default()
        };

        assert_eq!(
            notification_state_policy(Some(&enabled)),
            ModelHealthNotificationPolicy::TrackAndNotify
        );
        assert_eq!(
            notification_state_policy(Some(&disabled)),
            ModelHealthNotificationPolicy::Clear
        );
        assert_eq!(
            notification_state_policy(None),
            ModelHealthNotificationPolicy::Preserve
        );
    }

    #[test]
    fn unrelated_profile_edits_do_not_reset_probe_identity() {
        let original = profile("relay-a", "a");
        let mut renamed = original.clone();
        renamed.id = "relay-a-renamed".to_string();
        renamed.name = "新显示名称".to_string();
        renamed.context_window = "400000".to_string();
        renamed.model_list = "other-model".to_string();
        renamed.vlm_base_url = "https://vlm.example/v1".to_string();

        let original_key = runtime_state_keys(&[original.clone()], "global-model");
        let renamed_key = runtime_state_keys(&[renamed], "global-model");
        assert_eq!(original_key, renamed_key);

        let mut changed_endpoint = original;
        changed_endpoint.upstream_base_url = "https://changed.example/v1".to_string();
        assert_ne!(
            original_key,
            runtime_state_keys(&[changed_endpoint], "global-model")
        );
    }

    #[test]
    fn recovered_settings_hide_stale_runtime_error() {
        assert_eq!(
            visible_snapshot_error(None, Some("旧的设置读取错误".to_string())),
            None
        );
        assert_eq!(
            visible_snapshot_error(
                Some("当前读取失败".to_string()),
                Some("上一轮读取失败".to_string())
            ),
            Some("上一轮读取失败".to_string())
        );
    }

    #[tokio::test]
    async fn disabled_scheduler_wait_is_released_by_notify() {
        let wake = Arc::new(Notify::new());
        let waiter = {
            let wake = wake.clone();
            tokio::spawn(async move {
                wait_for_scheduler_window(
                    ModelHealthSchedulerAction::WaitForWake,
                    &wake,
                    std::time::Duration::from_secs(60),
                )
                .await;
            })
        };

        tokio::task::yield_now().await;
        wake.notify_one();
        tokio::time::timeout(std::time::Duration::from_millis(250), waiter)
            .await
            .expect("Notify 应立即唤醒禁用状态的调度器")
            .expect("调度等待任务不应失败");
    }

    #[test]
    fn automatic_round_discards_results_after_toggle_or_probe_configuration_change() {
        let mut initial = BackendSettings {
            model_health_check_enabled: true,
            relay_profiles_enabled: true,
            ..BackendSettings::default()
        };
        initial.relay_profiles = vec![profile("relay-a", "a")];
        let initial_configuration = probe_configuration_key(&initial);

        assert!(should_commit_round(
            true,
            7,
            7,
            &initial_configuration,
            &initial,
        ));
        assert!(!should_commit_round(
            true,
            7,
            8,
            &initial_configuration,
            &initial,
        ));

        let mut disabled_profiles = initial.clone();
        disabled_profiles.relay_profiles_enabled = false;
        assert!(!should_commit_round(
            true,
            7,
            7,
            &initial_configuration,
            &disabled_profiles,
        ));

        let mut changed_endpoint = initial.clone();
        changed_endpoint.relay_profiles[0].base_url = "https://changed.example/v1".to_string();
        changed_endpoint.relay_profiles[0].upstream_base_url =
            "https://changed.example/v1".to_string();
        assert!(!should_commit_round(
            true,
            7,
            7,
            &initial_configuration,
            &changed_endpoint,
        ));
    }

    #[test]
    fn probe_configuration_change_ignores_display_only_edits() {
        let mut current = BackendSettings::default();
        current.relay_profiles = vec![profile("relay-a", "a")];
        let mut display_only = current.clone();
        display_only.relay_profiles[0].name = "重命名供应商".to_string();
        display_only.relay_profiles[0].context_window = "400000".to_string();

        assert!(!probe_configuration_changed(&current, &display_only));

        let mut changed_request = current.clone();
        changed_request.relay_profiles[0].test_model = "gpt-5.6".to_string();
        assert!(probe_configuration_changed(&current, &changed_request));
    }
}
