use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::crypto::decrypt_blob;
use super::settings::RemoteSettings;
use super::workspace::AuthorizedWorkspace;

const MAX_ATTACHMENTS: usize = 5;
const MAX_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_ATTACHMENT_NAME_CHARS: usize = 160;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAttachment {
    pub upload_id: String,
    pub download_token: String,
    pub client_id: String,
    pub name: String,
    #[serde(default)]
    pub mime_type: String,
    pub size: u64,
    pub sha256: String,
    pub nonce: String,
    pub aad_version: u8,
}

pub struct PreparedAttachments {
    pub image_inputs: Vec<Value>,
    pub references: Vec<String>,
}

pub async fn prepare_attachments(
    settings: &RemoteSettings,
    workspace: &AuthorizedWorkspace,
    session_id: &str,
    remote_device_id: &str,
    attachments: Vec<RemoteAttachment>,
) -> Result<PreparedAttachments, String> {
    if attachments.is_empty() {
        return Ok(PreparedAttachments {
            image_inputs: Vec::new(),
            references: Vec::new(),
        });
    }
    if !workspace.allow_uploads {
        return Err("该工作区未允许手机上传文件".to_string());
    }
    if attachments.len() > MAX_ATTACHMENTS {
        return Err(format!("单次最多上传 {MAX_ATTACHMENTS} 个文件"));
    }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|_| "无法初始化附件下载".to_string())?;
    let workspace_root =
        fs::canonicalize(&workspace.path).map_err(|_| "授权工作区已失效".to_string())?;
    let upload_root = secure_upload_root(&workspace_root, session_id)?;
    let mut image_inputs = Vec::new();
    let mut references = Vec::new();

    for attachment in attachments {
        validate_descriptor(&attachment)?;
        let ciphertext = download_ciphertext(
            &client,
            settings,
            remote_device_id,
            &attachment.upload_id,
            &attachment.download_token,
            attachment.size,
        )
        .await?;
        let aad = attachment_aad(
            &settings.room_id,
            remote_device_id,
            &settings.desktop_device_id,
            &attachment.client_id,
            attachment.size,
            &attachment.sha256,
        );
        let plaintext = decrypt_blob(
            &settings.encryption_key,
            &attachment.nonce,
            &aad,
            &ciphertext,
        )?;
        if plaintext.len() as u64 != attachment.size {
            return Err("附件解密后的大小不匹配".to_string());
        }
        let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(&plaintext));
        if digest != attachment.sha256 {
            return Err("附件 SHA-256 校验失败".to_string());
        }

        let safe_name = safe_filename(&attachment.name)?;
        let destination = write_attachment(&workspace_root, &upload_root, &safe_name, &plaintext)?;
        let relative = destination
            .strip_prefix(&workspace_root)
            .map_err(|_| "附件路径超出授权工作区".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if is_image(&safe_name, &attachment.mime_type) {
            image_inputs.push(json!({
                "type": "localImage",
                "path": destination.to_string_lossy(),
                "detail": "auto"
            }));
        } else {
            references.push(relative);
        }
    }

    Ok(PreparedAttachments {
        image_inputs,
        references,
    })
}

fn validate_descriptor(attachment: &RemoteAttachment) -> Result<(), String> {
    if attachment.aad_version != 1 {
        return Err("附件加密协议版本不兼容".to_string());
    }
    if uuid::Uuid::parse_str(&attachment.upload_id).is_err()
        || uuid::Uuid::parse_str(&attachment.client_id).is_err()
        || attachment.download_token.len() < 32
    {
        return Err("附件标识无效".to_string());
    }
    if attachment.size == 0 || attachment.size > MAX_ATTACHMENT_BYTES {
        return Err("附件为空或超过 10 MiB".to_string());
    }
    if attachment.name.chars().count() > MAX_ATTACHMENT_NAME_CHARS
        || attachment.sha256.len() < 40
        || attachment.nonce.len() < 12
    {
        return Err("附件元数据无效".to_string());
    }
    Ok(())
}

