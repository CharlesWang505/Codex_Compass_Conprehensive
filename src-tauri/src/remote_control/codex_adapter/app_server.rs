use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, RwLock, broadcast, oneshot};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const WINDOWS_REMOTE_SANDBOX_OVERRIDE: &str = r#"windows.sandbox="unelevated""#;

#[derive(Debug, Clone)]
pub struct AppServerEvent {
    pub method: String,
    pub params: Value,
}

type PendingRequests = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

#[derive(Clone)]
pub struct AppServerClient {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Option<Child>>>,
    next_id: Arc<AtomicU64>,
    pending: PendingRequests,
    events: broadcast::Sender<AppServerEvent>,
    version: Arc<RwLock<String>>,
}

impl AppServerClient {
    pub async fn start() -> Result<Self, String> {
        let codex = codex_binary();
        let version = command_output(&codex, &["--version"]).await?;
        let mut command = Command::new(&codex);
        command
            .args(app_server_args())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command
            .spawn()
            .map_err(|_| "无法启动 Codex app-server".to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法连接 app-server 输入流".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法连接 app-server 输出流".to_string())?;
        let stderr = child.stderr.take();
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(1024);
        let client = Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(Some(child))),
            next_id: Arc::new(AtomicU64::new(1)),
            pending: pending.clone(),
            events: events.clone(),
            version: Arc::new(RwLock::new(version.trim().to_string())),
        };

        let reader_client = client.clone();
        tokio::spawn(async move {
            reader_loop(stdout, reader_client, pending, events).await;
        });
        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(_line)) = lines.next_line().await {
                    // app-server stderr can contain provider details; never forward it.
                }
            });
        }

        client
            .request(
                "initialize",
                json!({
                    "clientInfo": {"name": "codex-compass", "title": "Codex Compass", "version": env!("CARGO_PKG_VERSION")},
                    "capabilities": {"experimentalApi": false}
                }),
            )
            .await?;
        client.notify("initialized", json!({})).await?;
        Ok(client)
    }

    pub async fn version(&self) -> String {
        self.version.read().await.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppServerEvent> {
        self.events.subscribe()
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if let Err(error) = self
            .write(&json!({"id": id, "method": method, "params": params}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(std::time::Duration::from_secs(60), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("app-server 请求已断开：{method}")),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("app-server 请求超时：{method}"))
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(&json!({"method": method, "params": params}))
            .await
    }

    async fn write(&self, value: &Value) -> Result<(), String> {
        let mut bytes =
            serde_json::to_vec(value).map_err(|_| "无法编码 app-server 消息".to_string())?;
        bytes.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|_| "app-server 连接已断开".to_string())?;
        stdin
            .flush()
            .await
            .map_err(|_| "app-server 连接已断开".to_string())
    }

    pub async fn account_status(&self) -> Result<Value, String> {
        self.request("account/read", json!({"refreshToken": false}))
            .await
    }

    pub async fn list_all_sessions(&self, archived: bool) -> Result<Vec<Value>, String> {
        self.list_sessions_inner(None, archived).await
    }

    async fn list_sessions_inner(
        &self,
        workspaces: Option<&[String]>,
        archived: bool,
    ) -> Result<Vec<Value>, String> {
        const MAX_SESSION_PAGES: usize = 100;
        const SESSION_PAGE_SIZE: u32 = 100;

        let mut sessions = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_SESSION_PAGES {
            let mut params = json!({
                "archived": archived,
                "cursor": cursor,
                "limit": SESSION_PAGE_SIZE,
                "sortKey": "updated_at",
                "sortDirection": "desc",
                "useStateDbOnly": true
            });
            if let Some(workspaces) = workspaces {
                params["cwd"] = json!(workspaces);
            }
            let response = self.request("thread/list", params).await?;
            if let Some(page) = response.get("data").and_then(Value::as_array) {
                sessions.extend(page.iter().cloned());
            }
            let next_cursor = response
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if next_cursor.is_none() || next_cursor == cursor {
                return Ok(sessions);
            }
            cursor = next_cursor;
        }

        Err("app-server 会话分页超过安全上限".to_string())
    }

    pub async fn list_models(&self) -> Result<Value, String> {
        const MAX_MODEL_PAGES: usize = 20;
        let mut models = Vec::new();
        let mut cursor: Option<String> = None;

        for _ in 0..MAX_MODEL_PAGES {
            let response = self
                .request(
                    "model/list",
                    json!({"cursor": cursor, "limit": 100, "includeHidden": false}),
                )
                .await?;
            if let Some(page) = response.get("data").and_then(Value::as_array) {
                models.extend(page.iter().cloned());
            }
            let next_cursor = response
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if next_cursor.is_none() || next_cursor == cursor {
                return Ok(json!({"data": models, "nextCursor": null}));
            }
            cursor = next_cursor;
        }

        Err("app-server 模型分页超过安全上限".to_string())
    }

    pub async fn list_skills(&self, cwd: &str) -> Result<Value, String> {
        self.request("skills/list", json!({"cwds": [cwd], "forceReload": false}))
            .await
    }

    pub async fn list_installed_plugins(&self, cwd: &str) -> Result<Value, String> {
        self.request(
            "plugin/installed",
            json!({"cwds": [cwd], "installSuggestionPluginNames": []}),
        )
        .await
    }

    pub async fn create_session(
        &self,
        cwd: &str,
        writable: bool,
        allow_commands: bool,
        model: Option<&str>,
    ) -> Result<Value, String> {
        self.request(
            "thread/start",
            json!({
                "cwd": cwd,
                "model": model,
                "sandbox": if writable { "workspace-write" } else { "read-only" },
                "approvalPolicy": if allow_commands { "on-request" } else { "never" },
                "developerInstructions": "This is a remote Codex Compass session. Stay inside the authorized workspace. Never access credentials or paths outside it. High-risk approvals are denied by the desktop host."
            }),
        )
        .await
    }

    pub async fn resume_session(
        &self,
        thread_id: &str,
        cwd: &str,
        writable: bool,
        allow_commands: bool,
    ) -> Result<Value, String> {
        self.request(
            "thread/resume",
            json!({
                "threadId": thread_id,
                "cwd": cwd,
                "sandbox": if writable { "workspace-write" } else { "read-only" },
                "approvalPolicy": if allow_commands { "on-request" } else { "never" },
                "developerInstructions": "This thread is being continued through Codex Compass remote control. Stay inside the authorized workspace. Never access credentials or paths outside it. Follow the desktop workspace permissions for every turn."
            }),
        )
        .await
    }

    pub async fn send_message(
        &self,
        thread_id: &str,
        cwd: &str,
        writable: bool,
        allow_commands: bool,
        input: Vec<Value>,
    ) -> Result<Value, String> {
        let sandbox_policy = if writable {
            json!({
                "type": "workspaceWrite",
                "writableRoots": [cwd],
                "networkAccess": false
            })
        } else {
            json!({
                "type": "readOnly",
                "networkAccess": false
            })
        };
        self.request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": input,
                "cwd": cwd,
                "sandboxPolicy": sandbox_policy,
                "approvalPolicy": if allow_commands { "on-request" } else { "never" }
            }),
        )
        .await
    }

    pub async fn interrupt(&self, thread_id: &str, turn_id: &str) -> Result<Value, String> {
        self.request(
            "turn/interrupt",
            json!({"threadId": thread_id, "turnId": turn_id}),
        )
        .await
    }

    pub async fn stop(&self) {
        let child = self.child.lock().await.take();
        if let Some(mut child) = child {
            {
                let mut stdin = self.stdin.lock().await;
                let _ = stdin.shutdown().await;
            }
            if tokio::time::timeout(std::time::Duration::from_secs(2), child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }
    }
}

