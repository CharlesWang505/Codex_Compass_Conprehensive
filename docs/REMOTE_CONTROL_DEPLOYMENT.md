# 手机远控自部署说明

Codex Compass 不提供公共中继。每位用户需要在自己的 VPS 上部署 Relay，并在 Compass 中填写自己的 HTTPS/WSS 地址。

本文使用保留示例：

- VPS：`203.0.113.10`
- 域名：`relay.example.com`

这些值不能直接使用，必须替换成用户自己的 VPS 和域名。

## 1. 准备工作

部署前完成：

1. 准备 Ubuntu 或 Debian VPS，支持 x64 和 arm64。
2. 为自己的 Relay 域名添加 `A` 记录并指向 VPS 公网 IP。
3. 确认可以通过 SSH 登录 VPS。
4. 云厂商安全组允许 TCP 22、80、443。
5. 不要开放 4178、4179、8787 或 Codex app-server 端口。

使用 Cloudflare 时，建议先将记录设为“仅 DNS”，证书签发成功后再开启代理，并使用严格 TLS 模式。

## 2. Windows 一键部署

这是普通用户的推荐方式。

1. 下载并解压 `Codex_Compass_Relay_1.3.19.zip`。
2. 双击：

```text
deploy\Deploy-Relay-to-VPS.cmd
```

3. 按提示输入：

- VPS IP 或主机名
- Relay 域名，不包含 `https://`
- Let's Encrypt 邮箱
- SSH 用户，默认 `root`
- SSH 端口，默认 `22`
- 可选 SSH 私钥路径；留空时使用默认密钥或密码

SSH 使用密码时，密码由系统 `ssh` 程序直接读取，脚本不会保存密码。使用自定义私钥时可在 PowerShell 执行：

```powershell
.\deploy\scripts\deploy-relay-from-windows.ps1 `
  -VpsHost 203.0.113.10 `
  -Domain relay.example.com `
  -Email admin@example.com `
  -IdentityFile C:\Users\you\.ssh\id_ed25519
```

向导会：

- 在本机校验域名和部署包。
- 通过 SCP 上传临时安装包。
- 在 VPS 安装经过 SHA-256 校验的 Node.js。
- 创建无登录权限的 `codex-relay` 系统用户。
- 安装固定版本的 Relay 依赖。
- 创建并启动 systemd 服务。
- 配置 Nginx、WebSocket 和请求大小限制。
- 通过 Certbot申请和续期 HTTPS 证书。
- 验证本地与公网 `/healthz`。
- 输出 Compass 需要填写的 HTTPS/WSS 地址。

脚本不会上传 Codex 的 `auth.json`、Cookie、OAuth Token、API Key、会话正文或电脑配置。

## 3. 在 VPS 直接安装

也可以自行把 Relay ZIP 上传并解压，然后执行：

```bash
sudo bash deploy/scripts/install-relay.sh \
  --domain relay.example.com \
  --email admin@example.com \
  --non-interactive
```

缺少参数时，交互模式会询问域名和邮箱：

```bash
sudo bash deploy/scripts/install-relay.sh
```

只渲染配置、不修改系统：

```bash
bash deploy/scripts/install-relay.sh \
  --domain relay.example.com \
  --email admin@example.com \
  --dry-run /tmp/codex-compass-relay-preview
```

安装器可重复运行。升级时会先安装到新的版本目录，通过 Node 语法检查后再原子切换；新服务启动失败时会恢复上一版本。

## 4. 安装结果

Relay 默认结构：

```text
/opt/codex-compass-relay/
├─ current -> releases/当前版本
└─ releases/

/etc/codex-compass-relay/
├─ relay.env
└─ install.conf
```

systemd 服务：

```text
codex-compass-relay.service
```

Relay 只监听：

```text
127.0.0.1:4178
```

公网只通过 Nginx 的 80/443 访问。健康检查应返回：

```json
{"ok":true,"protocolVersion":1}
```

## 5. 诊断

安装完成后运行：

```bash
sudo codex-compass-relay-doctor
```

诊断会检查：

- systemd 服务
- 本机 Relay 健康状态
- Nginx 配置
- TLS 证书
- 公网 HTTPS
- 4178 是否只监听回环地址
- 最近 20 条 Relay 日志

其他常用命令：

```bash
systemctl status codex-compass-relay
journalctl -u codex-compass-relay -n 100 --no-pager
curl http://127.0.0.1:4178/healthz
curl https://relay.example.com/healthz
```

## 6. Compass 配置

打开“手机远控”，填写：

```text
中继 WebSocket：wss://relay.example.com/ws
手机网站地址：https://relay.example.com
```

然后：

1. 保存并应用。
2. 开启手机远控。
3. 确认中继状态为“已连接”。
4. 一键同步 Codex 项目。
5. 按需设置工作区修改、命令和上传权限。
6. 创建公网快速链接或使用局域网配对。

Codex 认证仍由电脑本地 app-server 复用，VPS 不接收 Codex 登录凭据。

## 7. 防火墙

安装器不会自动启用 UFW，避免更改用户现有 SSH 策略。如果 UFW 已经启用，只会放行 80 和 443。

云厂商安全组和 VPS 防火墙应只允许需要的端口：

```text
22   SSH
80   HTTP/证书签发
443  HTTPS/WSS
```

不要开放：

```text
4178  Relay 本地监听
4179  Compass 局域网配对
8787  Compass 本地网关
Codex app-server 或调试端口
```

## 8. 局域网配对

局域网配对由电脑上的 Compass 提供，默认关闭，默认端口为 4179。

1. 在 Compass 中开启“允许同网设备请求”。
2. 保存后创建两分钟邀请，或让手机打开页面显示的局域网地址。
3. 手机和电脑必须显示相同的六位校验码。
4. 电脑端确认后，手机才能获得加密后的 Relay 凭据。

4179 只用于一次性配对，不处理 Codex 消息，也不能转发到公网。

## 9. 更新 Relay

下载新版本 Relay ZIP，重新运行 Windows 向导或 VPS 安装器即可：

```bash
sudo bash deploy/scripts/install-relay.sh \
  --domain relay.example.com \
  --email admin@example.com \
  --non-interactive
```

更新会短暂重启 Relay WebSocket。Compass 启用自动重连后会恢复连接。

## 10. Caddy 方式

默认一键安装器使用 Nginx。需要自行管理 Caddy 时，可以参考：

```text
deploy/caddy/Caddyfile
```

将其中的 `relay.example.com` 替换为自己的域名，并保持 Relay 只监听 `127.0.0.1:4178`。

## 11. 故障排查

- 域名无法解析：确认 `A` 记录已指向 VPS，等待 DNS 生效。
- 证书签发失败：确认 80/443 可达，并暂时关闭 CDN 代理。
- `/healthz` 返回 502：运行 `sudo codex-compass-relay-doctor` 检查 systemd 和本机 4178。
- WSS 无法连接：确认 Compass 使用 `wss://自己的域名/ws`。
- 手机看不到电脑：电脑必须先连接 Relay，且远控未暂停。
- Compass 未连接：确认同时填写了 WSS 和 HTTPS 地址。
- 需要更换域名：使用新域名重新运行安装器，再修改 Compass 配置。
- 安装失败：保留终端输出，并查看 `journalctl -u codex-compass-relay -n 100 --no-pager`。
