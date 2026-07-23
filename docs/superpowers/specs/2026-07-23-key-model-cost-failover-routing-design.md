# Key 级模型成本路由与自动故障切换设计

## 状态

- 日期：2026-07-23
- 设计状态：已确认，等待用户审阅书面规格
- 实现范围：Codex Compass 内置 Tauri 网关，不部署独立 NewAPI、OneAPI 或 OpenRelay 服务

## 目标

在用户配置的多个站点和多个 API Key 之间，为同一个模型提供：

- 每个 Key 下每个模型的独立健康检测。
- 可选择检测全部模型或自定义模型列表。
- 根据真实调用账单学习每个 Key、每个模型的实测倍率。
- 新任务开始时选择成本更低且健康的 Key。
- 任务进行期间保持 Key 稳定，仅在可重试故障时切换。
- 连续失败熔断、冷却和半开恢复。
- 清晰展示健康、成本、选路、故障切换和历史趋势。

功能不得跨模型切换，不得将未检测的模型加入自动路由，不得记录明文 API Key 或响应正文。

## 非目标

- 不实现独立部署的公共 API 网关。
- 不替代 NewAPI 或 Sub2API 的管理后台。
- 不自动购买、创建或轮换 API Key。
- 不发送只为积累成本样本而产生的付费请求。
- 不在流式响应已经向 Codex 输出内容后切换上游。
- 不对名称相似的模型进行自动模糊匹配。

## 已确认的产品规则

- 路由和检测的最小单位是“站点 + Key + 模型”。
- 自动路由只在同一个模型的不同 Key 通道之间选择。
- 每个 Codex 任务固定一个首选 Key；任务中途仅因故障切换。
- 实测倍率为 `actual_cost / cost`，不使用“折扣”作为产品概念。
- 候选 Key 的可信实测倍率至少低 10%，才替换现有首选 Key。
- 当前请求首次遇到可重试故障时立即尝试备用 Key。
- 每个请求最多尝试 3 个同模型 Key 通道。
- 连续失败 3 次后熔断 5 分钟；冷却结束进入半开，仅允许一个探测请求。
- 模型定时检测、成本路由、自动故障切换、响应超时后切换均为独立开关，默认关闭。
- Compass 启动后立即执行已启用的定时任务，之后每 10 分钟执行。
- 仅在状态变化、故障切换、Key 失效或全部同模型通道不可用时通知。

## 供应商适配

### New API

适配站点：

- `https://code-plan.site`
- `https://synapse-ai.uk`

Codex 请求 Base URL 分别为：

- `https://code-plan.site/v1`
- `https://synapse-ai.uk/v1`

复用现有站点监控能力：

- `/api/user/login`：账号密码登录并获取 Cookie 或用户访问令牌。
- `/api/token/`：令牌列表和令牌名称。
- `/api/log/self`：调用日志。
- `/api/pricing`：模型定价。
- `/api/ratio_config`：倍率配置，可选。
- `/api/user/self/groups`：用户分组。
- `/v1/models`：使用具体 Key 获取可用模型。

访问 `/api/*` 时沿用现有规则：存在 Cookie 时优先 Cookie，否则尝试 Bearer 凭据，并附带已配置的 `New-Api-User`。

### Sub2API

适配站点：

- `https://bizdecipher.com/v1`
- `https://sub.anzhiyu.com/v1`

每个 Key 独立调用：

- `/v1/models`：发现该 Key 可用模型。
- `/v1/usage`：获取 Key 级用量和 `model_stats`。
- `/v1/sub2api/billing`：获取当前生效倍率和峰值倍率。

Sub2API 适配只使用供应商 API Key，不要求网页登录凭据。

### 普通 OpenAI 兼容站点

自动识别失败时作为普通 OpenAI 兼容站点：

- 可使用 `/v1/models` 或手工模型列表。
- 可执行模型健康检测和故障切换。
- 没有可靠账单接口时只使用手工倍率和优先级，不生成实测倍率。

## 统一通道模型

后端建立统一 `KeyChannel`：

