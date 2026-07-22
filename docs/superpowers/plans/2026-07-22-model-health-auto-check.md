# 模型自动自检实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Codex Compass 运行期间，默认关闭地提供“启动后立即检测、之后每 10 分钟检测全部可检测供应商模型”的自动自检，并仅在首次失败、故障和恢复时通知。

**Architecture:** 在 `codex-plus-core` 中增加纯模型筛选和状态转换逻辑，在 Tauri 应用层增加持有运行状态、定时任务和事件发送的 `ModelHealthManager`。前端通过三个 Tauri 命令读取、切换和手动触发自检，通过事件实时更新紧凑状态面板。

**Tech Stack:** Rust 2024、Tokio、Tauri 2、Serde、futures-util、React 19、TypeScript、Node test runner。

---

### Task 1: 设置字段与核心检测模型

**Files:**
- Modify: `src-tauri/codex-plus/crates/codex-plus-core/src/settings.rs`
- Modify: `src-tauri/codex-plus/crates/codex-plus-core/src/lib.rs`
- Create: `src-tauri/codex-plus/crates/codex-plus-core/src/model_health.rs`
- Create: `src-tauri/codex-plus/crates/codex-plus-core/tests/model_health.rs`

- [ ] **Step 1: 编写设置默认值和兼容读取失败测试**

在 `settings.rs` 测试中加入：

```rust
#[test]
fn model_health_check_is_disabled_by_default() {
    assert!(!BackendSettings::default().model_health_check_enabled);
}

#[test]
fn settings_without_model_health_flag_remain_compatible() {
    let settings: BackendSettings = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(!settings.model_health_check_enabled);
}
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
cargo test -p codex-plus-core model_health_check_is_disabled_by_default
```

Expected: FAIL，`BackendSettings` 不存在 `model_health_check_enabled`。

- [ ] **Step 3: 增加设置字段**

在 `BackendSettings` 中增加：

```rust
#[serde(rename = "modelHealthCheckEnabled", default)]
pub model_health_check_enabled: bool,
```

并在 `Default` 中设为：

```rust
model_health_check_enabled: false,
```

- [ ] **Step 4: 编写供应商筛选和状态转换失败测试**

在 `tests/model_health.rs` 覆盖：

```rust
#[test]
fn resolves_test_model_before_profile_and_global_model() {
    let target = resolve_probe_target(&profile("custom-test", "default-model"), "global-model");
    assert_eq!(target.model, "custom-test");
}

#[test]
fn skips_aggregate_and_official_account_only_profiles() {
    assert_eq!(resolve_probe_target(&aggregate_profile(), "gpt-5").status, ProbeTargetStatus::Skipped);
    assert_eq!(resolve_probe_target(&official_profile(), "gpt-5").status, ProbeTargetStatus::Skipped);
}

#[test]
fn first_failure_notifies_but_first_success_does_not() {
    assert_eq!(
        transition_for(None, ModelHealthAvailability::Unavailable),
        Some(ModelHealthTransition::Failed),
    );
    assert_eq!(transition_for(None, ModelHealthAvailability::Available), None);
}

#[test]
fn repeated_status_does_not_notify_and_recovery_does() {
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
}
```

- [ ] **Step 5: 运行核心测试并确认失败**

Run:

```powershell
cargo test -p codex-plus-core --test model_health
```

Expected: FAIL，`model_health` 模块和函数尚不存在。

- [ ] **Step 6: 实现纯核心逻辑**

`model_health.rs` 定义：

```rust
pub const MODEL_HEALTH_INTERVAL: Duration = Duration::from_secs(10 * 60);
pub const MODEL_HEALTH_MAX_CONCURRENCY: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelHealthAvailability {
    Available,
    Unavailable,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelHealthTransition {
    Failed,
    Recovered,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelHealthProbeTarget {
    pub relay_id: String,
    pub relay_name: String,
    pub model: String,
    pub status: ProbeTargetStatus,
    pub detail: String,
}

pub fn resolve_probe_target(
    profile: &RelayProfile,
    global_test_model: &str,
) -> ModelHealthProbeTarget;

pub fn transition_for(
    previous: Option<ModelHealthAvailability>,
    next: ModelHealthAvailability,
) -> Option<ModelHealthTransition>;
```

模型顺序为 `test_model -> relay_profile_model(profile) -> global_test_model`。聚合、仅官方账号、配置缺失返回跳过目标。

- [ ] **Step 7: 运行核心测试并确认通过**

Run:

```powershell
cargo test -p codex-plus-core --test model_health
cargo test -p codex-plus-core settings
```

Expected: PASS。

- [ ] **Step 8: 提交核心逻辑**

```powershell
git add src-tauri/codex-plus/crates/codex-plus-core/src/lib.rs src-tauri/codex-plus/crates/codex-plus-core/src/settings.rs src-tauri/codex-plus/crates/codex-plus-core/src/model_health.rs src-tauri/codex-plus/crates/codex-plus-core/tests/model_health.rs
git commit -m "feat: add model health core"
```

