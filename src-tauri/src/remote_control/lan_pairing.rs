use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, watch};
use x25519_dalek::{PublicKey, StaticSecret};

use super::crypto::generate_secret;
use super::protocol::unix_timestamp_ms;
use super::settings::RemoteSettings;

const PAIRING_TTL_MS: u64 = 2 * 60 * 1_000;
const PAIRING_RATE_WINDOW_MS: u64 = 2 * 60 * 1_000;
const PAIRING_RATE_LIMIT: usize = 12;
const MAX_FAILED_CODES: u16 = 12;
const MAX_PAIRING_BODY_BYTES: usize = 32 * 1024;
const LAN_PAIRING_HTML: &str = include_str!("../../../server/web/lan-pairing.html");
const LAN_PAIRING_CSS: &str = include_str!("../../../server/web/lan-pairing.css");
const LAN_PAIRING_JS: &str = include_str!("../../../server/web/lan-pairing.bundle.js");

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanPairingInvitation {
    pub code: String,
    pub pairing_urls: Vec<String>,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingLanPairing {
    pub request_id: String,
    pub device_name: String,
    pub browser: String,
    pub platform: String,
    pub remote_address: String,
    pub requested_at: u64,
    pub expires_at: u64,
    pub verification_code: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanPairingSnapshot {
    pub status: String,
    pub urls: Vec<String>,
    pub last_error: Option<String>,
    pub invitation: Option<LanPairingInvitationSummary>,
    pub pending_requests: Vec<PendingLanPairing>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanPairingInvitationSummary {
    pub code: String,
    pub expires_at: u64,
}

#[derive(Clone)]
pub struct LanPairingManager {
    state: Arc<Mutex<LanPairingState>>,
}

struct LanPairingState {
    status: String,
    urls: Vec<String>,
    last_error: Option<String>,
    settings: Option<PairingCredentials>,
    invitation: Option<InvitationRecord>,
    requests: HashMap<String, PairingRequestRecord>,
    attempts: HashMap<IpAddr, VecDeque<u64>>,
}

#[derive(Clone)]
struct PairingCredentials {
    public_web_url: String,
    room_id: String,
    desktop_device_id: String,
    access_token: String,
    encryption_key: String,
}

struct InvitationRecord {
    code: String,
    secret: String,
    expires_at: u64,
    failed_attempts: u16,
}

struct PairingRequestRecord {
    public: PendingLanPairing,
    poll_token_digest: [u8; 32],
    pairing_key: [u8; 32],
    status: PairingRequestStatus,
    encrypted_payload: Option<EncryptedPairingPayload>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PairingRequestStatus {
    Pending,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedPairingPayload {
    nonce: String,
    ciphertext: String,
    aad: String,
}

impl Default for LanPairingManager {
    fn default() -> Self {
        Self::new()
    }
}

impl LanPairingManager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(LanPairingState {
                status: "disabled".into(),
                urls: Vec::new(),
                last_error: None,
                settings: None,
                invitation: None,
                requests: HashMap::new(),
                attempts: HashMap::new(),
            })),
        }
    }

    pub async fn start_runtime(&self, settings: &RemoteSettings, urls: Vec<String>) {
        let mut state = self.state.lock().await;
        state.status = "listening".into();
        state.urls = urls;
        state.last_error = None;
        state.settings = Some(PairingCredentials {
            public_web_url: settings.public_web_url.clone(),
            room_id: settings.room_id.clone(),
            desktop_device_id: settings.desktop_device_id.clone(),
            access_token: settings.access_token.clone(),
            encryption_key: settings.encryption_key.clone(),
        });
        state.invitation = None;
        state.requests.clear();
        state.attempts.clear();
    }

    pub async fn stop_runtime(&self) {
        let mut state = self.state.lock().await;
        state.status = "disabled".into();
        state.urls.clear();
        state.settings = None;
        state.invitation = None;
        state.requests.clear();
        state.attempts.clear();
    }

    pub async fn set_runtime_error(&self, error: String) {
        let mut state = self.state.lock().await;
        state.status = "error".into();
        state.last_error = Some(error);
        state.urls.clear();
        state.settings = None;
        state.invitation = None;
        state.requests.clear();
    }

    pub async fn snapshot(&self) -> LanPairingSnapshot {
        let mut state = self.state.lock().await;
        purge_expired(&mut state);
        LanPairingSnapshot {
            status: state.status.clone(),
            urls: state.urls.clone(),
            last_error: state.last_error.clone(),
            invitation: state
                .invitation
                .as_ref()
                .map(|invitation| LanPairingInvitationSummary {
                    code: invitation.code.clone(),
                    expires_at: invitation.expires_at,
                }),
            pending_requests: pending_requests(&state),
        }
    }

    pub async fn create_invitation(&self) -> Result<LanPairingInvitation, String> {
        let mut state = self.state.lock().await;
        purge_expired(&mut state);
        if state.status != "listening" || state.settings.is_none() {
            return Err("请先开启手机远控和局域网配对".into());
        }
        let code = generate_pairing_code();
        let secret = generate_secret();
        let expires_at = unix_timestamp_ms().saturating_add(PAIRING_TTL_MS);
        let pairing_urls = state
            .urls
            .iter()
            .map(|url| {
                format!(
                    "{}?code={}#secret={}",
                    url,
                    urlencoding::encode(&code),
                    urlencoding::encode(&secret)
                )
            })
            .collect();
        state.invitation = Some(InvitationRecord {
            code: code.clone(),
            secret,
            expires_at,
            failed_attempts: 0,
        });
        state
            .requests
            .retain(|_, request| request.public.mode == "direct");
        Ok(LanPairingInvitation {
            code,
            pairing_urls,
            expires_at,
        })
    }

    pub async fn cancel_invitation(&self) {
        let mut state = self.state.lock().await;
        state.invitation = None;
        for request in state.requests.values_mut() {
            if request.public.mode != "direct" && request.status == PairingRequestStatus::Pending {
                request.status = PairingRequestStatus::Rejected;
            }
        }
    }

    pub async fn approve(&self, request_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().await;
        purge_expired(&mut state);
        let credentials = state
            .settings
            .clone()
            .ok_or_else(|| "局域网配对服务未运行".to_string())?;
        let request = state
            .requests
            .get_mut(request_id)
            .ok_or_else(|| "配对请求不存在或已过期".to_string())?;
        if request.status != PairingRequestStatus::Pending {
            return Err("配对请求已经处理".into());
        }
        let plaintext = serde_json::to_vec(&json!({
            "protocolVersion": 1,
            "publicWebUrl": credentials.public_web_url,
            "roomId": credentials.room_id,
            "desktopDeviceId": credentials.desktop_device_id,
            "token": credentials.access_token,
            "key": credentials.encryption_key,
        }))
        .map_err(|_| "无法编码配对凭据".to_string())?;
        request.encrypted_payload = Some(encrypt_pairing_payload(
            &request.pairing_key,
            request_id,
            &plaintext,
        )?);
        request.status = PairingRequestStatus::Approved;
        let approved_mode = request.public.mode.clone();
        if approved_mode != "direct" {
            state.invitation = None;
            for (other_id, other) in state.requests.iter_mut() {
                if other_id != request_id
                    && other.public.mode != "direct"
                    && other.status == PairingRequestStatus::Pending
                {
                    other.status = PairingRequestStatus::Rejected;
                }
            }
        }
        Ok(())
    }

    pub async fn reject(&self, request_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().await;
        purge_expired(&mut state);
        let request = state
            .requests
            .get_mut(request_id)
            .ok_or_else(|| "配对请求不存在或已过期".to_string())?;
        request.status = PairingRequestStatus::Rejected;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingRequestInput {
    mode: String,
    code: Option<String>,
    credential_kind: Option<String>,
    proof: Option<String>,
    client_public_key: String,
    request_nonce: String,
    device_id: String,
    device_name: String,
    browser: Option<String>,
    platform: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingRequestAccepted {
    request_id: String,
    poll_token: String,
    server_public_key: String,
    verification_code: String,
    expires_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingPollResponse {
    status: String,
    expires_at: u64,
    encrypted_payload: Option<EncryptedPairingPayload>,
}

pub struct LanPairingRuntimeTask {
    pub stop: watch::Sender<bool>,
    pub handle: tokio::task::JoinHandle<()>,
}

pub async fn start_server(
    port: u16,
    allow_tailscale: bool,
    pairing: LanPairingManager,
    settings: &RemoteSettings,
) -> Result<(LanPairingRuntimeTask, Vec<String>), String> {
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, port))
        .await
        .map_err(|error| format!("无法监听局域网配对端口 {port}：{error}"))?;
    let actual_port = listener
        .local_addr()
        .map_err(|error| format!("无法读取局域网配对端口：{error}"))?
        .port();
    let urls = discover_lan_pairing_urls(actual_port, allow_tailscale);
    pairing.start_runtime(settings, urls.clone()).await;
    let app_state = LanServerState {
        pairing: pairing.clone(),
        allow_tailscale,
    };
    let router = Router::new()
        .route("/", get(|| async { Redirect::temporary("/pair") }))
        .route("/pair", get(pairing_page))
        .route("/lan-pairing.css", get(pairing_css))
        .route("/lan-pairing.js", get(pairing_js))
        .route("/healthz", get(lan_health))
        .route("/api/lan/pairing/request", post(pairing_request))
        .route("/api/lan/pairing/status/{request_id}", get(pairing_status))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_PAIRING_BODY_BYTES))
        .layer(middleware::from_fn(security_headers))
        .with_state(app_state);
    let (stop, mut stop_rx) = watch::channel(false);
    let handle = tokio::spawn(async move {
        if let Err(error) = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = stop_rx.changed().await;
        })
        .await
        {
            pairing
                .set_runtime_error(format!("局域网配对服务异常退出：{error}"))
                .await;
        }
    });
    Ok((LanPairingRuntimeTask { stop, handle }, urls))
}

