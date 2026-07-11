export type SiteKind = 'auto' | 'new-api' | 'openai-compatible'

export type ApiKeyProbe = {
  id: string
  name: string
  key: string
  tokenName?: string
  enabled: boolean
}

export type RelaySite = {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  apiKeyTokenName?: string
  apiKeyProbes?: ApiKeyProbe[]
  userId?: string
  cookie?: string
  loginUsername?: string
  loginPassword?: string
  autoLogin?: boolean
  kind: SiteKind
  refreshMinutes: number
  availabilityProbe: boolean
}

export type RequestInput = {
  url: string
  apiKey?: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  includeHeaders?: boolean
}

export type RequestResult = {
  ok: boolean
  status: number
  statusText: string
  data: unknown
  durationMs: number
  headers?: Record<string, string>
}

export type AccountData = {
  currentBalance: number
  historicalCost: number
  requestCount: number
  username: string
  group: string
  quotaRaw?: number
  usedQuotaRaw?: number
  subscriptionBalance?: number
  subscriptionUsed?: number
  subscriptionRemainingRaw?: number
  subscriptionTotalRaw?: number
  subscriptionUsedRaw?: number
  subscriptionPreDeductRaw?: number
  subscriptionSettleDeltaRaw?: number
  subscriptionFinalDeductRaw?: number
  subscriptionName?: string
  subscriptionInstance?: string
  subscriptionExpiresAt?: string
  subscriptionDescription?: string
  subscriptionActiveCount?: number
}

export type UsageSummary = {
  realTokens: number
  cost: number
  cacheCreation: number
  cacheHit: number
  input: number
  output: number
  cacheHitRate: number
  totalRequests: number
}

export type TrendPoint = {
  time: string
  tokens: number
  cost: number
  cacheCreation: number
  cacheHit: number
  input: number
  output: number
}

export type ModelUsage = {
  model: string
  group: string
  tokens: number
  cost: number
  input: number
  output: number
  cacheCreation: number
  cacheHit: number
  requests: number
  ratio?: number
}

export type AvailabilityStatus = 'ok' | 'slow' | 'down' | 'unknown'

export type AvailabilityProbe = {
  name: string
  endpoint: string
  status: AvailabilityStatus
  latencyMs: number
  availability: number
  detail: string
}

export type GroupRate = {
  group: string
  model: string
  ratio: number
  enabled: boolean
  modelRatio?: number
  groupRatio?: number
  completionRatio?: number
  cacheRatio?: number
  modelPrice?: number
  quotaType?: number
  availableGroups?: string[]
}

export type TokenRecord = {
  id: string
  name: string
  status: 'enabled' | 'disabled' | 'unknown'
  remaining: number | null
  used: number
  group: string
  models: string[]
  key?: string
  keyPreview: string
}

export type ApiKeyProbeResult = {
  id: string
  name: string
  tokenName: string
  enabled: boolean
  ok: boolean
  status: SourceStatus
  latencyMs: number
  detail: string
  models: number
  checkedAt: string
  requests: number
  errors: number
  tokens: number
  cost: number
  avgLatencyMs: number
  successRate: number | null
  healthScore: number
  healthLabel: string
  lastUsedAt?: string
}

export type UsageLog = {
  id: string
  time: string
  tokenName: string
  model: string
  group: string
  status: 'success' | 'error' | 'cached'
  errorCode?: number
  errorMessage?: string
  input: number
  output: number
  total: number
  cost: number
  cacheCreation: number
  cacheHit: number
  latencyMs: number
  firstTokenMs: number
  isStream?: boolean
  outputTokensPerSecond?: number
  reasoningEffort?: string
  ip: string
  ratio?: number
  modelRatio?: number
  groupRatio?: number
  completionRatio?: number
  cacheRatio?: number
  billingType?: 'quota' | 'subscription'
  billingDetail?: string
  subscriptionPlan?: string
  subscriptionInstance?: string
  subscriptionPreDeduct?: number
  subscriptionSettleDelta?: number
  subscriptionFinalDeduct?: number
  subscriptionRemaining?: number
  subscriptionTotal?: number
  subscriptionDescription?: string
}

export type SourceStatus = 'ok' | 'fail' | 'optional' | 'forbidden' | 'timeout'

export type EndpointSource = {
  label: string
  endpoint: string
  ok: boolean
  optional?: boolean
  kind: SourceStatus
  status: number
  durationMs: number
  detail?: string
}

export type ThemeMode = 'dark' | 'light' | 'pink'

export type UsageSnapshot = {
  generatedAt: string
  mode: 'live' | 'demo' | 'partial'
  account: AccountData
  summary: UsageSummary
  trends: TrendPoint[]
  models: ModelUsage[]
  availability: AvailabilityProbe[]
  groups: GroupRate[]
  tokens: TokenRecord[]
  keyChecks: ApiKeyProbeResult[]
  logs: UsageLog[]
  sources: EndpointSource[]
  errors: string[]
}