```text
KeyChannel
  relay_id
  monitor_site_id?
  provider_kind
  normalized_origin
  api_base_url
  key_fingerprint
  display_name
  enabled
  model_selection_mode
  selected_models
  manual_rate?
  manual_priority
```

`provider_kind` 支持：

- `new_api`
- `sub2api`
- `openai_compatible`

`model_selection_mode` 支持：

- `all`：自动检测该 Key 当前发现的全部模型。
- `custom`：只检测用户勾选的模型。

模型运行时通道键为：

```text
(normalized_origin, key_fingerprint, canonical_model)
```

相同站点、相同 Key 指纹、相同模型只能生成一个运行时通道。

## 后端组件

后端按职责拆分为：

- `KeyChannelRegistry`：读取现有配置，完成 URL 规范化、Key 指纹、去重和模型映射。
- `ProviderUsageAdapter`：封装 New API、Sub2API 和普通兼容站的模型、倍率、用量获取。
- `ModelCostLedger`：持久化费用观测，计算可信实测倍率和数据新鲜度。
- `CostRoutingPolicy`：在新任务开始时生成同模型候选顺序，处理 10% 门槛和排序规则。
- `ModelFailoverManager`：分类失败、维护连续失败和熔断状态，并执行最多 3 个通道的尝试。
- `TaskChannelBindings`：保存当前运行期间的“任务 + 模型 → Key 通道”绑定。
- `ModelHealthManager`：执行定时或手动模型检测，并接收真实请求反馈。

组件依赖方向：

```text
配置
  -> KeyChannelRegistry
  -> ProviderUsageAdapter
  -> ModelCostLedger
  -> CostRoutingPolicy
  -> TaskChannelBindings
  -> protocol_proxy
  -> ModelFailoverManager
```

`protocol_proxy` 只负责请求转发和流式边界，不直接实现成本计算或数据库访问。

任务绑定优先使用 Codex 任务或会话标识。无法取得稳定任务标识时，使用网关会话标识作为降级键。绑定只保存在运行时内存中；Compass 重启后重新选路，不恢复旧任务绑定。

## 配置关联与迁移

现有配置来源包括：

- `RelaySite.apiKey`
- `RelaySite.apiKeyProbes`
- Codex `RelayProfile`
- 聚合供应商成员

迁移和去重规则：

1. 将 URL 规范化为小写主机名和有效端口。
2. 关联时移除 API Base URL 末尾的 `/v1`，但保留实际请求 Base URL。
3. 使用应用本地密钥派生的 HMAC-SHA256 生成 Key 指纹。
4. 以“规范化站点 + Key 指纹”合并站点监控和 Codex 供应商配置。
5. 保留用户设置的显示名称、模型映射、优先级和启用状态。
6. 不要求用户重新输入已有 Key。

原始 Key 继续保存在现有敏感配置存储中，不复制到健康或成本数据库。

## 模型发现与选择

每个 Key 独立发现模型：

1. 使用该 Key 请求 `/v1/models`。
2. New API 可使用令牌记录中的模型限制补充结果。
3. 接口不可用时回退到 RelayProfile 模型列表。
4. 最后回退到用户手工填写的模型列表。

`all` 模式下，新发现模型自动加入检测。

`custom` 模式下，新模型默认未选择。未选择模型：

- 不进入定时健康检测。
- 不进入成本路由。
- 不进入自动故障切换。
- 仍允许用户手工直接使用。

重新勾选模型后立即检测一次；检测成功后才允许进入自动路由。

模型名称默认精确匹配。不同站点名称不一致时，复用现有 `HotSwitchModelMapping` 手工映射为同一个规范模型。

## 健康检测

模型健康状态按 `(KeyChannel, canonical_model)` 独立保存。

检测规则：

- 功能默认关闭。
- 开启后立即检测，之后每 10 分钟检测。
- 最大并发为 3。
- 检测所有已选择且配置完整的 Key 模型通道。
- 检测结果不得同步覆盖同 Key 的其他模型。
- 定时检测关闭时不发送额外请求，但真实请求结果仍更新健康状态。

状态包括：

- `unknown`
- `checking`
- `available`
- `degraded`
- `unavailable`
- `disabled`
- `not_selected`

