export type ProxyControllerMode = 'namedPipe' | 'http'

export type SubscriptionUsage = {
  upload?: number
  download?: number
  total?: number
  expire?: number
}

export type ProxySubscription = {
  id: string
  name: string
  urlPreview: string
  nodeNames: string[]
  nodeCount: number
  updatedAt: number
  usage?: SubscriptionUsage
}

export type ProxyLatencyTarget = {
  id: string
  name: string
  url: string
  enabled: boolean
}

export type ProxyLatencyConfig = {
  subscriptions: ProxySubscription[]
  selectedSubscriptionIds: string[]
  controller: {
    mode: ProxyControllerMode
    endpoint: string
    hasSecret: boolean
  }
  targets: ProxyLatencyTarget[]
  timeoutMs: number
  concurrency: number
  onlyImportedNodes: boolean
  includeLocalTest: boolean
  useManagedEngine: boolean
}

export type ProxyLatencySettingsInput = {
  controllerMode: ProxyControllerMode
  controllerEndpoint: string
  controllerSecret?: string
  clearControllerSecret?: boolean
  targets: ProxyLatencyTarget[]
  timeoutMs: number
  concurrency: number
  onlyImportedNodes: boolean
  selectedSubscriptionIds: string[]
  includeLocalTest: boolean
  useManagedEngine: boolean
}

export type ProxySubscriptionImportInput = {
  subscriptionId?: string
  name?: string
  url?: string
}

export type ProxyControllerCandidate = {
  mode: ProxyControllerMode
  endpoint: string
  label: string
  version?: string
  available: boolean
  requiresSecret: boolean
  detail: string
}

export type ProxyNode = {
  name: string
  proxyType: string
  alive?: boolean
  udp?: boolean
  providerNames: string[]
}

export type ProxyNodeList = {
  controllerVersion: string
  controllerMode: ProxyControllerMode
  controllerEndpoint: string
  nodes: ProxyNode[]
}

export type ProxyDelayStatus = 'ok' | 'timeout' | 'error'

export type ProxyDelayInput = {
  node: string
  targetUrl: string
  timeoutMs?: number
}

export type DirectDelayInput = {
  targetUrl: string
  timeoutMs?: number
}

export type ProxyDelayResult = {
  node: string
  targetUrl: string
  status: ProxyDelayStatus
  delayMs?: number
  durationMs: number
  detail: string
}

export type ManagedMihomoStatus = {
  installed: boolean
  running: boolean
  version?: string
  detail: string
}
