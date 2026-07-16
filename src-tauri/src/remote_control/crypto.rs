use std::collections::{HashSet, VecDeque};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use super::protocol::{RelayFrame, RemoteMessage};

const REPLAY_WINDOW_SIZE: usize = 2_048;

pub fn generate_secret() -> String {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_key(encoded: &str) -> Result<[u8; 32], String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded.trim())
        .map_err(|_| "远控加密密钥格式无效".to_string())?;
    bytes
        .try_into()
        .map_err(|_| "远控加密密钥长度无效".to_string())
}

pub fn decrypt_blob(
    key: &str,
    nonce: &str,
    aad: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(&decode_key(key)?)
        .map_err(|_| "无法初始化附件解密".to_string())?;
    let nonce = URL_SAFE_NO_PAD
        .decode(nonce)
        .map_err(|_| "附件 nonce 无效".to_string())?;
    if nonce.len() != 12 {
        return Err("附件 nonce 长度无效".to_string());
    }
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| "附件解密或完整性校验失败".to_string())
}

fn aad(frame: &RelayFrame) -> Vec<u8> {
    format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{}",
        frame.protocol_version,
        frame.kind,
        frame.room_id,
        frame.sender_device_id,
        frame.target_device_id.as_deref().unwrap_or(""),
        frame.message_id,
        frame.sequence
    )
    .into_bytes()
}

pub fn encrypt_message(
    key: &str,
    mut frame: RelayFrame,
    message: &RemoteMessage,
) -> Result<RelayFrame, String> {
    let cipher = Aes256Gcm::new_from_slice(&decode_key(key)?)
        .map_err(|_| "无法初始化远控加密".to_string())?;
    let nonce_uuid = uuid::Uuid::new_v4();
    let nonce_bytes = &nonce_uuid.as_bytes()[..12];
    let plaintext = serde_json::to_vec(message).map_err(|_| "无法序列化远控消息".to_string())?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: &aad(&frame),
            },
        )
        .map_err(|_| "无法加密远控消息".to_string())?;
    frame.nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
    frame.payload = URL_SAFE_NO_PAD.encode(ciphertext);
    Ok(frame)
}

pub fn decrypt_message(key: &str, frame: &RelayFrame) -> Result<RemoteMessage, String> {
    let cipher = Aes256Gcm::new_from_slice(&decode_key(key)?)
        .map_err(|_| "无法初始化远控解密".to_string())?;
    let nonce = URL_SAFE_NO_PAD
        .decode(&frame.nonce)
        .map_err(|_| "远控消息 nonce 无效".to_string())?;
    if nonce.len() != 12 {
        return Err("远控消息 nonce 长度无效".to_string());
    }
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&frame.payload)
        .map_err(|_| "远控消息密文格式无效".to_string())?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad(frame),
            },
        )
        .map_err(|_| "远控消息校验失败".to_string())?;
    serde_json::from_slice(&plaintext).map_err(|_| "远控消息内容无效".to_string())
}

#[derive(Default)]
pub struct ReplayGuard {
    ids: HashSet<String>,
    order: VecDeque<String>,
    highest_sequence: u64,
}

impl ReplayGuard {
    pub fn accept(&mut self, message_id: &str, sequence: u64) -> bool {
        if message_id.is_empty() || self.ids.contains(message_id) {
            return false;
        }
        if self.highest_sequence > 0 && sequence <= self.highest_sequence {
            return false;
        }
        self.highest_sequence = self.highest_sequence.max(sequence);
        self.ids.insert(message_id.to_string());
        self.order.push_back(message_id.to_string());
        while self.order.len() > REPLAY_WINDOW_SIZE {
            if let Some(expired) = self.order.pop_front() {
                self.ids.remove(&expired);
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::remote_control::protocol::{PROTOCOL_VERSION, RelayFrame, RemoteMessage};

    fn frame() -> RelayFrame {
        RelayFrame {
            protocol_version: PROTOCOL_VERSION,
            kind: "relay".into(),
            room_id: "room".into(),
            sender_device_id: "desktop".into(),
            target_device_id: None,
            message_id: "message-1".into(),
            sequence: 1,
            nonce: String::new(),
            payload: String::new(),
        }
    }

    #[test]
    fn encrypts_and_authenticates_messages() {
        let key = generate_secret();
        let message =
            RemoteMessage::event("codex.status", None, None, None, json!({"ready": true}));
        let encrypted = encrypt_message(&key, frame(), &message).unwrap();
        let decrypted = decrypt_message(&key, &encrypted).unwrap();
        assert_eq!(decrypted.message_type, "codex.status");

        let mut tampered = encrypted;
        tampered.target_device_id = Some("other-mobile".into());
        assert!(decrypt_message(&key, &tampered).is_err());
    }

    #[test]
    fn rejects_duplicate_and_stale_messages() {
        let mut guard = ReplayGuard::default();
        assert!(guard.accept("one", 10));
        assert!(!guard.accept("one", 10));
        assert!(guard.accept("two", 11));
        assert!(!guard.accept("stale", 0));
    }
}
