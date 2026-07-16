use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::crypto::generate_secret;

const LEGACY_LOCAL_RELAY_URL: &str = "ws://127.0.0.1:4178/ws";
const LEGACY_LOCAL_WEB_URL: &str = "http://127.0.0.1:4178";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PublicSettings {
    pub enabled: bool,
    pub paused: bool,
    pub relay_url: String,
    pub public_web_url: String,
    pub device_name: String,
    pub desktop_device_id: String,
    pub room_id: String,
    pub auto_reconnect: bool,
    pub heartbeat_seconds: u64,
    pub lan_pairing_enabled: bool,
    pub lan_pairing_port: u16,
    pub lan_allow_tailscale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SensitiveSettings {
    access_token: String,
    encryption_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteSettings {
    pub enabled: bool,
    pub paused: bool,
    pub relay_url: String,
    pub public_web_url: String,
    pub device_name: String,
    pub desktop_device_id: String,
    pub room_id: String,
    pub access_token: String,
    pub encryption_key: String,
    pub auto_reconnect: bool,
    pub heartbeat_seconds: u64,
    pub lan_pairing_enabled: bool,
    pub lan_pairing_port: u16,
    pub lan_allow_tailscale: bool,
}

impl Default for RemoteSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            paused: false,
            relay_url: String::new(),
            public_web_url: String::new(),
            device_name: std::env::var("COMPUTERNAME")
                .unwrap_or_else(|_| "Codex Compass".to_string()),
            desktop_device_id: uuid::Uuid::new_v4().to_string(),
            room_id: uuid::Uuid::new_v4().to_string(),
            access_token: generate_secret(),
            encryption_key: generate_secret(),
            auto_reconnect: true,
            heartbeat_seconds: 20,
            lan_pairing_enabled: false,
            lan_pairing_port: 4179,
            lan_allow_tailscale: false,
        }
    }
}

impl Default for PublicSettings {
    fn default() -> Self {
        let settings = RemoteSettings::default();
        Self::from(&settings)
    }
}

impl From<&RemoteSettings> for PublicSettings {
    fn from(settings: &RemoteSettings) -> Self {
        Self {
            enabled: settings.enabled,
            paused: settings.paused,
            relay_url: settings.relay_url.clone(),
            public_web_url: settings.public_web_url.clone(),
            device_name: settings.device_name.clone(),
            desktop_device_id: settings.desktop_device_id.clone(),
            room_id: settings.room_id.clone(),
            auto_reconnect: settings.auto_reconnect,
            heartbeat_seconds: settings.heartbeat_seconds,
            lan_pairing_enabled: settings.lan_pairing_enabled,
            lan_pairing_port: settings.lan_pairing_port,
            lan_allow_tailscale: settings.lan_allow_tailscale,
        }
    }
}

impl PublicSettings {
    pub fn merge_sensitive(self, current: &RemoteSettings) -> RemoteSettings {
        RemoteSettings {
            enabled: self.enabled,
            paused: self.paused,
            relay_url: self.relay_url,
            public_web_url: self.public_web_url,
            device_name: self.device_name,
            desktop_device_id: self.desktop_device_id,
            room_id: self.room_id,
            access_token: current.access_token.clone(),
            encryption_key: current.encryption_key.clone(),
            auto_reconnect: self.auto_reconnect,
            heartbeat_seconds: self.heartbeat_seconds,
            lan_pairing_enabled: self.lan_pairing_enabled,
            lan_pairing_port: self.lan_pairing_port,
            lan_allow_tailscale: self.lan_allow_tailscale,
        }
    }
}

pub struct SettingsStore {
    root: PathBuf,
}