只在状态变化时通知。首次成功只建立基线，不通知；首次失败允许通知。

## 成本数据获取

### New API

按令牌名称或 Key 指纹将调用日志关联到具体 Key，并按模型聚合：

- 成功请求数
- 标准费用 `cost`
- 实际扣费 `actual_cost`
- 输入、输出、缓存创建和缓存命中 Token
- 日志记录的模型、分组和总倍率

如果日志直接提供标准费用和实际扣费，则使用原始值。

如果只提供实际扣费和可信总倍率，则可反推标准费用：

```text
cost = actual_cost / total_ratio
```

缺少可靠费用对时，该记录不参与实测倍率，只保留为健康和用量信息。

### Sub2API

使用具体 Key 请求 `/v1/usage`，读取 `model_stats`：

- `model`
- `requests`
- `input_tokens`
- `output_tokens`
- `cache_creation_tokens`
- `cache_read_tokens`
- `cost`
- `actual_cost`

使用 `/v1/sub2api/billing` 的 `effective_rate_multiplier` 作为无历史数据时的当前倍率。

## 实测倍率

实测倍率按 `(KeyChannel, canonical_model)` 计算：

```text
measured_rate = sum(actual_cost) / sum(cost)
```

统计规则：

- 使用最近 7 天数据。
- 至少 5 个成功请求。
- `cost` 和 `actual_cost` 必须为有限非负数，且 `cost > 0`。
- 失败请求、零 Token、免费测试和无法确认扣费的数据不参与。
- 订阅或套餐产生的 `actual_cost = 0` 不视为最低倍率。
- 有逐请求样本时，使用中位数绝对偏差排除明显异常值；样本不足时只进行合法性过滤。
- 聚合时使用费用总和相除，不对每条记录的倍率做简单平均。

来源去重规则：

- New API 调用日志按站点请求 ID 去重，同一请求只计入一次。
- Sub2API `model_stats` 是时间窗口聚合，按“通道 + 模型 + 窗口 + 来源”覆盖保存，不与重叠窗口累加。
- 路由评分使用每个来源最新的完整 7 天窗口，或由不重叠的逐请求记录聚合。
- 刷新失败或返回不完整窗口时保留上一份完整快照。

可信度状态：

- `trusted`：满足 7 天内至少 5 个成功请求。
- `provisional`：有有效数据但样本不足。
- `current_only`：只有接口当前倍率。
- `manual_only`：只有手工倍率。
- `unknown`：没有可用成本信息。

## 成本刷新与保留

- 成本路由启用后，Compass 启动立即刷新一次，之后每 10 分钟刷新。
- 手动刷新始终可用。
- 路由评分使用最近 7 天数据。
- 原始或聚合成本观测保留 30 天。
- 当前倍率读取失败时，最近一次有效值最多缓存 24 小时。
- 超过 24 小时后降级为手工倍率和优先级。
- 新 Key 不发送额外付费测试；先使用当前倍率，真实请求达到 5 个后转为可信实测倍率。

成本数据使用应用私有 SQLite 数据库存储。数据库仅保存 Key 指纹、模型、聚合费用、样本数、时间戳和来源，不保存明文 Key、Cookie、请求正文或响应正文。

建议的数据表：

```text
model_cost_observations
  channel_id
  canonical_model
  observation_kind
  source_record_id?
  window_start
  window_end
  successful_requests
  standard_cost
  actual_cost
  source
  observed_at

model_cost_summaries
  channel_id
  canonical_model
  measured_rate
  confidence
  sample_count
  current_rate
  current_rate_source
  current_rate_observed_at
  updated_at

model_route_preferences
  canonical_model
  preferred_channel_id
  selected_reason
  updated_at
```

`observation_kind` 区分 `request` 与 `window_snapshot`。请求记录以 `source_record_id` 唯一去重；窗口快照使用通道、模型、来源和窗口边界唯一约束并采用 upsert。

`TaskChannelBindings` 和熔断状态不写入这些表，避免重启后沿用已经失效的瞬时状态。

## 正常成本选路

每个规范模型保存一个“当前首选 Key”。

新 Codex 任务开始时：

