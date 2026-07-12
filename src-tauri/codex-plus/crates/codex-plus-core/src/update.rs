use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_REPOSITORY: &str = "CharlesWang505/Codex_Ultura";
pub const DEFAULT_LATEST_JSON_URL: &str =
    "https://api.github.com/repos/CharlesWang505/Codex_Ultura/releases/latest";
pub const DEFAULT_LATEST_RELEASE_URL: &str =
    "https://github.com/CharlesWang505/Codex_Ultura/releases/latest";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Release {
    pub version: String,
    pub url: String,
    pub body: String,
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateCheck {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_summary: String,
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub update_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateInstall {
    pub release: Release,
    pub installer_path: PathBuf,
    pub launched: bool,
}

pub fn parse_version_tag(value: &str) -> anyhow::Result<Vec<u64>> {
    let normalized = value.trim().trim_start_matches(['v', 'V']);
    let mut digits = String::new();
    for ch in normalized.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            digits.push(ch);
        } else {
            break;
        }
    }
    if digits.is_empty() {
        anyhow::bail!("Invalid version tag: {value}");
    }
    digits
        .split('.')
        .map(|part| part.parse::<u64>().map_err(Into::into))
        .collect()
}

pub fn is_newer_version(candidate: &str, current: &str) -> anyhow::Result<bool> {
    let mut left = parse_version_tag(candidate)?;
    let mut right = parse_version_tag(current)?;
    let len = left.len().max(right.len());
    left.resize(len, 0);
    right.resize(len, 0);
    Ok(left > right)
}

pub fn release_from_github_payload(payload: &Value) -> anyhow::Result<Release> {
    let version = payload
        .get("tag_name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("release payload missing tag_name"))?
        .to_string();
    let assets = payload
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|asset| {
            Some((
                asset.get("name")?.as_str()?.to_string(),
                asset.get("browser_download_url")?.as_str()?.to_string(),
            ))
        })
        .collect::<Vec<_>>();
    let selected = select_update_asset(&assets);
    Ok(Release {
        version,
        url: payload
            .get("html_url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        body: payload
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        asset_name: selected.as_ref().map(|asset| asset.name.clone()),
        asset_url: selected.map(|asset| asset.browser_download_url),
    })
}

pub fn release_from_latest_json_payload(payload: &Value) -> anyhow::Result<Release> {
    let version = payload
        .get("version")
        .or_else(|| payload.get("tag_name"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("latest.json missing version"))?
        .to_string();
    let assets = payload
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|asset| {
            let name = asset.get("name")?.as_str()?.to_string();
            let url = asset
                .get("url")
                .or_else(|| asset.get("browser_download_url"))?
                .as_str()?
                .to_string();
            Some((name, url))
        })
        .collect::<Vec<_>>();
    let selected = select_update_asset(&assets);
    Ok(Release {
        version,
        url: payload
            .get("url")
            .or_else(|| payload.get("html_url"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        body: payload
            .get("body")
            .or_else(|| payload.get("release_summary"))
            .or_else(|| payload.get("notes"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        asset_name: selected.as_ref().map(|asset| asset.name.clone()),
        asset_url: selected.map(|asset| asset.browser_download_url),
    })
}

pub fn release_from_github_latest_url(url: &str) -> anyhow::Result<Release> {
    let trusted_tag_prefix = format!("https://github.com/{DEFAULT_REPOSITORY}/releases/tag/");
    let tag = url
        .strip_prefix(&trusted_tag_prefix)
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.contains('/'))
        .ok_or_else(|| anyhow::anyhow!("GitHub latest 跳转没有返回可信的 Release 标签"))?;
    parse_version_tag(tag)?;

    let version = tag.trim_start_matches(['v', 'V']);
    let asset_name = fallback_asset_name(version);
    let asset_url = asset_name.as_ref().map(|name| {
        format!("https://github.com/{DEFAULT_REPOSITORY}/releases/download/{tag}/{name}")
    });

    Ok(Release {
        version: tag.to_string(),
        url: url.to_string(),
        body: "GitHub API 暂时不可用，已通过 Releases/latest 获取最新版本。".to_string(),
        asset_name,
        asset_url,
    })
}

pub fn select_update_asset(assets: &[(String, String)]) -> Option<ReleaseAsset> {
    let named = assets
        .iter()
        .filter(|(name, url)| !name.trim().is_empty() && !url.trim().is_empty());
    let mut best: Option<(u8, &str, &str)> = None;
    for (name, url) in named {
        let rank = platform_asset_rank(&name.to_ascii_lowercase());
        if rank >= 2 {
            continue;
        }
        if best.map_or(true, |(r, _, _)| rank < r) {
            best = Some((rank, name.as_str(), url.as_str()));
        }
    }
    best.map(|(_, name, url)| ReleaseAsset {
        name: name.to_string(),
        browser_download_url: url.to_string(),
    })
}

pub async fn fetch_latest_release(latest_json_url: &str) -> anyhow::Result<Release> {
    let client =
        crate::http_client::proxied_client(&format!("Codex-Compass/{}", crate::version::VERSION))?;
    let response = client
        .get(latest_json_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?;
    if !response.status().is_success() {
        if latest_json_url == DEFAULT_LATEST_JSON_URL {
            return fetch_latest_release_from_redirect(&client).await;
        }
        return Err(response.error_for_status().unwrap_err().into());
    }
    let payload = response.json::<Value>().await?;
    if payload.get("tag_name").is_some() {
        release_from_github_payload(&payload)
    } else {
        release_from_latest_json_payload(&payload)
    }
}

async fn fetch_latest_release_from_redirect(client: &reqwest::Client) -> anyhow::Result<Release> {
    let response = client
        .get(DEFAULT_LATEST_RELEASE_URL)
        .header(reqwest::header::ACCEPT, "text/html")
        .send()
        .await?
        .error_for_status()?;
    release_from_github_latest_url(response.url().as_str())
}

pub async fn check_for_update(current_version: &str) -> anyhow::Result<UpdateCheck> {
    let release = fetch_latest_release(DEFAULT_LATEST_JSON_URL).await?;
    let update_available = is_newer_version(&release.version, current_version)?;
    Ok(UpdateCheck {
        current_version: current_version.to_string(),
        latest_version: Some(release.version),
        release_summary: release.body,
        asset_name: release.asset_name,
        asset_url: release.asset_url,
        update_available,
    })
}

pub async fn perform_update(
    release: &Release,
    download_dir: &Path,
) -> anyhow::Result<UpdateInstall> {
    validate_release_source(release)?;
    let url = release
        .asset_url
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("没有可下载的 Release asset"))?;
    let bytes =
        crate::http_client::proxied_client(&format!("Codex-Compass/{}", crate::version::VERSION))?
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
    let installer_path = download_asset_to(release, &bytes, download_dir)?;
    launch_installer(&installer_path)?;
    Ok(UpdateInstall {
        release: release.clone(),
        installer_path,
        launched: true,
    })
}

pub fn validate_release_source(release: &Release) -> anyhow::Result<()> {
    let name = release
        .asset_name
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("Release 没有可下载的安装包"))?;
    let url = release
        .asset_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("Release 没有可下载地址"))?;
    let trusted_prefix = format!(
        "https://github.com/{}/releases/download/",
        DEFAULT_REPOSITORY
    );
    if !url.starts_with(&trusted_prefix) {
        anyhow::bail!("拒绝下载非 Codex Compass 官方 GitHub Release 资产");
    }
    if select_update_asset(&[(name.to_string(), url.to_string())]).is_none() {
        anyhow::bail!("Release 资产不是当前平台支持的 Codex Compass 安装包");
    }
    Ok(())
}

pub fn download_asset_to(
    release: &Release,
    bytes: &[u8],
    download_dir: &Path,
) -> anyhow::Result<PathBuf> {
    let name = release
        .asset_name
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("没有可下载的 Release asset"))?;
    let safe = safe_asset_name(name)?;
    std::fs::create_dir_all(download_dir)?;
    let path = download_dir.join(safe);
    std::fs::write(&path, bytes)?;
    Ok(path)
}

pub fn safe_asset_name(name: &str) -> anyhow::Result<String> {
    if name.trim().is_empty() {
        anyhow::bail!("非法 Release asset 文件名: {name}");
    }
    let path = Path::new(name);
    if path.components().count() != 1 {
        anyhow::bail!("非法 Release asset 文件名: {name}");
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("非法 Release asset 文件名: {name}"))?;
    if file_name == "." || file_name == ".." {
        anyhow::bail!("非法 Release asset 文件名: {name}");
    }
    Ok(file_name.to_string())
}

fn platform_asset_rank(name: &str) -> u8 {
    // 0 = exact match (current OS + native arch)
    // 1 = same OS, other arch (acceptable fallback, e.g. x86_64 on arm64 or vice versa)
    // 2 = wrong platform
    if cfg!(target_os = "macos") {
        if !is_macos_installer_asset(name) {
            return 2;
        }
        if is_macos_native_arch_asset(name) {
            return 0;
        }
        return 1;
    }
    if cfg!(windows) && is_windows_installer_asset(name) {
        return 0;
    }
    2
}

fn fallback_asset_name(version: &str) -> Option<String> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return None,
    };
    if cfg!(windows) {
        return Some(format!("Codex_Compass_{version}_{arch}-setup.exe"));
    }
    if cfg!(target_os = "macos") {
        return Some(format!("Codex_Compass_{version}_{arch}.dmg"));
    }
    None
}