async fn reader_loop(
    stdout: tokio::process::ChildStdout,
    client: AppServerClient,
    pending: PendingRequests,
    events: broadcast::Sender<AppServerEvent>,
) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(request_id) = message.get("id").cloned() {
            if message.get("method").is_some() {
                reject_server_request(
                    &client,
                    request_id,
                    message.get("method").and_then(Value::as_str).unwrap_or(""),
                )
                .await;
            } else if let Some(id) = request_id.as_u64()
                && let Some(sender) = pending.lock().await.remove(&id)
            {
                let result = if let Some(error) = message.get("error") {
                    Err(error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("app-server 请求失败")
                        .to_string())
                } else {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = sender.send(result);
            }
            continue;
        }
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            let _ = events.send(AppServerEvent {
                method: method.to_string(),
                params: message.get("params").cloned().unwrap_or(Value::Null),
            });
        }
    }
    let mut pending = pending.lock().await;
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err("app-server 已断开".to_string()));
    }
    let _ = events.send(AppServerEvent {
        method: "server/disconnected".into(),
        params: Value::Null,
    });
}

async fn reject_server_request(client: &AppServerClient, id: Value, method: &str) {
    let result = match method {
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "applyPatchApproval"
        | "execCommandApproval" => json!({"decision": "decline"}),
        "item/tool/requestUserInput" => json!({"answers": {}}),
        "item/permissions/requestApproval" => json!({"permissions": {}, "scope": "turn"}),
        _ => {
            let _ = client.write(&json!({"id": id, "error": {"code": -32601, "message": "Remote approval is not supported"}})).await;
            return;
        }
    };
    let _ = client.write(&json!({"id": id, "result": result})).await;
}

fn codex_binary() -> String {
    std::env::var("CODEX_BIN").unwrap_or_else(|_| "codex".to_string())
}

fn app_server_args() -> Vec<&'static str> {
    let mut args = Vec::new();
    #[cfg(windows)]
    {
        // Standalone codex.exe installations may not ship the elevated sandbox helper.
        // Keep remote sessions sandboxed while avoiding a dependency on that external helper.
        args.extend(["-c", WINDOWS_REMOTE_SANDBOX_OVERRIDE]);
    }
    args.extend(["app-server", "--stdio"]);
    args
}

async fn command_output(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .await
        .map_err(|_| "找不到 Codex CLI".to_string())?;
    if !output.status.success() {
        return Err("无法读取 Codex CLI 版本".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_server_uses_a_windows_sandbox_without_the_external_setup_helper() {
        let args = app_server_args();
        assert!(args.ends_with(&["app-server", "--stdio"]));
        #[cfg(windows)]
        assert_eq!(&args[..2], &["-c", r#"windows.sandbox="unelevated""#]);
    }
}
