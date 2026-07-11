import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '../../lib/desktop'
import type {
  ProxyControllerCandidate,
  DirectDelayInput,
  ManagedMihomoStatus,
  ProxyDelayInput,
  ProxyDelayResult,
  ProxyLatencyConfig,
  ProxyLatencySettingsInput,
  ProxyNodeList,
  ProxySubscriptionImportInput,
} from './types'

const browserPreviewConfig: ProxyLatencyConfig = {
  subscriptions: [],
  selectedSubscriptionIds: [],
  controller: {
    mode: 'namedPipe',
    endpoint: String.raw`\\.\pipe\verge-mihomo`,
    hasSecret: false,
  },
  targets: [
    { id: 'default-cloudflare', name: '示例线路 A', url: 'https://relay-a.example.com', enabled: true },
    { id: 'default-asia', name: '示例线路 B', url: 'https://relay-b.example.com', enabled: true },
    { id: 'default-global', name: '示例线路 C', url: 'https://relay-c.example.com', enabled: true },
  ],
  timeoutMs: 5_000,
  concurrency: 16,
  onlyImportedNodes: false,
  includeLocalTest: true,
  useManagedEngine: false,
}

export async function loadProxyLatencyConfig(): Promise<ProxyLatencyConfig> {
  if (!isTauriRuntime()) {
    return structuredClone(browserPreviewConfig)
  }
  return invoke<ProxyLatencyConfig>('load_proxy_latency_config')
}

export async function saveProxyLatencyConfig(input: ProxyLatencySettingsInput): Promise<ProxyLatencyConfig> {
  if (!isTauriRuntime()) {
    browserPreviewConfig.controller = {
      mode: input.controllerMode,
      endpoint: input.controllerEndpoint,
      hasSecret: Boolean(input.controllerSecret) && !input.clearControllerSecret,
    }
    browserPreviewConfig.targets = structuredClone(input.targets)
    browserPreviewConfig.timeoutMs = input.timeoutMs
    browserPreviewConfig.concurrency = input.concurrency
    browserPreviewConfig.onlyImportedNodes = input.onlyImportedNodes
    browserPreviewConfig.selectedSubscriptionIds = [...input.selectedSubscriptionIds]
    browserPreviewConfig.includeLocalTest = input.includeLocalTest
    browserPreviewConfig.useManagedEngine = input.useManagedEngine
    return structuredClone(browserPreviewConfig)
  }
  return invoke<ProxyLatencyConfig>('save_proxy_latency_config', { input })
}

export async function importProxySubscription(input: ProxySubscriptionImportInput): Promise<ProxyLatencyConfig> {
  if (!isTauriRuntime()) {
    throw new Error('订阅导入需要在 Tauri 桌面应用中运行')
  }
  return invoke<ProxyLatencyConfig>('import_proxy_subscription', { input })
}

export async function removeProxySubscription(subscriptionId: string): Promise<ProxyLatencyConfig> {
  if (!isTauriRuntime()) {
    return structuredClone(browserPreviewConfig)
  }
  return invoke<ProxyLatencyConfig>('remove_proxy_subscription', { subscriptionId })
}

export async function discoverProxyControllers(): Promise<ProxyControllerCandidate[]> {
  if (!isTauriRuntime()) {
    return []
  }
  return invoke<ProxyControllerCandidate[]>('discover_proxy_controllers')
}

export async function listProxyNodes(): Promise<ProxyNodeList> {
  if (!isTauriRuntime()) {
    throw new Error('节点读取需要在 Tauri 桌面应用中运行')
  }
  return invoke<ProxyNodeList>('list_proxy_nodes')
}

export async function testProxyDelay(input: ProxyDelayInput): Promise<ProxyDelayResult> {
  if (!isTauriRuntime()) {
    throw new Error('代理测速需要在 Tauri 桌面应用中运行')
  }
  return invoke<ProxyDelayResult>('test_proxy_delay', { input })
}

export async function testDirectDelay(input: DirectDelayInput): Promise<ProxyDelayResult> {
  if (!isTauriRuntime()) {
    throw new Error('本地直连测速需要在 Tauri 桌面应用中运行')
  }
  return invoke<ProxyDelayResult>('test_direct_delay', { input })
}

export async function loadManagedMihomoStatus(): Promise<ManagedMihomoStatus> {
  if (!isTauriRuntime()) {
    return { installed: false, running: false, detail: '桌面端可启用内置测试引擎' }
  }
  return invoke<ManagedMihomoStatus>('managed_mihomo_status')
}

export async function enableManagedMihomo(): Promise<ProxyNodeList> {
  if (!isTauriRuntime()) {
    throw new Error('内置测试引擎需要在 Tauri 桌面应用中运行')
  }
  return invoke<ProxyNodeList>('enable_managed_mihomo')
}

export async function disableManagedMihomo(): Promise<ProxyLatencyConfig> {
  if (!isTauriRuntime()) {
    browserPreviewConfig.useManagedEngine = false
    return structuredClone(browserPreviewConfig)
  }
  return invoke<ProxyLatencyConfig>('disable_managed_mihomo')
}