1. 收集支持该模型且已选择检测的 Key 通道。
2. 排除禁用、额度耗尽、余额为零、熔断和明确不可用通道。
3. 手工锁定存在时优先使用锁定 Key。
4. 当前首选仍健康时，仅当可信候选实测倍率至少低 10% 才替换。
5. 差距不足 10% 时保持当前首选。
6. 没有可信实测倍率时使用当前倍率。
7. 当前倍率也不可用时使用手工倍率和手工优先级。

倍率接近或相同的排序规则：

1. 保持当前首选。
2. 更低的近期故障率。
3. 更低的 P95 延迟。
4. 更高的手工优先级。
5. 稳定的通道 ID 排序，确保结果可复现。

任务建立绑定后，正常倍率刷新不会改变该任务的 Key。

## 自动故障切换

故障切换默认关闭，开启后只在同一个规范模型的 Key 通道间执行。

可切换故障：

- 网络连接失败
- DNS 失败
- TLS 失败
- HTTP 408
- HTTP 429
- HTTP 5xx
- HTTP 401/403
- 明确表示模型不存在或无权限的 404

默认不可切换：

- HTTP 400
- HTTP 413
- HTTP 422
- 请求参数、上下文长度、内容格式或业务校验错误

响应超时是否切换由独立开关控制，默认关闭，以降低重复计费风险。

单次请求流程：

1. 首选通道失败后立即分类。
2. 可切换故障增加该 Key 模型通道的连续失败计数。
3. 在最多 3 个候选中按路由顺序尝试。
4. 任一流式响应已向 Codex 输出内容后停止切换。
5. 切换成功后，将该任务绑定到成功通道直到任务结束。
6. 不可切换错误直接返回，不尝试备用通道。

## 熔断状态机

每个 `(KeyChannel, canonical_model)` 独立维护：

- `closed`
- `open`
- `half_open`

规则：

- `closed` 下连续 3 次可切换失败后进入 `open`。
- `open` 持续 5 分钟，不接收普通请求。
- 冷却结束进入 `half_open`。
- `half_open` 只允许一个探测请求。
- 探测成功回到 `closed` 并清零连续失败。
- 探测失败重新进入 `open` 并重新计时。
- 配置修改或 Key 替换时清理旧指纹对应的运行时状态。

健康检测和真实请求都可以关闭熔断，但只有真实成功请求计入成本样本。

## 功能开关

设置中提供四个独立开关，全部默认关闭：

- 模型定时检测
- 实测倍率成本路由
- 自动故障切换
- 响应超时后切换

依赖关系：

- 成本路由可在定时检测关闭时运行，使用最近健康状态和真实请求结果。
- 自动故障切换可在成本路由关闭时运行，按手工优先级和现有备用链选择。
- 响应超时后切换只有在自动故障切换开启时生效。

## 界面

供应商模型面板按站点和 Key 分组。

Key 行显示：

- 站点名称和平台类型
- 用户自定义 Key 名称
- 脱敏 Key 预览
- 模型检测模式
- 当前倍率来源和更新时间
- 余额或额度状态
- 启用、锁定和刷新操作

每个已选择模型显示独立小方框：

- 模型名称
- 健康状态
- 实测倍率
- 当前倍率
- 样本数
- 最近成功时间
- 首选、备用、熔断或未选择标记

点击模型方框打开全屏详情：

- 最近检测结果
- 成功率、P50/P95 延迟
- 7 天实测倍率趋势
- 标准费用和实际扣费汇总
- 路由选择原因
- 最近故障和切换记录
- 当前熔断状态及恢复时间
- 全部模型/自定义模型选择器

普通成本选路只记录到面板，不弹通知。以下情况通知：

- 实际发生故障切换
- Key 鉴权失效
- 模型由可用变为不可用或恢复
- 同模型全部通道不可用
- 手工锁定 Key 已无法使用

## 后端接口与事件

后端至少提供：

- 获取所有 Key 通道、模型选择和平台识别结果。
- 更新 Key 的全部模型/自定义模型模式。
- 获取模型健康、实测倍率、当前倍率和路由首选。
- 手动刷新指定 Key 或全部 Key 的模型、健康和成本。
- 更新成本路由、故障切换和超时切换开关。
- 手工锁定或解除模型的首选 Key。
- 获取指定 Key 模型的详情和趋势。

