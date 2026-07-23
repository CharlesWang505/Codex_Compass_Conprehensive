use codex_plus_core::model_health::{
    MODEL_HEALTH_INTERVAL, MODEL_HEALTH_MAX_CONCURRENCY, ModelHealthAvailability,
    ModelHealthTransition, ProbeTargetStatus, resolve_probe_target, resolve_probe_targets,
    transition_for,
};
use codex_plus_core::settings::{
    BackendSettings, ModelChannelPreference, ModelRouteLock, ModelSelectionMode, RelayMode,
    RelayProfile, SettingsStore,
};
use std::time::Duration;

fn profile(test_model: &str, model: &str) -> RelayProfile {
    RelayProfile {
        id: "relay-a".to_string(),
        name: "Relay A".to_string(),
        model: model.to_string(),
        base_url: "https://relay.example/v1".to_string(),
        upstream_base_url: "https://relay.example/v1".to_string(),
        api_key: "sk-test".to_string(),
        relay_mode: RelayMode::PureApi,
        test_model: test_model.to_string(),
        ..RelayProfile::default()
    }
}

#[test]
fn model_health_check_is_disabled_by_default() {
    assert!(!BackendSettings::default().model_health_check_enabled);
}

#[test]
fn settings_without_model_health_flag_remain_compatible() {
    let settings: BackendSettings = serde_json::from_value(serde_json::json!({})).unwrap();

    assert!(!settings.model_health_check_enabled);
}

#[test]
fn settings_store_loads_legacy_file_and_update_persists_model_health_flag() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.json");
    std::fs::write(&path, "{}").unwrap();
    let store = SettingsStore::new(path);

    assert!(!store.load().unwrap().model_health_check_enabled);

    let enabled = store
        .update(serde_json::json!({ "modelHealthCheckEnabled": true }))
        .unwrap();
    assert!(enabled.model_health_check_enabled);
    assert!(store.load().unwrap().model_health_check_enabled);

    let disabled = store
        .update(serde_json::json!({ "modelHealthCheckEnabled": false }))
        .unwrap();
    assert!(!disabled.model_health_check_enabled);
}

#[test]
fn routing_switches_are_independent_and_disabled_by_default() {
    let settings = BackendSettings::default();

    assert!(!settings.model_health_check_enabled);
    assert!(!settings.model_cost_routing_enabled);
    assert!(!settings.model_auto_failover_enabled);
    assert!(!settings.model_timeout_failover_enabled);
}

#[test]
fn legacy_settings_create_empty_channel_preferences() {
    let settings: BackendSettings = serde_json::from_value(serde_json::json!({})).unwrap();

    assert!(settings.model_channel_preferences.is_empty());
    assert!(settings.model_route_locks.is_empty());
}

#[test]
fn model_channel_preferences_keep_legacy_nested_defaults() {
    let preference: ModelChannelPreference = serde_json::from_value(serde_json::json!({
        "sourceRef": "relay-a"
    }))
    .unwrap();

    assert!(preference.enabled);
    assert_eq!(preference.selection_mode, ModelSelectionMode::All);
    assert!(preference.selected_models.is_empty());
    assert_eq!(preference.manual_rate, None);
    assert_eq!(preference.manual_priority, 0);
}