#[derive(Clone)]
struct LanServerState {
    pairing: LanPairingManager,
    allow_tailscale: bool,
}

async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        ),
    );
    response
}

async fn pairing_page(
    State(state): State<LanServerState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if !is_allowed_lan_client(remote.ip(), state.allow_tailscale) {
        return forbidden_response();
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        LAN_PAIRING_HTML,
    )
        .into_response()
}

async fn pairing_css(
    State(state): State<LanServerState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if !is_allowed_lan_client(remote.ip(), state.allow_tailscale) {
        return forbidden_response();
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        LAN_PAIRING_CSS,
    )
        .into_response()
}

async fn pairing_js(
    State(state): State<LanServerState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if !is_allowed_lan_client(remote.ip(), state.allow_tailscale) {
        return forbidden_response();
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        LAN_PAIRING_JS,
    )
        .into_response()
}

async fn lan_health(
    State(state): State<LanServerState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if !is_allowed_lan_client(remote.ip(), state.allow_tailscale) {
        return forbidden_response();
    }
    Json(json!({"ok": true, "pairingProtocolVersion": 1})).into_response()
}

async fn pairing_request(
    State(server): State<LanServerState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(input): Json<PairingRequestInput>,
) -> Response {
    if !is_allowed_lan_client(remote.ip(), server.allow_tailscale) {
        return forbidden_response();
    }
    match create_pairing_request(&server.pairing, remote.ip(), input).await {
        Ok(value) => (StatusCode::CREATED, Json(value)).into_response(),
        Err((status, message)) => (status, Json(json!({"error": message}))).into_response(),
    }
}