fn is_macos_native_arch_asset(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let native_arch_token = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return true, // unknown arch — accept anything
    };
    // Modern filename shape: `...-macos-x64.dmg` or `...-macos-arm64.dmg`
    if lower.contains(&format!("-{native_arch_token}.")) {
        return true;
    }
    // Old filename shape: `CodexPlusPlus_1.0.9_x64.dmg`
    if lower.contains(&format!("_{native_arch_token}.")) {
        return true;
    }
    // Newer but alternative shape: `..._x64.dmg` (no `macos-` token)
    let other_token = if native_arch_token == "x64" {
        "arm64"
    } else {
        "x64"
    };
    if lower.contains(&format!("_{other_token}.")) || lower.contains(&format!("-{other_token}.")) {
        return false;
    }
    // No arch token at all — assume it matches the current arch.
    true
}

fn is_windows_installer_asset(name: &str) -> bool {
    is_supported_product_asset(name)
        && (name.ends_with(".msi")
            || name.ends_with("-setup.exe")
            || name.ends_with("_setup.exe")
            || name.ends_with("setup.exe")
            || name.ends_with("installer.exe"))
}

fn is_macos_installer_asset(name: &str) -> bool {
    // Loose shape check; arch preference is handled by platform_asset_rank
    // via is_macos_native_arch_asset.
    is_supported_product_asset(name) && name.ends_with(".dmg")
}

fn is_supported_product_asset(name: &str) -> bool {
    name.contains("codex") && (name.contains("compass") || name.contains("plus"))
}

pub fn launch_installer(path: &Path) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(path)
            .creation_flags(crate::windows_integration::CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|error| anyhow::anyhow!("启动安装包失败：{error}"))
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| anyhow::anyhow!("打开 DMG 失败：{error}"))
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let _ = path;
        anyhow::bail!("当前平台不支持启动安装包")
    }
}