#[test]
fn manual_rate_accepts_non_negative_values_and_normalizes_negative_zero() {
    let zero: ModelChannelPreference = serde_json::from_value(serde_json::json!({
        "sourceRef": "relay-a",
        "manualRate": -0.0
    }))
    .unwrap();
    let positive: ModelChannelPreference = serde_json::from_value(serde_json::json!({
        "sourceRef": "relay-a",
        "manualRate": 0.72
    }))
    .unwrap();

    assert_eq!(zero.manual_rate.unwrap().to_bits(), 0.0_f64.to_bits());
    assert_eq!(positive.manual_rate, Some(0.72));
    let serialized = serde_json::to_string(&zero).unwrap();
    assert!(serialized.contains(r#""manualRate":0.0"#));
    assert!(!serialized.contains("-0.0"));
}

#[test]
fn manual_rate_rejects_negative_and_non_finite_values() {
    let negative = serde_json::from_value::<ModelChannelPreference>(serde_json::json!({
        "sourceRef": "relay-a",
        "manualRate": -0.01
    }));
    assert!(negative.is_err());

    for manual_rate in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0] {
        let preference = ModelChannelPreference {
            source_ref: "relay-a".to_string(),
            enabled: true,
            selection_mode: ModelSelectionMode::All,
            selected_models: Vec::new(),
            manual_rate: Some(manual_rate),
            manual_priority: 0,
        };
        assert!(
            serde_json::to_value(preference).is_err(),
            "{manual_rate:?} must not serialize"
        );
    }
}

#[test]
fn settings_store_partial_update_persists_model_routing_configuration() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.json");
    std::fs::write(&path, "{}").unwrap();
    let store = SettingsStore::new(path.clone());

    let updated = store
        .update(serde_json::json!({
            "modelCostRoutingEnabled": true,
            "modelAutoFailoverEnabled": true,
            "modelTimeoutFailoverEnabled": true,
            "modelChannelPreferences": [{
                "sourceRef": "relay-a",
                "enabled": false,
                "selectionMode": "custom",
                "selectedModels": ["gpt-5.6-luna"],
                "manualRate": 0.72,
                "manualPriority": 3
            }],
            "modelRouteLocks": [{
                "canonicalModel": "gpt-5.6-luna",
                "sourceRef": "relay-a"
            }]
        }))
        .unwrap();

    assert!(updated.model_cost_routing_enabled);
    assert!(updated.model_auto_failover_enabled);
    assert!(updated.model_timeout_failover_enabled);
    assert_eq!(
        updated.model_channel_preferences,
        vec![ModelChannelPreference {
            source_ref: "relay-a".to_string(),
            enabled: false,
            selection_mode: ModelSelectionMode::Custom,
            selected_models: vec!["gpt-5.6-luna".to_string()],
            manual_rate: Some(0.72),
            manual_priority: 3,
        }]
    );
    assert_eq!(
        updated.model_route_locks,
        vec![ModelRouteLock {
            canonical_model: "gpt-5.6-luna".to_string(),
            source_ref: "relay-a".to_string(),
        }]
    );

    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(saved["modelCostRoutingEnabled"], serde_json::json!(true));
    assert_eq!(saved["modelAutoFailoverEnabled"], serde_json::json!(true));
    assert_eq!(
        saved["modelTimeoutFailoverEnabled"],
        serde_json::json!(true)
    );
    assert_eq!(
        saved["modelChannelPreferences"][0]["selectionMode"],
        serde_json::json!("custom")
    );
    assert_eq!(
        saved["modelRouteLocks"][0]["canonicalModel"],
        serde_json::json!("gpt-5.6-luna")
    );

    let auto_disabled = store
        .update(serde_json::json!({
            "modelAutoFailoverEnabled": false
        }))
        .unwrap();
    assert!(auto_disabled.model_cost_routing_enabled);
    assert!(!auto_disabled.model_auto_failover_enabled);
    assert!(auto_disabled.model_timeout_failover_enabled);
    assert_eq!(
        auto_disabled.model_channel_preferences,
        updated.model_channel_preferences
    );
    assert_eq!(auto_disabled.model_route_locks, updated.model_route_locks);
}

#[test]
fn settings_store_malformed_model_routing_arrays_preserve_previous_values() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.json");
    std::fs::write(&path, "{}").unwrap();
    let store = SettingsStore::new(path);

    let valid = store
        .update(serde_json::json!({
            "modelChannelPreferences": [{
                "sourceRef": "relay-a",
                "manualRate": 0.72
            }],
            "modelRouteLocks": [{
                "canonicalModel": "gpt-5.6-luna",
                "sourceRef": "relay-a"
            }]
        }))
        .unwrap();

    let after_malformed = store
        .update(serde_json::json!({
            "modelChannelPreferences": [{
                "sourceRef": "relay-b",
                "manualRate": -0.25
            }],
            "modelRouteLocks": [{
                "canonicalModel": "gpt-5.6-sol"
            }]
        }))
        .unwrap();

    assert_eq!(
        after_malformed.model_channel_preferences,
        valid.model_channel_preferences
    );
    assert_eq!(after_malformed.model_route_locks, valid.model_route_locks);
    let persisted = store.load().unwrap();
    assert_eq!(
        persisted.model_channel_preferences,
        valid.model_channel_preferences
    );
    assert_eq!(persisted.model_route_locks, valid.model_route_locks);
}

#[test]
fn model_health_interval_and_concurrency_are_fixed() {
    assert_eq!(MODEL_HEALTH_INTERVAL, Duration::from_secs(10 * 60));
    assert_eq!(MODEL_HEALTH_MAX_CONCURRENCY, 3);
}

#[test]
fn resolves_test_model_before_profile_and_global_model() {
    let target = resolve_probe_target(&profile("custom-test", "default-model"), "global-model");

    assert_eq!(target.model, "custom-test");
    assert_eq!(target.status, ProbeTargetStatus::Ready);
}

#[test]
fn falls_back_to_profile_model_then_global_model() {
    let profile_model = resolve_probe_target(&profile("", "default-model"), "global-model");
    let global_model = resolve_probe_target(&profile("", ""), "global-model");
    let config_model = resolve_probe_target(
        &RelayProfile {
            model: String::new(),
            config_contents: "model = \"config-model\"".to_string(),
            ..profile("", "")
        },
        "global-model",
    );

    assert_eq!(profile_model.model, "default-model");
    assert_eq!(global_model.model, "global-model");
    assert_eq!(config_model.model, "config-model");
}