async fn pairing_status(
    State(server): State<LanServerState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !is_allowed_lan_client(remote.ip(), server.allow_tailscale) {
        return forbidden_response();
    }
    let token = bearer_token(&headers);
    let mut state = server.pairing.state.lock().await;
    purge_expired(&mut state);
    let Some(request) = state.requests.get(&request_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "配对请求不存在或已过期"})),
        )
            .into_response();
    };
    if token.is_empty()
        || !bool::from(digest_token(token).ct_eq(request.poll_token_digest.as_slice()))
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "配对轮询凭据无效"})),
        )
            .into_response();
    }
    let status = match request.status {
        PairingRequestStatus::Pending => "pending",
        PairingRequestStatus::Approved => "approved",
        PairingRequestStatus::Rejected => "rejected",
    };
    Json(PairingPollResponse {
        status: status.into(),
        expires_at: request.public.expires_at,
        encrypted_payload: request.encrypted_payload.clone(),
    })
    .into_response()
}

async fn create_pairing_request(
    pairing: &LanPairingManager,
    remote_ip: IpAddr,
    input: PairingRequestInput,
) -> Result<PairingRequestAccepted, (StatusCode, String)> {
    let mut state = pairing.state.lock().await;
    purge_expired(&mut state);
    if state.status != "listening" || state.settings.is_none() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "电脑当前未开放局域网配对".into(),
        ));
    }
    if !accept_attempt(&mut state, remote_ip) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "配对请求过于频繁，请稍后再试".into(),
        ));
    }

    let mode = match input.mode.as_str() {
        "invite" => "invite",
        "direct" => "direct",
        _ => {
            return Err((StatusCode::BAD_REQUEST, "局域网配对模式无效".into()));
        }
    };
    let client_public_key = decode_fixed::<32>(&input.client_public_key)
        .ok_or((StatusCode::BAD_REQUEST, "手机临时公钥无效".into()))?;
    let client_public = PublicKey::from(client_public_key);
    let server_secret = StaticSecret::random();
    let server_public = PublicKey::from(&server_secret);
    let shared = server_secret.diffie_hellman(&client_public);
    if shared.as_bytes().iter().all(|byte| *byte == 0) {
        return Err((StatusCode::BAD_REQUEST, "手机临时公钥无效".into()));
    }

    let code = clean_code(input.code.as_deref());
    let credential_kind = input.credential_kind.as_deref().unwrap_or("");
    let credential_material = if mode == "invite" {
        let Some(invitation) = state.invitation.as_mut() else {
            return Err((StatusCode::GONE, "配对码不存在或已失效".into()));
        };
        if invitation.expires_at <= unix_timestamp_ms()
            || code.as_deref() != Some(invitation.code.as_str())
        {
            invitation.failed_attempts = invitation.failed_attempts.saturating_add(1);
            if invitation.failed_attempts >= MAX_FAILED_CODES {
                state.invitation = None;
            }
            return Err((StatusCode::GONE, "配对码不存在或已失效".into()));
        }
        let credential = match credential_kind {
            "secret" => URL_SAFE_NO_PAD
                .decode(invitation.secret.as_bytes())
                .unwrap_or_default(),
            "code" => invitation.code.as_bytes().to_vec(),
            _ => {
                return Err((StatusCode::BAD_REQUEST, "配对凭据类型无效".into()));
            }
        };
        let canonical = pairing_proof_message(
            mode,
            &invitation.code,
            &clean_field(&input.device_id, 128),
            &input.client_public_key,
            &input.request_nonce,
        );
        if !verify_hmac(&credential, canonical.as_bytes(), input.proof.as_deref()) {
            invitation.failed_attempts = invitation.failed_attempts.saturating_add(1);
            if invitation.failed_attempts >= MAX_FAILED_CODES {
                state.invitation = None;
            }
            return Err((StatusCode::UNAUTHORIZED, "配对凭据校验失败".into()));
        }
        credential
    } else {
        Vec::new()
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let poll_token = generate_secret();
    let expires_at = unix_timestamp_ms().saturating_add(PAIRING_TTL_MS);
    let verification_code = verification_code(shared.as_bytes(), &request_id);
    let pairing_key =
        derive_pairing_key(shared.as_bytes(), &credential_material, &request_id, mode);
    let public = PendingLanPairing {
        request_id: request_id.clone(),
        device_name: clean_field(&input.device_name, 80),
        browser: clean_field(input.browser.as_deref().unwrap_or("手机浏览器"), 120),
        platform: clean_field(input.platform.as_deref().unwrap_or("未知系统"), 80),
        remote_address: remote_ip.to_string(),
        requested_at: unix_timestamp_ms(),
        expires_at,
        verification_code: verification_code.clone(),
        mode: mode.into(),
    };
    state.requests.insert(
        request_id.clone(),
        PairingRequestRecord {
            public,
            poll_token_digest: digest_token(&poll_token),
            pairing_key,
            status: PairingRequestStatus::Pending,
            encrypted_payload: None,
        },
    );
    Ok(PairingRequestAccepted {
        request_id,
        poll_token,
        server_public_key: URL_SAFE_NO_PAD.encode(server_public.as_bytes()),
        verification_code,
        expires_at,
    })
}