### Task 2: Tauri 后端调度器和命令

**Files:**
- Create: `src-tauri/src/model_health.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/model_health.rs`

- [ ] **Step 1: 编写运行状态和通知聚合失败测试**

在模块测试中覆盖：

```rust
#[test]
fn snapshot_counts_available_unavailable_and_skipped_results() {
    let snapshot = snapshot_from_results(true, false, 1000, vec![
        result("a", ModelHealthAvailability::Available),
        result("b", ModelHealthAvailability::Unavailable),
        result("c", ModelHealthAvailability::Skipped),
    ]);
    assert_eq!(snapshot.available_count, 1);
    assert_eq!(snapshot.unavailable_count, 1);
    assert_eq!(snapshot.skipped_count, 1);
}

#[test]
fn failure_notification_takes_priority_and_includes_recovery_count() {
    let message = notification_message(&[
        change("A", "gpt-a", ModelHealthTransition::Failed),
        change("B", "gpt-b", ModelHealthTransition::Recovered),
    ]).unwrap();
    assert_eq!(message.tone, "error");
    assert!(message.text.contains("A"));
    assert!(message.text.contains("另有 1 个模型已恢复"));
}
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
cargo test -p codex-compass model_health
```

Expected: FAIL，Tauri 模型健康模块尚不存在。

- [ ] **Step 3: 实现 `ModelHealthManager`**

管理器主要结构：

```rust
#[derive(Clone)]
pub struct ModelHealthManager {
    app: AppHandle,
    state: Arc<RwLock<ModelHealthRuntimeState>>,
    run_lock: Arc<Mutex<()>>,
    wake: Arc<Notify>,
}

impl ModelHealthManager {
    pub fn new(app: AppHandle) -> Self;
    pub fn start(self);
    pub async fn snapshot(&self) -> ModelHealthSnapshot;
    pub async fn set_enabled(&self, enabled: bool) -> Result<ModelHealthSnapshot, String>;
    pub async fn run_now(&self) -> Result<ModelHealthSnapshot, String>;
}
```

`start` 启动单个长期任务：

```rust
loop {
    let settings = SettingsStore::default().load().unwrap_or_default();
    if !settings.model_health_check_enabled {
        manager.wake.notified().await;
        continue;
    }
    let _ = manager.run_now().await;
    tokio::select! {
        _ = tokio::time::sleep(MODEL_HEALTH_INTERVAL) => {}
        _ = manager.wake.notified() => {}
    }
}
```

`run_now` 使用 `try_lock` 防止重叠，读取最新设置，以 `buffer_unordered(3)` 执行真实检测，并把响应裁剪为不含正文的安全摘要。

- [ ] **Step 4: 实现命令和事件**

新增命令：

```rust
#[tauri::command]
pub async fn get_model_health_status(
    manager: State<'_, ModelHealthManager>,
) -> Result<ModelHealthSnapshot, String>;

#[tauri::command]
pub async fn run_model_health_check_now(
    manager: State<'_, ModelHealthManager>,
) -> Result<ModelHealthSnapshot, String>;

#[tauri::command]
pub async fn set_model_health_check_enabled(
    manager: State<'_, ModelHealthManager>,
    enabled: bool,
) -> Result<ModelHealthSnapshot, String>;
```

每轮完成发送 `model-health-check:updated`。有失败变化时发送 `model-health-check:failed`；只有恢复变化时发送 `model-health-check:recovered`。

- [ ] **Step 5: 注册管理器和命令**

在 `lib.rs`：

```rust
mod model_health;
```

非隐藏 watcher 模式下：

```rust
let model_health = model_health::ModelHealthManager::new(app.handle().clone());
model_health.clone().start();
app.manage(model_health);
```

将三个命令加入 `tauri::generate_handler!`。

- [ ] **Step 6: 运行后端测试并确认通过**

Run:

```powershell
cargo test -p codex-compass model_health
cargo test -p codex-plus-core --test model_health
cargo check -p codex-compass
```

Expected: PASS。

- [ ] **Step 7: 提交 Tauri 调度器**

```powershell
git add src-tauri/src/model_health.rs
git add -p src-tauri/src/lib.rs
git commit -m "feat: schedule model health checks"
```

### Task 3: 前端状态模型与面板

**Files:**
- Modify: `src/features/codex/types.ts`
- Create: `src/features/codex/providers/modelHealth.ts`
- Create: `src/features/codex/providers/ModelHealthPanel.tsx`
- Modify: `src/features/codex/CodexWorkspace.tsx`
- Modify: `src/features/codex/CodexWorkspace.css`
- Modify: `tests/codex-ui-logic.test.mjs`

- [ ] **Step 1: 编写前端状态摘要失败测试**

在 `tests/codex-ui-logic.test.mjs` 加入：