#[test]
fn resolves_every_configured_model_as_an_independent_target() {
    let profile = RelayProfile {
        model: "gpt-default".to_string(),
        model_list: "gpt-a\ngpt-b\ngpt-a[1M], gpt-b".to_string(),
        test_model: "gpt-extra".to_string(),
        ..profile("", "")
    };

    let targets = resolve_probe_targets(&profile, "global-model");

    assert_eq!(
        targets
            .iter()
            .map(|target| target.model.as_str())
            .collect::<Vec<_>>(),
        vec!["gpt-a", "gpt-b", "gpt-default", "gpt-extra"],
    );
    assert!(
        targets
            .iter()
            .all(|target| target.status == ProbeTargetStatus::Ready)
    );
}

#[test]
fn global_test_model_is_used_only_when_supplier_has_no_models() {
    let targets = resolve_probe_targets(&profile("", ""), "global-model");

    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].model, "global-model");
    assert_eq!(targets[0].status, ProbeTargetStatus::Ready);
}

#[test]
fn invalid_supplier_configuration_skips_each_configured_model_separately() {
    let profile = RelayProfile {
        api_key: String::new(),
        model_list: "gpt-a\ngpt-b".to_string(),
        ..profile("", "")
    };

    let targets = resolve_probe_targets(&profile, "global-model");

    assert_eq!(targets.len(), 2);
    assert_eq!(targets[0].model, "gpt-a");
    assert_eq!(targets[1].model, "gpt-b");
    assert!(
        targets
            .iter()
            .all(|target| target.status == ProbeTargetStatus::Skipped)
    );
}

#[test]
fn skips_aggregate_and_official_account_only_profiles() {
    let aggregate = RelayProfile {
        relay_mode: RelayMode::Aggregate,
        ..profile("gpt-5", "gpt-5")
    };
    let official = RelayProfile {
        relay_mode: RelayMode::Official,
        official_mix_api_key: false,
        api_key: String::new(),
        ..profile("gpt-5", "gpt-5")
    };

    assert_eq!(
        resolve_probe_target(&aggregate, "gpt-5").status,
        ProbeTargetStatus::Skipped
    );
    assert_eq!(
        resolve_probe_target(&official, "gpt-5").status,
        ProbeTargetStatus::Skipped
    );
}

#[test]
fn skips_profiles_with_incomplete_api_configuration() {
    let missing_url = RelayProfile {
        upstream_base_url: String::new(),
        base_url: String::new(),
        ..profile("gpt-5", "gpt-5")
    };
    let placeholder_url = RelayProfile {
        upstream_base_url: "https://".to_string(),
        base_url: "https://".to_string(),
        ..profile("gpt-5", "gpt-5")
    };
    let missing_key = RelayProfile {
        api_key: String::new(),
        ..profile("gpt-5", "gpt-5")
    };
    let missing_model = profile("", "");

    assert_eq!(
        resolve_probe_target(&missing_url, "gpt-5").status,
        ProbeTargetStatus::Skipped
    );
    assert_eq!(
        resolve_probe_target(&placeholder_url, "gpt-5").status,
        ProbeTargetStatus::Skipped
    );
    assert_eq!(
        resolve_probe_target(&missing_key, "gpt-5").status,
        ProbeTargetStatus::Skipped
    );
    assert_eq!(
        resolve_probe_target(&missing_model, "").status,
        ProbeTargetStatus::Skipped
    );
}

#[test]
fn skips_base_urls_with_credentials_query_or_fragment() {
    for base_url in [
        "https://user:secret@relay.example/v1",
        "https://relay.example/v1?token=secret",
        "https://relay.example/v1#responses",
    ] {
        let profile = RelayProfile {
            base_url: base_url.to_string(),
            upstream_base_url: base_url.to_string(),
            ..profile("gpt-5", "gpt-5")
        };

        assert_eq!(
            resolve_probe_target(&profile, "gpt-5").status,
            ProbeTargetStatus::Skipped,
            "{base_url} should not be probed",
        );
    }
}

#[test]
fn first_failure_notifies_but_first_success_does_not() {
    assert_eq!(
        transition_for(None, ModelHealthAvailability::Unavailable),
        Some(ModelHealthTransition::Failed),
    );
    assert_eq!(
        transition_for(None, ModelHealthAvailability::Available),
        None
    );
}

#[test]
fn repeated_status_does_not_notify_and_recovery_does() {
    assert_eq!(
        transition_for(
            Some(ModelHealthAvailability::Available),
            ModelHealthAvailability::Unavailable,
        ),
        Some(ModelHealthTransition::Failed),
    );
    assert_eq!(
        transition_for(
            Some(ModelHealthAvailability::Unavailable),
            ModelHealthAvailability::Unavailable,
        ),
        None,
    );
    assert_eq!(
        transition_for(
            Some(ModelHealthAvailability::Unavailable),
            ModelHealthAvailability::Available,
        ),
        Some(ModelHealthTransition::Recovered),
    );
    assert_eq!(
        transition_for(
            Some(ModelHealthAvailability::Available),
            ModelHealthAvailability::Available,
        ),
        None,
    );
    assert_eq!(
        transition_for(
            Some(ModelHealthAvailability::Skipped),
            ModelHealthAvailability::Unavailable,
        ),
        Some(ModelHealthTransition::Failed),
    );
}