fn pending_requests(state: &LanPairingState) -> Vec<PendingLanPairing> {
    let mut items = state
        .requests
        .values()
        .filter(|request| request.status == PairingRequestStatus::Pending)
        .map(|request| request.public.clone())
        .collect::<Vec<_>>();
    items.sort_by_key(|request| std::cmp::Reverse(request.requested_at));
    items
}

fn purge_expired(state: &mut LanPairingState) {
    let now = unix_timestamp_ms();
    if state
        .invitation
        .as_ref()
        .is_some_and(|invitation| invitation.expires_at <= now)
    {
        state.invitation = None;
    }
    state
        .requests
        .retain(|_, request| request.public.expires_at > now);
    state.attempts.retain(|_, attempts| {
        while attempts
            .front()
            .is_some_and(|timestamp| *timestamp <= now.saturating_sub(PAIRING_RATE_WINDOW_MS))
        {
            attempts.pop_front();
        }
        !attempts.is_empty()
    });
}

fn accept_attempt(state: &mut LanPairingState, ip: IpAddr) -> bool {
    let now = unix_timestamp_ms();
    let attempts = state.attempts.entry(ip).or_default();
    while attempts
        .front()
        .is_some_and(|timestamp| *timestamp <= now.saturating_sub(PAIRING_RATE_WINDOW_MS))
    {
        attempts.pop_front();
    }
    if attempts.len() >= PAIRING_RATE_LIMIT {
        return false;
    }
    attempts.push_back(now);
    true
}