impl SettingsStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn path(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    fn sensitive_path(&self) -> PathBuf {
        self.root.join("sensitive").join("credentials.json")
    }

    pub fn load_or_create(&self) -> Result<RemoteSettings, String> {
        fs::create_dir_all(&self.root).map_err(|_| "无法创建手机远控数据目录".to_string())?;
        let path = self.path();
        if !path.exists() || !self.sensitive_path().exists() {
            let settings = RemoteSettings::default();
            self.save(&settings)?;
            return Ok(settings);
        }
        let bytes = fs::read(&path).map_err(|_| "无法读取手机远控设置".to_string())?;
        let public: PublicSettings =
            serde_json::from_slice(&bytes).map_err(|_| "手机远控设置格式无效".to_string())?;
        let sensitive_bytes =
            fs::read(self.sensitive_path()).map_err(|_| "无法读取手机远控敏感设置".to_string())?;
        let sensitive: SensitiveSettings = serde_json::from_slice(&sensitive_bytes)
            .map_err(|_| "手机远控敏感设置格式无效".to_string())?;
        let mut settings = RemoteSettings {
            enabled: public.enabled,
            paused: public.paused,
            relay_url: public.relay_url,
            public_web_url: public.public_web_url,
            device_name: public.device_name,
            desktop_device_id: public.desktop_device_id,
            room_id: public.room_id,
            access_token: sensitive.access_token,
            encryption_key: sensitive.encryption_key,
            auto_reconnect: public.auto_reconnect,
            heartbeat_seconds: public.heartbeat_seconds,
            lan_pairing_enabled: public.lan_pairing_enabled,
            lan_pairing_port: public.lan_pairing_port,
            lan_allow_tailscale: public.lan_allow_tailscale,
        };
        if clear_legacy_unconfigured_endpoints(&mut settings) {
            self.save(&settings)?;
        }
        Ok(settings)
    }

    pub fn save(&self, settings: &RemoteSettings) -> Result<(), String> {
        validate_settings(settings)?;
        fs::create_dir_all(&self.root).map_err(|_| "无法创建手机远控数据目录".to_string())?;
        let sensitive_root = self.root.join("sensitive");
        fs::create_dir_all(&sensitive_root)
            .map_err(|_| "无法创建手机远控敏感数据目录".to_string())?;
        let public = PublicSettings::from(settings);
        let sensitive = SensitiveSettings {
            access_token: settings.access_token.clone(),
            encryption_key: settings.encryption_key.clone(),
        };
        atomic_write_json(&self.path(), &public, true)?;
        atomic_write_json(&self.sensitive_path(), &sensitive, false)
    }
}

fn atomic_write_json<T: Serialize>(
    path: &Path,
    value: &T,
    keep_backup: bool,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "远控设置路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "无法创建远控设置目录".to_string())?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "无法序列化远控设置".to_string())?;
    fs::write(&temporary, bytes).map_err(|_| "无法写入远控设置".to_string())?;
    if path.exists() {
        if keep_backup {
            let _ = fs::copy(path, path.with_extension("json.bak"));
        }
        fs::remove_file(path).map_err(|_| "无法替换远控设置".to_string())?;
    }
    fs::rename(&temporary, path).map_err(|_| "无法完成远控设置写入".to_string())
}