async fn download_ciphertext(
    client: &reqwest::Client,
    settings: &RemoteSettings,
    remote_device_id: &str,
    upload_id: &str,
    download_token: &str,
    plaintext_size: u64,
) -> Result<Vec<u8>, String> {
    let mut url = url::Url::parse(&settings.relay_url).map_err(|_| "中继地址无效".to_string())?;
    let scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        _ => return Err("中继地址协议无效".to_string()),
    };
    url.set_scheme(scheme)
        .map_err(|_| "无法构造附件下载地址".to_string())?;
    url.set_path(&format!("/api/uploads/{upload_id}"));
    url.set_query(None);
    url.set_fragment(None);

    let response = client
        .get(url)
        .bearer_auth(&settings.access_token)
        .header("X-Room-Id", &settings.room_id)
        .header("X-Device-Id", &settings.desktop_device_id)
        .header("X-Remote-Device-Id", remote_device_id)
        .header("X-Upload-Token", download_token)
        .send()
        .await
        .map_err(|_| "无法从中继下载加密附件".to_string())?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "中继拒绝附件下载认证".to_string(),
            404 => "附件已过期、已下载或不存在".to_string(),
            _ => "中继附件下载失败".to_string(),
        });
    }
    let max_ciphertext = plaintext_size.saturating_add(16);
    if response
        .content_length()
        .is_some_and(|length| length != max_ciphertext)
    {
        return Err("加密附件大小不匹配".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "读取加密附件失败".to_string())?;
    if bytes.len() as u64 != max_ciphertext {
        return Err("加密附件大小不匹配".to_string());
    }
    Ok(bytes.to_vec())
}

fn attachment_aad(
    room_id: &str,
    sender_device_id: &str,
    target_device_id: &str,
    client_id: &str,
    size: u64,
    sha256: &str,
) -> Vec<u8> {
    format!(
        "codex-compass-upload-v1\n{room_id}\n{sender_device_id}\n{target_device_id}\n{client_id}\n{size}\n{sha256}"
    )
    .into_bytes()
}

fn secure_upload_root(workspace_root: &Path, session_id: &str) -> Result<PathBuf, String> {
    let session_segment = safe_segment(session_id);
    let root = workspace_root
        .join(".codex-compass")
        .join("uploads")
        .join(session_segment);
    fs::create_dir_all(&root).map_err(|_| "无法创建工作区附件目录".to_string())?;
    let canonical = fs::canonicalize(&root).map_err(|_| "无法校验工作区附件目录".to_string())?;
    if !canonical.starts_with(workspace_root) {
        return Err("附件目录通过符号链接逃逸授权工作区".to_string());
    }
    Ok(canonical)
}

fn write_attachment(
    workspace_root: &Path,
    upload_root: &Path,
    filename: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let destination = upload_root.join(format!(
        "{}-{filename}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    ));
    if destination
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("附件路径无效".to_string());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|_| "无法写入工作区附件".to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "无法完成工作区附件写入".to_string())?;
    let canonical =
        fs::canonicalize(&destination).map_err(|_| "无法校验工作区附件路径".to_string())?;
    if !canonical.starts_with(workspace_root) {
        let _ = fs::remove_file(&canonical);
        return Err("附件文件通过符号链接逃逸授权工作区".to_string());
    }
    Ok(canonical)
}

fn safe_filename(value: &str) -> Result<String, String> {
    let original = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let mut result = original
        .chars()
        .filter(|character| {
            character.is_alphanumeric() || matches!(character, '.' | '-' | '_' | ' ')
        })
        .take(100)
        .collect::<String>();
    result = result.trim_matches(['.', ' ']).trim().to_string();
    if result.is_empty() {
        result = "attachment.bin".to_string();
    }
    let extension = Path::new(&result)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if is_blocked_extension(&extension) {
        return Err(format!("禁止远程上传 .{extension} 文件"));
    }
    Ok(result)
}

fn is_blocked_extension(extension: &str) -> bool {
    matches!(
        extension,
        "exe"
            | "msi"
            | "msp"
            | "com"
            | "scr"
            | "bat"
            | "cmd"
            | "ps1"
            | "vbs"
            | "vbe"
            | "jse"
            | "wsf"
            | "wsh"
            | "reg"
            | "lnk"
            | "url"
            | "dll"
            | "sys"
    )
}

fn is_image(filename: &str, mime_type: &str) -> bool {
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    mime_type.starts_with("image/")
        && matches!(
            extension.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
        )
}

fn safe_segment(value: &str) -> String {
    let segment = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(64)
        .collect::<String>();
    if segment.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        segment
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_rejects_path_traversal_and_executables() {
        assert_eq!(safe_filename("../../报告.txt").unwrap(), "报告.txt");
        assert!(safe_filename("payload.EXE").is_err());
    }

    #[test]
    fn upload_root_cannot_escape_through_a_symlink() {
        let workspace = tempfile::tempdir().unwrap();
        let canonical = fs::canonicalize(workspace.path()).unwrap();
        let root = secure_upload_root(&canonical, "../../outside").unwrap();
        assert!(root.starts_with(&canonical));
    }

    #[test]
    fn attachment_aad_binds_route_and_plaintext_metadata() {
        let first = attachment_aad("room", "mobile", "desktop", "file", 12, "hash");
        let second = attachment_aad("room", "other", "desktop", "file", 12, "hash");
        assert_ne!(first, second);
    }
}