fn generate_pairing_code() -> String {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let value = u32::from_be_bytes(bytes[..4].try_into().unwrap_or_default()) % 1_000_000;
    format!("{value:06}")
}

fn pairing_proof_message(
    mode: &str,
    code: &str,
    device_id: &str,
    client_public_key: &str,
    request_nonce: &str,
) -> String {
    format!(
        "codex-compass-lan-pairing-proof-v1\n{mode}\n{code}\n{device_id}\n{client_public_key}\n{request_nonce}"
    )
}

fn verify_hmac(key: &[u8], message: &[u8], proof: Option<&str>) -> bool {
    let Some(proof) = proof.and_then(|value| URL_SAFE_NO_PAD.decode(value).ok()) else {
        return false;
    };
    let Ok(mut mac) = <HmacSha256 as Mac>::new_from_slice(key) else {
        return false;
    };
    mac.update(message);
    mac.verify_slice(&proof).is_ok()
}

fn derive_pairing_key(
    shared_secret: &[u8; 32],
    credential: &[u8],
    request_id: &str,
    mode: &str,
) -> [u8; 32] {
    let credential_digest = Sha256::digest(credential);
    let mut digest = Sha256::new();
    digest.update(b"codex-compass-lan-pairing-key-v1\0");
    digest.update(shared_secret);
    digest.update(credential_digest);
    digest.update(request_id.as_bytes());
    digest.update([0]);
    digest.update(mode.as_bytes());
    digest.finalize().into()
}

fn verification_code(shared_secret: &[u8; 32], request_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"codex-compass-lan-pairing-verify-v1\0");
    digest.update(shared_secret);
    digest.update(request_id.as_bytes());
    let bytes = digest.finalize();
    let value = u32::from_be_bytes(bytes[..4].try_into().unwrap_or_default()) % 1_000_000;
    format!("{value:06}")
}

fn encrypt_pairing_payload(
    key: &[u8; 32],
    request_id: &str,
    plaintext: &[u8],
) -> Result<EncryptedPairingPayload, String> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| "无法初始化局域网配对加密".to_string())?;
    let nonce_uuid = uuid::Uuid::new_v4();
    let nonce = &nonce_uuid.as_bytes()[..12];
    let aad = format!("codex-compass-lan-pairing-payload-v1\n{request_id}");
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "无法加密局域网配对凭据".to_string())?;
    Ok(EncryptedPairingPayload {
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        aad,
    })
}

fn digest_token(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn bearer_token(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("")
}

fn decode_fixed<const N: usize>(value: &str) -> Option<[u8; N]> {
    URL_SAFE_NO_PAD.decode(value).ok()?.try_into().ok()
}

fn clean_code(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    (value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_digit())).then(|| value.to_string())
}

fn clean_field(value: &str, max_chars: usize) -> String {
    let cleaned = value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect::<String>();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "未命名设备".into()
    } else {
        trimmed.to_string()
    }
}

fn forbidden_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({"error": "仅允许同一局域网设备访问"})),
    )
        .into_response()
}

