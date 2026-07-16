# 手机远控协议 v1

## 1. 分层

通信链路为：

```text
手机 Web -> HTTPS/WSS 中继 -> Codex Compass -> 本机 codex app-server
```

中继协议与 Codex 内部协议相互独立。React 桌面界面和手机 Web 都不直接调用 app-server 原始方法。

## 2. 外层中继帧

```json
{
  "protocolVersion": 1,
  "kind": "relay",
  "roomId": "uuid",
  "senderDeviceId": "uuid",
  "targetDeviceId": "uuid-or-null",
  "messageId": "uuid",
  "sequence": 1,
  "nonce": "base64url",
  "payload": "base64url-ciphertext"
}
```

`protocolVersion`、`kind`、房间、发送方、目标、外层消息 ID 和 sequence 作为 AES-GCM AAD，修改任一字段都会导致解密失败。单帧上限为 512 KiB。

## 3. 认证

连接后的第一条消息是明文路由认证：

```json
{
  "protocolVersion": 1,
  "kind": "auth",
  "role": "desktop",
  "roomId": "uuid",
  "deviceId": "uuid",
  "token": "256-bit-secret"
}
```

`role` 为 `desktop` 或 `mobile`。中继仅在内存中保存 Token 的 SHA-256 摘要，并用恒定时间比较；重启后房间状态消失。桌面只能向同房间手机发送，手机只能向同房间桌面发送。

## 4. 内层消息

解密后的稳定消息格式：

```json
{
  "protocolVersion": 1,
  "messageId": "uuid",
  "timestamp": 1784040000000,
  "requestId": "uuid-or-null",
  "sessionId": "uuid-or-null",
  "turnId": "uuid-or-null",
  "type": "conversation.input",
  "payload": {}
}
```

当前命令：

- `device.status.request`
- `workspace.list`
- `model.list`
- `capability.list`
- `session.list.request`
- `session.create`
- `session.resume`
- `session.history.request`
- `conversation.input`
- `turn.interrupt`

当前结果与事件：

- `device.status`
- `workspace.list.result`
- `model.list.result`
- `capability.list.result`
- `session.list.result`
- `session.created`
- `session.resumed`
- `session.history.result`
- `conversation.accepted`
- `turn.started`
- `response.delta`
- `reasoning.delta`
- `command.output`
- `file.diff`
- `usage.updated`
- `response.completed`
- `turn.interrupted`
- `turn.failed`
- `server.disconnected`
- `error`

错误载荷使用 `{ "code": "...", "message": "可读说明" }`，不发送原始堆栈或 Codex 原始事件。

### 4.1 附件与 Skills

`conversation.input.payload` 可同时包含 `text`、`skills` 和 `attachments`。浏览器先计算附件明文 SHA-256，再使用房间内容密钥和独立随机 nonce 加密文件。密文通过 `POST /api/uploads` 上传；Compass 收到加密描述后通过 `GET /api/uploads/:id` 一次性下载，在电脑端解密、验哈希并写入当前会话的授权工作区。

单文件最大 10 MiB、单次最多 5 个，上传对象 15 分钟过期。手机只发送 Skill 名称；Compass 会针对当前工作区重新调用 `skills/list`，确认 Skill 已安装且启用，再使用本机返回的真实路径构造 app-server 原生 `skill` 输入。

### 4.2 会话列表分页

手机读取会话时发送：

```json
{
  "type": "session.list.request",
  "payload": {
    "cursor": null,
    "limit": 40,
    "status": "active",
    "workspaceId": null,
    "query": ""
  }
}
```

- `status` 为 `active`、`archived` 或 `all`，默认 `active`。
- 会话列表中的 `workspaceId` 筛选值解释为桌面端返回的正式 `projectId`；手机不能传任意路径。
- `query` 在电脑端匹配会话标题、预览、正式项目名称和项目路径。
- `cursor` 是远控协议自己的不透明分页游标，不暴露 Codex app-server 原始游标。
- `limit` 最大为 80，默认 40。

结果为：

```json
{
  "type": "session.list.result",
  "payload": {
    "sessions": [],
    "projects": [],
    "nextCursor": "40",
    "hasMore": true,
    "loaded": 40,
    "total": 293,
    "active": 293,
    "archived": 81,
    "status": "active",
    "query": ""
  }
}
```