pub fn validate_settings(settings: &RemoteSettings) -> Result<(), String> {
    let relay_url = settings.relay_url.trim();
    let public_web_url = settings.public_web_url.trim();
    let endpoints_empty = relay_url.is_empty() && public_web_url.is_empty();
    if endpoints_empty {
        if settings.enabled || settings.lan_pairing_enabled {
            return Err("请先填写用户自建的中继 WSS 地址和手机网站 HTTPS 地址".to_string());
        }
    } else {
        if relay_url.is_empty() || public_web_url.is_empty() {
            return Err("中继 WSS 地址和手机网站 HTTPS 地址必须同时填写".to_string());
        }
        let url = url::Url::parse(relay_url).map_err(|_| "中继 WebSocket 地址无效".to_string())?;
        let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
        if url.scheme() != "wss" && !(url.scheme() == "ws" && local) {
            return Err("中继地址必须使用 WSS；仅本机开发允许 WS".to_string());
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("中继地址不得包含用户名或密码".to_string());
        }
        let web_url =
            url::Url::parse(public_web_url).map_err(|_| "手机网站地址无效".to_string())?;
        let local_web = matches!(web_url.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
        if web_url.scheme() != "https" && !(web_url.scheme() == "http" && local_web) {
            return Err("手机网站必须使用 HTTPS；仅本机开发允许 HTTP".to_string());
        }
        if !web_url.username().is_empty()
            || web_url.password().is_some()
            || web_url.fragment().is_some()
        {
            return Err("手机网站地址不得包含凭据或 URL 片段".to_string());
        }
    }
    if settings.room_id.trim().is_empty() || settings.desktop_device_id.trim().is_empty() {
        return Err("远控设备标识不能为空".to_string());
    }
    if settings.access_token.len() < 32 || settings.encryption_key.len() < 32 {
        return Err("远控访问密钥强度不足，请重新生成配对信息".to_string());
    }
    if !(10..=120).contains(&settings.heartbeat_seconds) {
        return Err("心跳间隔必须在 10 到 120 秒之间".to_string());
    }
    if settings.lan_pairing_port < 1024 || settings.lan_pairing_port == 8787 {
        return Err("局域网配对端口必须在 1024 到 65535 之间，且不能使用 8787".to_string());
    }
    Ok(())
}

fn clear_legacy_unconfigured_endpoints(settings: &mut RemoteSettings) -> bool {
    if !settings.enabled
        && !settings.lan_pairing_enabled
        && settings.relay_url == LEGACY_LOCAL_RELAY_URL
        && settings.public_web_url == LEGACY_LOCAL_WEB_URL
    {
        settings.relay_url.clear();
        settings.public_web_url.clear();
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_control_is_disabled_by_default() {
        let settings = RemoteSettings::default();
        assert!(!settings.enabled);
        assert!(!settings.paused);
        assert!(!settings.lan_pairing_enabled);
        assert!(settings.relay_url.is_empty());
        assert!(settings.public_web_url.is_empty());
        assert_eq!(settings.lan_pairing_port, 4179);
        assert!(!settings.lan_allow_tailscale);
        assert!(settings.access_token.len() >= 32);
        assert!(validate_settings(&settings).is_ok());
    }

    #[test]
    fn enabled_remote_control_requires_self_hosted_endpoints() {
        let mut settings = RemoteSettings::default();
        settings.enabled = true;
        assert!(validate_settings(&settings).is_err());
        settings.relay_url = "wss://relay.example.com/ws".into();
        assert!(validate_settings(&settings).is_err());
        settings.public_web_url = "https://relay.example.com".into();
        assert!(validate_settings(&settings).is_ok());
    }

    #[test]
    fn clears_only_disabled_legacy_local_defaults() {
        let mut settings = RemoteSettings {
            relay_url: LEGACY_LOCAL_RELAY_URL.into(),
            public_web_url: LEGACY_LOCAL_WEB_URL.into(),
            ..RemoteSettings::default()
        };
        assert!(clear_legacy_unconfigured_endpoints(&mut settings));
        assert!(settings.relay_url.is_empty());
        assert!(settings.public_web_url.is_empty());

        settings.enabled = true;
        settings.relay_url = LEGACY_LOCAL_RELAY_URL.into();
        settings.public_web_url = LEGACY_LOCAL_WEB_URL.into();
        assert!(!clear_legacy_unconfigured_endpoints(&mut settings));
    }

    #[test]
    fn rejects_plaintext_non_local_relay() {
        let mut settings = RemoteSettings::default();
        settings.relay_url = "ws://example.com/ws".into();
        settings.public_web_url = "https://example.com".into();
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn rejects_plaintext_non_local_mobile_site() {
        let mut settings = RemoteSettings::default();
        settings.relay_url = "wss://example.com/ws".into();
        settings.public_web_url = "http://example.com".into();
        assert!(validate_settings(&settings).is_err());
    }
}
