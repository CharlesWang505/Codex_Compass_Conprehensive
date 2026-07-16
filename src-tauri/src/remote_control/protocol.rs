use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_RELAY_MESSAGE_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayAuth {
    pub protocol_version: u16,
    pub kind: String,
    pub role: String,
    pub room_id: String,
    pub device_id: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayFrame {
    pub protocol_version: u16,
    pub kind: String,
    pub room_id: String,
    pub sender_device_id: String,
    pub target_device_id: Option<String>,
    pub message_id: String,
    pub sequence: u64,
    pub nonce: String,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMessage {
    pub protocol_version: u16,
    pub message_id: String,
    pub timestamp: u64,
    pub request_id: Option<String>,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(default)]
    pub payload: Value,
}

impl RemoteMessage {
    pub fn event(
        message_type: impl Into<String>,
        request_id: Option<String>,
        session_id: Option<String>,
        turn_id: Option<String>,
        payload: Value,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            message_id: uuid::Uuid::new_v4().to_string(),
            timestamp: unix_timestamp_ms(),
            request_id,
            session_id,
            turn_id,
            message_type: message_type.into(),
            payload,
        }
    }
}

pub fn unix_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_envelope_round_trips() {
        let frame = RelayFrame {
            protocol_version: PROTOCOL_VERSION,
            kind: "relay".into(),
            room_id: "room".into(),
            sender_device_id: "desktop".into(),
            target_device_id: Some("mobile".into()),
            message_id: "message".into(),
            sequence: 7,
            nonce: "nonce".into(),
            payload: "ciphertext".into(),
        };
        let encoded = serde_json::to_vec(&frame).unwrap();
        let decoded: RelayFrame = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded.protocol_version, 1);
        assert_eq!(decoded.sequence, 7);
        assert_eq!(decoded.target_device_id.as_deref(), Some("mobile"));
    }
}