```javascript
test('model health summary preserves counts and paused state', () => {
  assert.equal(modelHealthSummary({
    enabled: false,
    checking: false,
    paused: true,
    availableCount: 0,
    unavailableCount: 0,
    skippedCount: 0,
  }), '已关闭')
})

test('model health timestamp renders a stable local label', () => {
  assert.equal(modelHealthTimestamp(null), '尚未检测')
  assert.match(modelHealthTimestamp(Date.parse('2026-07-22T12:00:00Z')), /\d{2}:\d{2}/)
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
npm.cmd run test:codex-ui
```

Expected: FAIL，`modelHealthSummary` 和 `modelHealthTimestamp` 尚不存在。

- [ ] **Step 3: 实现前端类型和纯辅助函数**

在 `types.ts` 增加：

```ts
export type ModelHealthResult = {
  relayId: string
  relayName: string
  model: string
  status: 'available' | 'unavailable' | 'skipped'
  detail: string
  checkedAt: number | null
}

export type ModelHealthSnapshot = {
  enabled: boolean
  checking: boolean
  paused: boolean
  lastCheckedAt: number | null
  availableCount: number
  unavailableCount: number
  skippedCount: number
  results: ModelHealthResult[]
  error: string | null
}
```

在 `modelHealth.ts` 导出 `modelHealthSummary` 和 `modelHealthTimestamp`。

- [ ] **Step 4: 运行纯前端测试并确认通过**

Run:

```powershell
npm.cmd run test:codex-ui
```

Expected: PASS。

- [ ] **Step 5: 实现紧凑状态面板**

`ModelHealthPanel` 接收：

```ts
type Props = {
  snapshot: ModelHealthSnapshot | null
  busy: boolean
  onToggle: (enabled: boolean) => void
  onRunNow: () => void
}
```

面板显示开关、固定间隔、立即检测按钮、最近检测时间、三个统计数字和供应商结果列表。状态使用现有 `StatusPill`，按钮使用 Lucide `Activity`、`RefreshCw` 图标。

- [ ] **Step 6: 接入 Tauri 命令和事件**

在 `CodexWorkspace` 中：

- 进入供应商配置时调用 `get_model_health_status`。
- 监听 `model-health-check:updated` 更新快照。
- 监听 `model-health-check:failed` 显示错误通知。
- 监听 `model-health-check:recovered` 显示成功通知。
- 开关调用 `set_model_health_check_enabled`。
- 立即检测调用 `run_model_health_check_now`。
- 在供应商编辑区顶部渲染 `ModelHealthPanel`。

- [ ] **Step 7: 添加响应式样式**

在 `CodexWorkspace.css` 增加 `.model-health-*` 规则，桌面统计同排，窄窗口改为两列；结果行不创建独立滚动条，长模型名可换行。

- [ ] **Step 8: 运行前端验证**

Run:

```powershell
npm.cmd run test:codex-ui
npm.cmd run build
npm.cmd run lint
```

Expected: 测试和构建 PASS；lint 无新增错误。

- [ ] **Step 9: 提交前端**

```powershell
git add src/features/codex/types.ts src/features/codex/providers/modelHealth.ts src/features/codex/providers/ModelHealthPanel.tsx src/features/codex/CodexWorkspace.tsx src/features/codex/CodexWorkspace.css tests/codex-ui-logic.test.mjs
git commit -m "feat: add model health controls"
```

### Task 4: 版本、变更记录与完整验证

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 将版本更新为 1.4.2**

同步修改 npm、Tauri workspace 和 Cargo lock 中的应用版本为 `1.4.2`。

- [ ] **Step 2: 添加变更记录**

在 `CHANGELOG.md` 顶部增加：

```markdown
## [1.4.2] - 2026-07-22

### 模型自动自检

- 新增默认关闭的模型自动自检；开启后立即检测全部可检测供应商，之后每 10 分钟重复。
- 复用真实模型请求，支持测试模型、供应商默认模型和全局测试模型回退。
- 仅在首次失败、故障和恢复时悬浮提示，并展示最近检测时间和供应商状态统计。
- 后端调度不受页面切换或窗口最小化影响，并防止检测轮次重叠。
```

- [ ] **Step 3: 运行完整验证**

Run:

```powershell
cargo fmt --all -- --check
cargo test -p codex-plus-core --test model_health
cargo test -p codex-plus-core
cargo test -p codex-compass model_health
cargo check -p codex-compass
npm.cmd run test:codex-ui
npm.cmd run build
npm.cmd run lint
git diff --check
```

Expected: 全部命令退出码为 0；仅允许项目已有 lint 警告。

- [ ] **Step 4: 审查任务范围**

Run:

```powershell
git status --short --branch
git diff --stat
git diff -- src-tauri/codex-plus/crates/codex-plus-core/src/model_health.rs src-tauri/src/model_health.rs src/features/codex/providers/ModelHealthPanel.tsx
```

确认不包含构建产物、备份、用户本地数据和远程控制或主题文件。

- [ ] **Step 5: 提交版本记录并推送**

只暂存本任务版本行和变更记录，避免纳入工作区已有的其他版本内容：

```powershell
git add -p package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md
git commit -m "release: prepare 1.4.2"
git push
```
