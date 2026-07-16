# Codex app-server 阶段 0 调查与兼容报告

调查日期：2026-07-14
项目版本：Codex Compass 1.3.12
实测 Codex CLI：0.142.5
实测平台：Windows x64

## 1. 阶段 0 结论

用户需要的是复用电脑上当前有效的 Codex 本地认证，不要求强制切换为 ChatGPT 官方账号。实测结果如下：

| 硬性门槛 | 结果 | 证据 |
| --- | --- | --- |
| 创建或继续会话 | 通过 | `thread/start` 创建成功；完成首个回合后 `thread/resume` 成功 |
| 发送消息并获取流式回复 | 通过 | `turn/start` 成功；收到 7 个 `item/agentMessage/delta`，拼接结果与固定预期一致 |
| 停止当前生成 | 通过 | `turn/interrupt` 被接受；`turn/completed` 状态为 `interrupted` |
| 复用本机认证且凭据不离开电脑 | 通过 | `account/read` 返回 `apiKey`；app-server 在本机读取当前认证，探针未读取或导出认证文件 |

使用显式模型 `gpt-5.5` 的探针结果为 `phase0GatePassed: true`。默认模型 `claude-fable-5` 的一次失败来自本机 8787 上游返回 `503 No available channel`，不是 app-server、认证复用或远控协议失败。真实手机端到端验证使用本机模型目录可见的 `gpt-5.6-luna`，创建会话、流式回复、停止生成、已有会话列表、恢复和历史读取均通过。

`officialAccountReusable` 以及 `--require-chatgpt` 仅用于诊断“当前身份是否恰好为 ChatGPT 官方账号”，不是手机远控的功能门槛。`apiKey` 和 `chatgpt` 都属于可复用的本机有效认证。

1.3.6 额外验证了 `skills/list`、`plugin/installed` 和 `turn/start.input` 的原生 `skill`、`localImage` 输入结构。当前 Codex CLI 0.142.5 在目标工作区返回 86 个启用 Skills 和 14 个已安装并启用插件；远控协议只暴露 Skill 名称，路径由桌面适配层重新解析。

## 2. 本机服务与启动方式

Codex 桌面版会启动自己的 `codex.exe ... app-server`，未指定监听地址时使用 stdio。该进程的标准输入输出由父进程持有，Codex Compass 不应旁路接管。

当前适配器启动独立的隐藏窗口子进程。Windows 会对该子进程局部覆盖为
`windows.sandbox="unelevated"`：

```text
codex -c windows.sandbox="unelevated" app-server --stdio
```

Windows 使用无控制台创建标志，进程由 Codex Compass 独占；退出或重连时只停止自己启动的进程。8787 是 Codex Compass 的本地模型网关，不是远控入口，禁止暴露到公网。

该覆盖不修改用户的全局 `config.toml`。原因是独立安装的 `codex.exe` 可能没有同时安装
`codex-windows-sandbox-setup.exe`，当用户全局选择 `windows.sandbox="elevated"` 时，
便携版进程会从自身目录寻找 helper，导致所有 shell 工具调用失败。`unelevated` 仍保留
Codex 的 `workspace-write` / `read-only` 沙箱边界；远控适配器不得改用
`danger-full-access` 作为兼容回退。

CLI 0.142.5 可描述的传输包括 stdio、本地域套接字和 WebSocket。当前实现只采用 stdio，公网只暴露自建中继的 HTTPS/WSS。

## 3. 协议与生命周期

app-server 使用逐行 JSON-RPC 风格消息。连接顺序：

1. 客户端发送 `initialize`。
2. 服务端返回平台、Codex home 和 user agent。
3. 客户端发送 `initialized`。
4. 客户端调用稳定方法。

当前适配器使用：

- `account/read`
- `model/list`（自动按 `nextCursor` 分页，最多 20 页）
- `thread/list`（使用 `archived`、`nextCursor`、`useStateDbOnly`，完整枚举时省略 `cwd`）、`thread/read`
- `thread/start`、`thread/resume`
- `turn/start`、`turn/interrupt`

手机选择的模型必须存在于 app-server 返回的非隐藏模型目录中。刚执行 `thread/start` 的线程尚未产生 rollout 时，立即 `thread/resume` 可能返回 `no rollout found`；至少完成一个回合后再恢复。

CLI 0.142.5 的 `thread/list` 在 2026-07-15 实测可分页读取 293 个未归档会话和 81 个归档会话。远控列表省略 `cwd` 完整遍历 app-server 游标，再读取 `.codex-global-state.json` 中的 `project-order`、`electron-saved-workspace-roots` 和 `thread-workspace-root-hints`，只保留 Codex 左侧正式项目并排除临时 cwd。手机可查看正式项目历史；继续会话、发送消息、附件和 Skills 仍必须通过电脑端工作区授权。

## 4. 事件归一化

业务层和手机端不接触 Codex 原始事件。当前映射包括：

| app-server 0.142.5 | 远控稳定事件 |
| --- | --- |
| `turn/started` | `turn.started` |
| `item/agentMessage/delta` | `response.delta` |
| reasoning delta | `reasoning.delta` |
| `item/commandExecution/outputDelta` | `command.output` |
| `turn/diff/updated` | `file.diff` |
| `thread/tokenUsage/updated` | `usage.updated` |
| `turn/completed: completed` | `response.completed` |
| `turn/completed: interrupted` | `turn.interrupted` |
| 失败或 `error` | `turn.failed` |
| 传输关闭 | `server.disconnected` |

未知事件不会原样透传。当前安全 MVP 不允许手机批准高风险工具调用；未知或高风险审批在电脑端拒绝。

## 5. 认证与凭据边界

独立 app-server 默认读取当前 Windows 用户的 Codex 配置。Codex Compass 只调用 `account/read` 获取脱敏账号类型：

- `apiKey`：复用本机 API 配置。
- `chatgpt`：复用本机 ChatGPT/Codex 登录。
- 其他或空值：显示未登录或不兼容。

项目不读取、复制、序列化或上传 `auth.json`、OAuth Token、Cookie 或 API Key。模型请求由本机 app-server 发起，中继服务器既不持有凭据，也不直接调用 Codex 官方接口。

## 6. 兼容策略与风险

当前经实机确认的版本是 CLI 0.142.5。新版本应先运行阶段 0 探针；初始化、方法或字段不兼容时应显示明确错误，不得回退到鼠标键盘自动化。CDP 不属于当前执行链。

已知风险：

- app-server 仍是随 Codex CLI 演进的接口，升级后可能需要适配。
- 模型是否可执行还取决于本机供应商、8787 路由或官方服务状态。
- 模型目录可见性与直接指定模型可用性可能不同；手机端只允许选择目录中可见模型。
- 当前只完成基础工具事件展示，生产级远程审批策略仍需后续强化。
- Windows 独立 CLI 的 elevated sandbox 依赖外部 helper；1.3.9 远控子进程固定使用
  unelevated sandbox，桌面本地手动使用仍遵循用户自己的全局配置。

## 7. 可重复验证

```powershell
$env:CODEX_PHASE0_MODEL='gpt-5.5'
npm run diagnose:app-server
npm run diagnose:remote-capabilities -- "D:\你的工作区"
```

仅诊断当前身份是否为 ChatGPT 官方账号：

```powershell
node tests/codex-app-server-phase0.mjs --require-chatgpt
```

探针使用临时空工作区、只读沙箱和 `approvalPolicy: never`，自动拒绝审批，隐藏 Windows 子进程窗口，清理测试线程。输出不包含凭据或完整对话。