桌面端省略 `thread/list.cwd` 完整读取本机会话，再用 Codex 全局状态中的正式项目顺序和线程项目提示进行归类。临时 cwd、SQLite 数据库路径和 rollout 路径不会进入结果。每个会话包含稳定的 `projectId`、`projectName`、`projectPath`、`canViewHistory` 和 `canContinue`；手机按 `projectId` 分组，并通过 `nextCursor` 加载更早任务。未授权正式项目只能请求 `session.history.request`，不能发送 `session.resume` 或 `conversation.input`。

## 5. 加密与防重放

- 内容加密：AES-256-GCM。
- 密钥：配对链接 URL fragment 中的 256 位预共享密钥；fragment 不会随 HTTP 请求发送给服务器。
- nonce：每帧随机 96 位值。
- 完整性：AES-GCM tag 加上路由元数据 AAD。
- 外层防重放：每个发送设备维护最近 2048 个外层 ID，并要求 sequence 严格递增。
- 内层幂等：桌面按手机设备隔离缓存最近 2048 个命令响应。相同内层 `messageId` 即使重新加密为新外层帧，也只重发缓存响应，不再次调用 Codex。

发送方会收到中继 ACK：`{ "kind": "ack", "messageId": "...", "delivered": 0|n }`。当前 ACK 表示中继投递数量，不代表 Codex 已执行；真正执行状态由内层结果和事件表示。

## 6. 重连和离线语义

桌面使用心跳和自动重连。中继不持久化离线命令，目标离线时 `delivered` 为 0；高风险操作不会离线排队。手机和桌面各自保留 sequence，重复或乱序消息被拒绝。

当前版本没有持久化密文队列，也没有跨中继重启的断点补发。会话历史在重连后从本机 app-server 重新读取。

## 7. 版本升级

未知 `protocolVersion` 必须拒绝。新增可选字段应保持 v1 解析兼容；改变认证、AAD、消息语义或必填字段时升级主协议版本。Codex app-server 的版本分支只能存在于桌面适配层，不得泄漏到本协议。

## 8. 局域网配对协议 v1

局域网配对只交换访问公网 Relay 所需的房间凭据，不承载 Codex 会话消息。内嵌服务默认监听 4179，并只接受可信局域网来源。

### 8.1 电脑邀请

Compass 创建两分钟有效的六位码和 256 位邀请 secret。二维码包含：

```text
http://电脑局域网地址:4179/pair?code=123456#secret=base64url
```

fragment 不会随页面请求发送。手机生成临时 X25519 密钥对，并以邀请 secret 或手工六位码对请求字段计算 HMAC-SHA256。服务端验证后返回临时服务端公钥、轮询 Token 和双端校验码。

### 8.2 手机主动请求

手机可以不使用邀请码，直接打开局域网页并生成 X25519 临时密钥对。电脑和手机分别根据共享密钥计算相同的六位校验码；用户必须在电脑端比对并批准。

### 8.3 批准结果

电脑批准后，将以下 JSON 使用派生密钥和 AES-256-GCM 加密：

```json
{
  "protocolVersion": 1,
  "publicWebUrl": "https://relay.example.com",
  "roomId": "uuid",
  "desktopDeviceId": "uuid",
  "token": "base64url-secret",
  "key": "base64url-secret"
}
```

派生材料包含 X25519 共享密钥、邀请凭据摘要、请求 ID 和配对模式。手机解密后把 Token 和内容密钥放入公网网站 URL fragment，再跳转到 HTTPS 页面。

### 8.4 安全与可靠性

- 配对请求和邀请两分钟过期。
- 六位码单次使用，批准后邀请立即作废。
- 来源 IP 在两分钟窗口内最多提交 12 次。
- 轮询使用独立 256 位随机 Token。
- Relay 长期 Token、内容密钥和 Codex 凭据不会出现在二维码查询参数中。
- 手机主动请求必须人工比对校验码；不一致时默认拒绝。
- 局域网服务不监听或转发 8787、Codex app-server 和 Codex stdio。