状态事件按批次发送，避免每个模型刷新都触发完整页面重绘：

- `model-channel-health:updated`
- `model-channel-cost:updated`
- `model-channel-route:changed`
- `model-channel-failover:occurred`
- `model-channel-refresh:completed`

事件负载只包含通道 ID、模型和变化字段，不包含密钥或完整请求数据。

## 错误处理

- 单个站点、Key 或模型刷新失败不得阻止其他通道更新。
- 一轮刷新采用分通道事务写入；解析失败不覆盖上次有效值。
- New API Cookie 失效时复用现有自动登录，登录失败保留旧数据并标记过期。
- Sub2API `/v1/usage` 不可用时回退到 Billing 当前倍率。
- 普通兼容站没有账单能力时保留健康检测和手工路由。
- 模型发现失败时保留上次模型列表，不自动删除用户选择。
- Key 配置删除后清理其任务外运行时状态，历史聚合数据按 30 天策略过期。

## 安全与隐私

- API Key、Cookie 和登录密码继续存放在现有敏感配置目录。
- 成本和健康数据库使用本地 HMAC Key 指纹，不保存原始密钥。
- 前端只接收 Key 显示名和脱敏预览。
- 日志不得包含 Authorization、Cookie、原始请求正文、完整响应或账号密码。
- 导出诊断信息时只包含通道 ID、模型、状态、时间和脱敏错误摘要。
- 所有网络请求由 Tauri 后端执行，遵循现有系统代理和 TLS 配置。

## 测试

### 单元测试

- URL 根域名和 `/v1` 规范化。
- Key HMAC 指纹稳定性和去重。
- New API 与 Sub2API 响应解析。
- 每 Key 模型发现和自定义选择。
- 实测倍率聚合、样本门槛、异常值和零扣费处理。
- 10% 首选替换门槛。
- 同倍率故障率、P95 和优先级排序。
- HTTP 错误分类和超时独立开关。
- 熔断、冷却和半开状态机。
- 流式响应开始后禁止切换。

### 集成测试

- 同站点多个 Key 不共享模型状态。
- 同 Key 多个模型不共享检测结果。
- New API Cookie 自动登录后读取日志。
- Sub2API 使用 Key 获取 Billing 和模型统计。
- 现有 RelaySite 与 RelayProfile 自动关联且不重复。
- 新任务绑定、任务内粘性和故障后重新绑定。
- 每个请求最多尝试 3 个同模型通道。
- 未选择检测的模型不进入自动路由。
- 普通 OpenAI 兼容站降级到手工倍率。

### 前端测试

- 站点、Key 和模型分组正确。
- 全部模型和自定义模型模式切换。
- 模型卡片状态、倍率来源、样本数和首选标记。
- 模型详情中的趋势、故障和熔断状态。
- 原始 Key 不出现在 DOM、日志和错误提示中。

### 验收场景

1. 四个目标站点均可添加一个或多个 Key。
2. 每个 Key 可发现并选择模型。
3. 定时检测只检测已选择模型。
4. 同模型的每个 Key 均形成独立健康和实测倍率。
5. 新任务选择首选 Key，任务中途不因倍率刷新切换。
6. 候选倍率未低 10% 时保持当前首选。
7. 当前 Key 出现可重试故障时请求切到备用 Key。
8. 失败 3 次后熔断，5 分钟后单请求半开恢复。
9. 流式输出开始后不切换。
10. 所有开关关闭时，行为与当前版本一致。

## 实施边界

实现应复用：

- `hot_switch_mapping.rs`
- `protocol_proxy.rs`
- `relay_rotation.rs`
- `model_health.rs`
- `relayApi.ts`
- `ModelHealthPanel.tsx`
- `ModelMappingEditor.tsx`

新增代码应将平台适配、成本存储、选路策略和熔断状态拆成独立模块，避免继续扩大协议代理文件。具体文件拆分、迁移步骤和测试顺序在后续实施计划中确定。