pub fn discover_lan_pairing_urls(port: u16, allow_tailscale: bool) -> Vec<String> {
    let mut addresses = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .map(|interface| interface.ip())
        .filter(|ip| is_allowed_lan_client(*ip, allow_tailscale))
        .collect::<Vec<_>>();
    addresses.push(IpAddr::V4(Ipv4Addr::LOCALHOST));
    addresses.sort_by_key(|ip| (ip.is_loopback(), ip.to_string()));
    addresses.dedup();
    addresses
        .into_iter()
        .map(|ip| match ip {
            IpAddr::V4(ip) => format!("http://{ip}:{port}/pair"),
            IpAddr::V6(ip) => format!("http://[{ip}]:{port}/pair"),
        })
        .collect()
}

pub fn is_allowed_lan_client(ip: IpAddr, allow_tailscale: bool) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || (allow_tailscale && is_cgnat(ip))
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unicast_link_local()
                || is_unique_local(ip)
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|ipv4| is_allowed_lan_client(IpAddr::V4(ipv4), allow_tailscale))
        }
    }
}

fn is_cgnat(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

fn is_unique_local(ip: Ipv6Addr) -> bool {
    ip.segments()[0] & 0xfe00 == 0xfc00
}

pub async fn stop_runtime_task(task: LanPairingRuntimeTask) {
    let _ = task.stop.send(true);
    let mut handle = task.handle;
    if tokio::time::timeout(Duration::from_secs(3), &mut handle)
        .await
        .is_err()
    {
        handle.abort();
        let _ = handle.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_client_ranges_are_restricted() {
        assert!(is_allowed_lan_client("127.0.0.1".parse().unwrap(), false));
        assert!(is_allowed_lan_client(
            "192.168.1.10".parse().unwrap(),
            false
        ));
        assert!(is_allowed_lan_client("10.1.2.3".parse().unwrap(), false));
        assert!(!is_allowed_lan_client("8.8.8.8".parse().unwrap(), true));
        assert!(!is_allowed_lan_client(
            "100.96.0.42".parse().unwrap(),
            false
        ));
        assert!(is_allowed_lan_client("100.96.0.42".parse().unwrap(), true));
        assert!(is_allowed_lan_client("fd00::1".parse().unwrap(), false));
    }

    #[test]
    fn pairing_key_and_verification_are_deterministic() {
        let shared = [7_u8; 32];
        let first = derive_pairing_key(&shared, b"secret", "request", "invite");
        let second = derive_pairing_key(&shared, b"secret", "request", "invite");
        assert_eq!(first, second);
        assert_eq!(verification_code(&shared, "request").len(), 6);
    }

    #[test]
    fn hmac_proof_rejects_tampering() {
        let key = b"pairing-secret";
        let message = b"pairing-request";
        let mut mac = <HmacSha256 as Mac>::new_from_slice(key).unwrap();
        mac.update(message);
        let proof = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        assert!(verify_hmac(key, message, Some(&proof)));
        assert!(!verify_hmac(key, b"other", Some(&proof)));
    }

    #[test]
    fn encrypted_pairing_payload_round_trips() {
        let key = [9_u8; 32];
        let encrypted = encrypt_pairing_payload(&key, "request", b"credentials").unwrap();
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&URL_SAFE_NO_PAD.decode(encrypted.nonce).unwrap()),
                Payload {
                    msg: &URL_SAFE_NO_PAD.decode(encrypted.ciphertext).unwrap(),
                    aad: encrypted.aad.as_bytes(),
                },
            )
            .unwrap();
        assert_eq!(plaintext, b"credentials");
    }

    #[tokio::test]
    async fn invited_device_requires_approval_and_receives_encrypted_credentials() {
        let manager = LanPairingManager::new();
        let mut settings = RemoteSettings::default();
        settings.enabled = true;
        settings.lan_pairing_enabled = true;
        manager
            .start_runtime(&settings, vec!["http://192.168.1.20:4179/pair".into()])
            .await;
        let invitation = manager.create_invitation().await.unwrap();
        let invitation_secret = {
            manager
                .state
                .lock()
                .await
                .invitation
                .as_ref()
                .unwrap()
                .secret
                .clone()
        };

        let client_secret = StaticSecret::random();
        let client_public = PublicKey::from(&client_secret);
        let client_public_key = URL_SAFE_NO_PAD.encode(client_public.as_bytes());
        let request_nonce = URL_SAFE_NO_PAD.encode([3_u8; 16]);
        let device_id = "phone-device";
        let canonical = pairing_proof_message(
            "invite",
            &invitation.code,
            device_id,
            &client_public_key,
            &request_nonce,
        );
        let credential = URL_SAFE_NO_PAD.decode(invitation_secret).unwrap();
        let mut mac = <HmacSha256 as Mac>::new_from_slice(&credential).unwrap();
        mac.update(canonical.as_bytes());
        let proof = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        let accepted = create_pairing_request(
            &manager,
            "192.168.1.55".parse().unwrap(),
            PairingRequestInput {
                mode: "invite".into(),
                code: Some(invitation.code),
                credential_kind: Some("secret".into()),
                proof: Some(proof),
                client_public_key,
                request_nonce,
                device_id: device_id.into(),
                device_name: "测试手机".into(),
                browser: Some("Chrome".into()),
                platform: Some("Android".into()),
            },
        )
        .await
        .unwrap();

        assert_eq!(manager.snapshot().await.pending_requests.len(), 1);
        manager.approve(&accepted.request_id).await.unwrap();
        let state = manager.state.lock().await;
        assert!(state.invitation.is_none());
        let request = state.requests.get(&accepted.request_id).unwrap();
        assert_eq!(request.status, PairingRequestStatus::Approved);
        let server_public =
            PublicKey::from(decode_fixed::<32>(&accepted.server_public_key).unwrap());
        let shared = client_secret.diffie_hellman(&server_public);
        assert_eq!(
            accepted.verification_code,
            verification_code(shared.as_bytes(), &accepted.request_id)
        );
        let key = derive_pairing_key(
            shared.as_bytes(),
            &credential,
            &accepted.request_id,
            "invite",
        );
        let encrypted = request.encrypted_payload.as_ref().unwrap();
        let plaintext = Aes256Gcm::new_from_slice(&key)
            .unwrap()
            .decrypt(
                Nonce::from_slice(&URL_SAFE_NO_PAD.decode(&encrypted.nonce).unwrap()),
                Payload {
                    msg: &URL_SAFE_NO_PAD.decode(&encrypted.ciphertext).unwrap(),
                    aad: encrypted.aad.as_bytes(),
                },
            )
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&plaintext).unwrap();
        assert_eq!(payload["roomId"], settings.room_id);
        assert_eq!(payload["desktopDeviceId"], settings.desktop_device_id);
        assert_eq!(payload["token"], settings.access_token);
    }

    #[tokio::test]
    async fn expired_or_overused_pairing_requests_are_rejected() {
        let manager = LanPairingManager::new();
        let mut settings = RemoteSettings::default();
        settings.enabled = true;
        settings.lan_pairing_enabled = true;
        manager
            .start_runtime(&settings, vec!["http://127.0.0.1:4179/pair".into()])
            .await;
        manager.create_invitation().await.unwrap();
        {
            let mut state = manager.state.lock().await;
            state.invitation.as_mut().unwrap().expires_at = 0;
        }
        assert!(manager.snapshot().await.invitation.is_none());

        let mut state = manager.state.lock().await;
        let ip = "192.168.1.9".parse().unwrap();
        for _ in 0..PAIRING_RATE_LIMIT {
            assert!(accept_attempt(&mut state, ip));
        }
        assert!(!accept_attempt(&mut state, ip));
    }

    #[tokio::test]
    async fn embedded_lan_server_serves_only_pairing_surface() {
        let manager = LanPairingManager::new();
        let mut settings = RemoteSettings::default();
        settings.enabled = true;
        settings.lan_pairing_enabled = true;
        let (runtime, urls) = start_server(0, false, manager, &settings).await.unwrap();
        let local_url = urls
            .iter()
            .find(|url| url.contains("127.0.0.1"))
            .unwrap()
            .trim_end_matches("/pair")
            .to_string();
        let client = reqwest::Client::new();
        let health: serde_json::Value = client
            .get(format!("{local_url}/healthz"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["ok"], true);
        let page = client
            .get(format!("{local_url}/pair"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(page.contains("局域网设备配对"));
        assert!(!page.contains(&settings.access_token));
        assert!(!page.contains(&settings.encryption_key));
        stop_runtime_task(runtime).await;
    }
}
