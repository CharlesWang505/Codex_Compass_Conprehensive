import {
  Activity,
  Check,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  CircleGauge,
  Cpu,
  Crosshair,
  Download,
  Gauge,
  Globe2,
  Import,
  Link2,
  LoaderCircle,
  Monitor,
  Network,
  Plus,
  RadioTower,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Square,
  Trash2,
  Wifi,
  X,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isTauriRuntime } from '../../lib/desktop'
import type { RelaySite } from '../../types'
import {
  discoverProxyControllers,
  disableManagedMihomo,
  enableManagedMihomo,
  importProxySubscription,
  listProxyNodes,
  loadManagedMihomoStatus,
  loadProxyLatencyConfig,
  removeProxySubscription,
  saveProxyLatencyConfig,
  testDirectDelay,
  testProxyDelay,
} from './api'
import type {
  ProxyControllerCandidate,
  ProxyControllerMode,
  ProxyDelayResult,
  ProxyDelayStatus,
  ProxyLatencyConfig,
  ProxyLatencySettingsInput,
  ProxyLatencyTarget,
  ManagedMihomoStatus,
  ProxyNode,
  ProxySubscription,
} from './types'
import './ProxyLatencyPanel.css'

type ProxyLatencyPanelProps = {
  sites: RelaySite[]
  selectedSite: RelaySite
}

type ResultSort = 'name' | 'latency' | 'success'
type ResultFilter = 'all' | 'alive' | 'failed'
type RouteSort = {
  targetId: string
  direction: 'asc' | 'desc'
} | null

type ProgressState = {
  completed: number
  total: number
}

const EMPTY_CONFIG: ProxyLatencyConfig = {
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

const LOCAL_DIRECT_NODE_NAME = '本地直连'
const LOCAL_DIRECT_NODE: ProxyNode = {
  name: LOCAL_DIRECT_NODE_NAME,
  proxyType: 'DIRECT',
  alive: true,
  udp: false,
  providerNames: [],
}

function isLocalDirectNode(node: ProxyNode) {
  return node.name === LOCAL_DIRECT_NODE_NAME && node.proxyType === 'DIRECT'
}

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function normalizeUrl(value: string) {
  return value.trim().replace(/\/+$/, '')
}

function matchKey(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\-_.·|/\\()[\]{}（）【】]+/g, '')
}

function providerNameMatchesSubscription(providerName: string, subscriptionName: string) {
  const providerKey = matchKey(providerName)
  const subscriptionKey = matchKey(subscriptionName)
  return providerKey.length >= 2
    && subscriptionKey.length >= 2
    && (providerKey.includes(subscriptionKey) || subscriptionKey.includes(providerKey))
}

function nodesForSubscriptions(nodes: ProxyNode[], subscriptions: ProxySubscription[]) {
  if (!subscriptions.length) {
    return []
  }

  const importedNodeKeys = new Set(subscriptions.flatMap((subscription) => subscription.nodeNames.map(matchKey)))
  const selectedProviderNames = new Set<string>()
  nodes.forEach((node) => {
    if (importedNodeKeys.has(matchKey(node.name))) {
      node.providerNames.forEach((providerName) => selectedProviderNames.add(providerName))
    }
    node.providerNames.forEach((providerName) => {
      if (subscriptions.some((subscription) => providerNameMatchesSubscription(providerName, subscription.name))) {
        selectedProviderNames.add(providerName)
      }
    })
  })

  return nodes.filter((node) => importedNodeKeys.has(matchKey(node.name))
    || node.providerNames.some((providerName) => selectedProviderNames.has(providerName)))
}

function validHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function targetFromSite(site: RelaySite): ProxyLatencyTarget | null {
  const url = normalizeUrl(site.baseUrl)
  if (!validHttpUrl(url)) {
    return null
  }
  return {
    id: `site_${site.id}`,
    name: site.name || '中转站',
    url,
    enabled: true,
  }
}

function mergeSiteTargets(targets: ProxyLatencyTarget[], sites: RelaySite[]) {
  const next = [...targets]
  const urls = new Set(targets.map((target) => normalizeUrl(target.url).toLowerCase()))
  sites.forEach((site) => {
    const target = targetFromSite(site)
    if (target && !urls.has(target.url.toLowerCase())) {
      next.push(target)
      urls.add(target.url.toLowerCase())
    }
  })
  return next
}

function resultKey(node: string, targetId: string) {
  return `${node}\u0000${targetId}`
}

function successfulDelay(result: ProxyDelayResult | undefined) {
  if (result?.status !== 'ok' || result.delayMs === undefined || !Number.isFinite(result.delayMs)) {
    return null
  }
  return result.delayMs
}

function formatBytes(value: number | undefined) {
  if (!Number.isFinite(value)) {
    return '-'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let current = Number(value)
  let unit = 0
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024
    unit += 1
  }
  return `${current.toLocaleString('zh-CN', { maximumFractionDigits: unit > 1 ? 1 : 0 })} ${units[unit]}`
}

function formatUpdatedAt(epochSeconds: number) {
  if (!epochSeconds) {
    return '尚未更新'
  }
  return new Date(epochSeconds * 1000).toLocaleString('zh-CN', { hour12: false })
}

function formatExpiry(epochSeconds: number | undefined) {
  if (!epochSeconds) {
    return '未提供到期时间'
  }
  return new Date(epochSeconds * 1000).toLocaleDateString('zh-CN')
}

function latencyTone(result: ProxyDelayResult | undefined) {
  if (!result) {
    return 'pending'
  }
  if (result.status === 'timeout' || result.status === 'error') {
    return 'failed'
  }
  const delay = result.delayMs ?? Number.POSITIVE_INFINITY
  if (delay < 200) {
    return 'fast'
  }
  if (delay < 500) {
    return 'normal'
  }
  if (delay < 1_000) {
    return 'slow'
  }
  return 'very-slow'
}

function statusLabel(status: ProxyDelayStatus) {
  if (status === 'timeout') {
    return '超时'
  }
  if (status === 'error') {
    return '失败'
  }
  return '成功'
}

function csvCell(value: string | number | undefined) {
  const text = value === undefined ? '' : String(value)
  return `"${text.replaceAll('"', '""')}"`
}

function downloadResultsCsv(
  nodes: ProxyNode[],
  targets: ProxyLatencyTarget[],
  results: Map<string, ProxyDelayResult>,
) {
  const header = ['测试路线', '类型', ...targets.map((target) => `${target.name} (${target.url})`)]
  const rows = nodes.map((node) => [
    node.name,
    node.proxyType,
    ...targets.map((target) => {
      const result = results.get(resultKey(node.name, target.id))
      if (!result) {
        return ''
      }
      return result.status === 'ok' && result.delayMs !== undefined
        ? `${result.delayMs} ms`
        : `${statusLabel(result.status)}：${result.detail}`
    }),
  ])
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `proxy-latency-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function ControllerModeSwitch({
  disabled = false,
  value,
  onChange,
}: {
  disabled?: boolean
  value: ProxyControllerMode
  onChange: (mode: ProxyControllerMode) => void
}) {
  return (
    <div className="proxy-segmented" aria-label="控制器连接方式">
      <button className={value === 'namedPipe' ? 'active' : ''} type="button" disabled={disabled} onClick={() => onChange('namedPipe')}>
        命名管道
      </button>
      <button className={value === 'http' ? 'active' : ''} type="button" disabled={disabled} onClick={() => onChange('http')}>
        HTTP
      </button>
    </div>
  )
}

export function ProxyLatencyPanel({ sites, selectedSite }: ProxyLatencyPanelProps) {
  const [config, setConfig] = useState<ProxyLatencyConfig>(EMPTY_CONFIG)
  const [controllerMode, setControllerMode] = useState<ProxyControllerMode>('namedPipe')
  const [controllerEndpoint, setControllerEndpoint] = useState(String.raw`\\.\pipe\verge-mihomo`)
  const [controllerSecret, setControllerSecret] = useState('')
  const [clearControllerSecret, setClearControllerSecret] = useState(false)
  const [targets, setTargets] = useState<ProxyLatencyTarget[]>([])
  const [timeoutMs, setTimeoutMs] = useState(5_000)
  const [concurrency, setConcurrency] = useState(16)
  const [onlyImportedNodes, setOnlyImportedNodes] = useState(false)
  const [selectedSubscriptionIds, setSelectedSubscriptionIds] = useState<string[]>([])
  const [includeLocalTest, setIncludeLocalTest] = useState(true)
  const [useManagedEngine, setUseManagedEngine] = useState(false)
  const [managedStatus, setManagedStatus] = useState<ManagedMihomoStatus>({
    installed: false,
    running: false,
    detail: '正在读取内置测试引擎状态',
  })
  const [managedBusy, setManagedBusy] = useState(false)
  const [nodes, setNodes] = useState<ProxyNode[]>([])
  const [controllerVersion, setControllerVersion] = useState('')
  const [controllerState, setControllerState] = useState<'idle' | 'loading' | 'online' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<'info' | 'success' | 'error'>('info')
  const [subscriptionName, setSubscriptionName] = useState('')
  const [subscriptionUrl, setSubscriptionUrl] = useState('')
  const [subscriptionBusyId, setSubscriptionBusyId] = useState<string | null>(null)
  const [configBusy, setConfigBusy] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [discoveredControllers, setDiscoveredControllers] = useState<ProxyControllerCandidate[]>([])
  const [nodeQuery, setNodeQuery] = useState('')
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all')
  const [resultSort, setResultSort] = useState<ResultSort>('latency')
  const [routeSort, setRouteSort] = useState<RouteSort>(null)
  const [isTesting, setIsTesting] = useState(false)
  const [progress, setProgress] = useState<ProgressState>({ completed: 0, total: 0 })
  const [lastTestAt, setLastTestAt] = useState<number | null>(null)
  const [resultsVersion, setResultsVersion] = useState(0)
  const resultsRef = useRef(new Map<string, ProxyDelayResult>())
  const progressRef = useRef<ProgressState>({ completed: 0, total: 0 })
  const runIdRef = useRef(0)
  const flushTimerRef = useRef<number | null>(null)

  const applyConfig = useCallback((next: ProxyLatencyConfig, includeSiteDefaults = false) => {
    const nextTargets = includeSiteDefaults && next.targets.length === 0
      ? mergeSiteTargets(next.targets, sites)
      : next.targets
    setConfig(next)
    setControllerMode(next.controller.mode)
    setControllerEndpoint(next.controller.endpoint)
    setControllerSecret('')
    setClearControllerSecret(false)
    setTargets(nextTargets)
    setTimeoutMs(next.timeoutMs)
    setConcurrency(next.concurrency)
    setOnlyImportedNodes(next.onlyImportedNodes)
    setSelectedSubscriptionIds(next.selectedSubscriptionIds)
    setIncludeLocalTest(next.includeLocalTest)
    setUseManagedEngine(next.useManagedEngine)
  }, [sites])

  const flushResults = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    setProgress({ ...progressRef.current })
    setResultsVersion((version) => version + 1)
  }, [])

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null) {
      return
    }
    flushTimerRef.current = window.setTimeout(flushResults, 70)
  }, [flushResults])

  const loadNodes = useCallback(async (quiet = false) => {
    if (!isTauriRuntime()) {
      setControllerState('idle')
      if (!quiet) {
        setMessageTone('info')
        setMessage('浏览器仅用于界面预览；请打开桌面 EXE 连接外部控制器或启用内置测试引擎。')
      }
      return null
    }
    setControllerState('loading')
    try {
      const nodeList = await listProxyNodes()
      setNodes(nodeList.nodes)
      setControllerVersion(nodeList.controllerVersion)
      setControllerMode(nodeList.controllerMode)
      setControllerEndpoint(nodeList.controllerEndpoint)
      if (nodeList.controllerVersion.startsWith('内置 Mihomo')) {
        setUseManagedEngine(true)
      }
      setControllerState('online')
      void loadManagedMihomoStatus().then(setManagedStatus).catch(() => undefined)
      if (!quiet) {
        setMessageTone('success')
        setMessage(`控制器已连接，读取到 ${nodeList.nodes.length} 个可测速代理节点。`)
      }
      return nodeList.nodes
    } catch (error) {
      setNodes([])
      setControllerVersion('')
      setControllerState('error')
      if (!quiet) {
        setMessageTone('error')
        setMessage(errorMessage(error))
      }
      return null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void loadProxyLatencyConfig()
      .then((loaded) => {
        if (cancelled) {
          return
        }
        applyConfig(loaded, true)
        return loadNodes(true)
      })
      .catch((error) => {
        if (!cancelled) {
          setMessageTone('error')
          setMessage(errorMessage(error))
        }
      })
    void loadManagedMihomoStatus().then((status) => {
      if (!cancelled) {
        setManagedStatus(status)
      }
    }).catch(() => undefined)
    return () => {
      cancelled = true
      runIdRef.current += 1
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current)
      }
    }
  }, [applyConfig, loadNodes])

  useEffect(() => {
    if (!isTauriRuntime()) {
      return
    }
    const timer = window.setInterval(() => {
      void loadManagedMihomoStatus().then(setManagedStatus).catch(() => undefined)
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [])

  const buildSettingsInput = useCallback((overrides?: Partial<ProxyLatencySettingsInput>): ProxyLatencySettingsInput => ({
    controllerMode,
    controllerEndpoint: controllerEndpoint.trim(),
    controllerSecret: controllerSecret || undefined,
    clearControllerSecret,
    targets: targets.map((target) => ({
      ...target,
      name: target.name.trim(),
      url: normalizeUrl(target.url),
    })),
    timeoutMs,
    concurrency,
    onlyImportedNodes,
    selectedSubscriptionIds,
    includeLocalTest,
    useManagedEngine,
    ...overrides,
  }), [clearControllerSecret, concurrency, controllerEndpoint, controllerMode, controllerSecret, includeLocalTest, onlyImportedNodes, selectedSubscriptionIds, targets, timeoutMs, useManagedEngine])

  const saveSettings = useCallback(async (quiet = false, overrides?: Partial<ProxyLatencySettingsInput>) => {
    const invalidTarget = targets.find((target) => !validHttpUrl(target.url))
    if (invalidTarget) {
      setMessageTone('error')
      setMessage(`Base URL“${invalidTarget.name || '未命名'}”格式无效。`)
      return null
    }
    setConfigBusy(true)
    try {
      const saved = await saveProxyLatencyConfig(buildSettingsInput(overrides))
      applyConfig(saved)
      if (!quiet) {
        setMessageTone('success')
        setMessage('代理测速设置已保存到独立敏感配置目录。')
      }
      return saved
    } catch (error) {
      setMessageTone('error')
      setMessage(errorMessage(error))
      return null
    } finally {
      setConfigBusy(false)
    }
  }, [applyConfig, buildSettingsInput, targets])

  const connectController = useCallback(async () => {
    const saved = await saveSettings(true, { useManagedEngine: false })
    if (!saved) {
      return
    }
    await loadNodes(false)
  }, [loadNodes, saveSettings])

  const enableManagedEngine = useCallback(async () => {
    if (!selectedSubscriptionIds.length) {
      setMessageTone('error')
      setMessage('请先选择至少一个机场，再安装内置测试引擎。')
      return
    }
    const saved = await saveSettings(true, { useManagedEngine: true })
    if (!saved) {
      return
    }
    setManagedBusy(true)
    setControllerState('loading')
    setMessageTone('info')
    setMessage(managedStatus.installed
      ? '正在启动内置 Mihomo 测试引擎并加载所选机场…'
      : '正在从 MetaCubeX 官方 GitHub 下载并安装 Mihomo，完成后会自动加载所选机场…')
    try {
      const nodeList = await enableManagedMihomo()
      const loaded = await loadProxyLatencyConfig()
      applyConfig(loaded)
      setNodes(nodeList.nodes)
      setControllerVersion(nodeList.controllerVersion)
      setControllerMode(nodeList.controllerMode)
      setControllerEndpoint(nodeList.controllerEndpoint)
      setControllerState('online')
      setManagedStatus(await loadManagedMihomoStatus())
      setMessageTone('success')
      setMessage(`内置测试引擎已启用，读取到 ${nodeList.nodes.length} 个可测速代理节点。`)
    } catch (error) {
      setControllerState('error')
      setManagedStatus(await loadManagedMihomoStatus().catch(() => managedStatus))
      setMessageTone('error')
      setMessage(errorMessage(error))
    } finally {
      setManagedBusy(false)
    }
  }, [applyConfig, managedStatus, saveSettings, selectedSubscriptionIds.length])

  const disableManagedEngine = useCallback(async () => {
    setManagedBusy(true)
    try {
      const next = await disableManagedMihomo()
      applyConfig(next)
      setNodes([])
      setControllerVersion('')
      setControllerState('idle')
      setManagedStatus(await loadManagedMihomoStatus())
      setMessageTone('info')
      setMessage('内置测试引擎已停止；可连接外部 Clash/Mihomo，或继续使用本地直连测试。')
    } catch (error) {
      setMessageTone('error')
      setMessage(errorMessage(error))
    } finally {
      setManagedBusy(false)
    }
  }, [applyConfig])

  const discoverControllers = useCallback(async () => {
    setDiscovering(true)
    try {
      const candidates = await discoverProxyControllers()
      setDiscoveredControllers(candidates)
      const available = candidates.find((candidate) => candidate.available)
      if (available) {
        setControllerMode(available.mode)
        setControllerEndpoint(available.endpoint)
        setMessageTone('success')
        setMessage(`已发现 ${available.label}${available.version ? ` · ${available.version}` : ''}，点击“连接节点”应用。`)
      } else {
        setMessageTone('error')
        setMessage('没有发现可用控制器，请确认 Clash Verge / Mihomo 正在运行，或手动填写 HTTP 控制器。')
      }
    } catch (error) {
      setMessageTone('error')
      setMessage(errorMessage(error))
    } finally {
      setDiscovering(false)
    }
  }, [])

  const importSubscription = useCallback(async () => {
    if (!subscriptionUrl.trim()) {
      setMessageTone('error')
      setMessage('请填写代理订阅地址。')
      return
    }
    setSubscriptionBusyId('new')
    try {
      const next = await importProxySubscription({
        name: subscriptionName.trim() || undefined,
        url: subscriptionUrl.trim(),
      })
      setConfig(next)
      setSelectedSubscriptionIds(next.selectedSubscriptionIds)
      setSubscriptionName('')
      setSubscriptionUrl('')
      setMessageTone('success')
      setMessage(`订阅导入完成，共识别 ${next.subscriptions.at(-1)?.nodeCount ?? 0} 个节点名称。`)
      await loadNodes(true)
    } catch (error) {
      setMessageTone('error')
      setMessage(errorMessage(error))
    } finally {
      setSubscriptionBusyId(null)
    }
  }, [loadNodes, subscriptionName, subscriptionUrl])

  const refreshSubscription = useCallback(async (subscriptionId: string) => {
    setSubscriptionBusyId(subscriptionId)
    try {
      const next = await importProxySubscription({ subscriptionId })
      setConfig(next)
      setSelectedSubscriptionIds(next.selectedSubscriptionIds)
      setMessageTone('success')
      setMessage('订阅节点列表已更新。')
      await loadNodes(true)
    } catch (error) {
      setMessageTone('error')
      setMessage(errorMessage(error))
    } finally {
      setSubscriptionBusyId(null)
    }
  }, [loadNodes])

  const deleteSubscription = useCallback(async (subscriptionId: string, name: string) => {
    if (!window.confirm(`确定移除代理订阅“${name}”吗？只会删除本软件保存的订阅配置。`)) {
      return
    }
    setSubscriptionBusyId(subscriptionId)
    try {
      const next = await removeProxySubscription(subscriptionId)
      setConfig(next)
      setSelectedSubscriptionIds(next.selectedSubscriptionIds)
      setMessageTone('success')
      setMessage('订阅已从本软件的敏感配置中移除。')
    } catch (error) {
      setMessageTone('error')
      setMessage(errorMessage(error))
    } finally {
      setSubscriptionBusyId(null)
    }
  }, [])

  const toggleSubscriptionSelection = useCallback((subscriptionId: string, selected: boolean) => {
    setSelectedSubscriptionIds((current) => selected
      ? [...new Set([...current, subscriptionId])]
      : current.filter((id) => id !== subscriptionId))
    setOnlyImportedNodes(true)
    resultsRef.current.clear()
    setResultsVersion((version) => version + 1)
  }, [])

  const selectOnlySubscription = useCallback((subscriptionId: string) => {
    setSelectedSubscriptionIds([subscriptionId])
    setOnlyImportedNodes(true)
    resultsRef.current.clear()
    setResultsVersion((version) => version + 1)
  }, [])

  const selectAllSubscriptions = useCallback(() => {
    setSelectedSubscriptionIds(config.subscriptions.map((subscription) => subscription.id))
    setOnlyImportedNodes(true)
    resultsRef.current.clear()
    setResultsVersion((version) => version + 1)
  }, [config.subscriptions])

  const clearSubscriptionSelection = useCallback(() => {
    setSelectedSubscriptionIds([])
    setOnlyImportedNodes(true)
    resultsRef.current.clear()
    setResultsVersion((version) => version + 1)
  }, [])

  const selectLocalOnly = useCallback(() => {
    setSelectedSubscriptionIds([])
    setOnlyImportedNodes(true)
    setIncludeLocalTest(true)
    resultsRef.current.clear()
    setResultsVersion((version) => version + 1)
  }, [])

  const toggleLocalTest = useCallback((enabled: boolean) => {
    setIncludeLocalTest(enabled)
    resultsRef.current.clear()
    setResultsVersion((version) => version + 1)
  }, [])

  const addBlankTarget = useCallback(() => {
    setTargets((current) => [
      ...current,
      { id: createId('target'), name: `Base URL ${current.length + 1}`, url: 'https://', enabled: true },
    ])
  }, [])

  const addSelectedSiteTarget = useCallback(() => {
    const target = targetFromSite(selectedSite)
    if (!target) {
      setMessageTone('error')
      setMessage('当前站点没有可用的 HTTP/HTTPS Base URL。')
      return
    }
    setTargets((current) => mergeSiteTargets(current, [selectedSite]))
  }, [selectedSite])

  const addAllSiteTargets = useCallback(() => {
    setTargets((current) => mergeSiteTargets(current, sites))
  }, [sites])

  const updateTarget = useCallback((id: string, patch: Partial<ProxyLatencyTarget>) => {
    setTargets((current) => current.map((target) => (target.id === id ? { ...target, ...patch } : target)))
    resultsRef.current.clear()
    setResultsVersion((version) => version + 1)
  }, [])

  const removeTarget = useCallback((id: string) => {
    setTargets((current) => current.filter((target) => target.id !== id))
    setRouteSort((current) => (current?.targetId === id ? null : current))
    resultsRef.current.clear()
    setResultsVersion((version) => version + 1)
  }, [])

  const cycleRouteSort = useCallback((targetId: string) => {
    if (!routeSort || routeSort.targetId !== targetId) {
      setRouteSort({ targetId, direction: 'asc' })
      return
    }
    if (routeSort.direction === 'asc') {
      setRouteSort({ targetId, direction: 'desc' })
      return
    }
    setRouteSort(null)
    setResultSort('latency')
  }, [routeSort])

  const selectedSubscriptionIdSet = useMemo(() => new Set(selectedSubscriptionIds), [selectedSubscriptionIds])
  const selectedSubscriptions = useMemo(
    () => config.subscriptions.filter((subscription) => selectedSubscriptionIdSet.has(subscription.id)),
    [config.subscriptions, selectedSubscriptionIdSet],
  )
  const allImportedNodeNames = useMemo(() => {
    const names = new Set<string>()
    config.subscriptions.forEach((subscription) => {
      subscription.nodeNames.forEach((name) => names.add(name))
    })
    return names
  }, [config.subscriptions])
  const importedNodeNames = useMemo(() => {
    const names = new Set<string>()
    selectedSubscriptions.forEach((subscription) => {
      subscription.nodeNames.forEach((name) => names.add(name))
    })
    return names
  }, [selectedSubscriptions])

  const importedFilterActive = onlyImportedNodes
  const resultSnapshot = useMemo(
    () => ({ version: resultsVersion, values: new Map(resultsRef.current) }),
    [resultsVersion],
  )
  const matchedNodes = useMemo(() => nodesForSubscriptions(nodes, selectedSubscriptions), [nodes, selectedSubscriptions])
  const scopedNodes = useMemo(() => {
    const proxyNodes = importedFilterActive && !useManagedEngine ? matchedNodes : nodes
    return includeLocalTest ? [LOCAL_DIRECT_NODE, ...proxyNodes] : proxyNodes
  }, [importedFilterActive, includeLocalTest, matchedNodes, nodes, useManagedEngine])
  const enabledTargets = useMemo(() => targets.filter((target) => target.enabled && validHttpUrl(target.url)), [targets])

  const rowStats = useMemo(() => {
    const stats = new Map<string, { average: number; success: number; failed: number }>()
    scopedNodes.forEach((node) => {
      let total = 0
      let success = 0
      let failed = 0
      enabledTargets.forEach((target) => {
        const result = resultSnapshot.values.get(resultKey(node.name, target.id))
        if (result?.status === 'ok' && result.delayMs !== undefined) {
          total += result.delayMs
          success += 1
        } else if (result) {
          failed += 1
        }
      })
      stats.set(node.name, {
        average: success ? total / success : Number.POSITIVE_INFINITY,
        success,
        failed,
      })
    })
    return stats
  }, [enabledTargets, resultSnapshot, scopedNodes])

  const visibleNodes = useMemo(() => {
    const query = nodeQuery.trim().toLowerCase()
    const filtered = scopedNodes.filter((node) => {
      const stat = rowStats.get(node.name)
      const queryMatches = !query || node.name.toLowerCase().includes(query) || node.proxyType.toLowerCase().includes(query)
      const filterMatches = resultFilter === 'all'
        || (resultFilter === 'alive' && node.alive !== false)
        || (resultFilter === 'failed' && Boolean(stat?.failed))
      return queryMatches && filterMatches
    })
    return [...filtered].sort((left, right) => {
      if (routeSort) {
        const leftDelay = successfulDelay(resultSnapshot.values.get(resultKey(left.name, routeSort.targetId)))
        const rightDelay = successfulDelay(resultSnapshot.values.get(resultKey(right.name, routeSort.targetId)))
        const leftSucceeded = leftDelay !== null
        const rightSucceeded = rightDelay !== null

        if (leftSucceeded !== rightSucceeded) {
          return leftSucceeded ? -1 : 1
        }
        if (leftDelay !== null && rightDelay !== null && leftDelay !== rightDelay) {
          return routeSort.direction === 'asc' ? leftDelay - rightDelay : rightDelay - leftDelay
        }

        const averageDifference = (rowStats.get(left.name)?.average ?? Number.POSITIVE_INFINITY)
          - (rowStats.get(right.name)?.average ?? Number.POSITIVE_INFINITY)
        return averageDifference || left.name.localeCompare(right.name, 'zh-CN')
      }
      if (resultSort === 'name') {
        return left.name.localeCompare(right.name, 'zh-CN')
      }
      const leftStat = rowStats.get(left.name)
      const rightStat = rowStats.get(right.name)
      if (resultSort === 'success') {
        return (rightStat?.success ?? 0) - (leftStat?.success ?? 0)
          || (leftStat?.average ?? Number.POSITIVE_INFINITY) - (rightStat?.average ?? Number.POSITIVE_INFINITY)
      }
      return (leftStat?.average ?? Number.POSITIVE_INFINITY) - (rightStat?.average ?? Number.POSITIVE_INFINITY)
        || left.name.localeCompare(right.name, 'zh-CN')
    })
  }, [nodeQuery, resultFilter, resultSnapshot, resultSort, routeSort, rowStats, scopedNodes])

  const resultSummary = useMemo(() => {
    let success = 0
    let failed = 0
    let totalDelay = 0
    resultSnapshot.values.forEach((result) => {
      if (result.status === 'ok' && result.delayMs !== undefined) {
        success += 1
        totalDelay += result.delayMs
      } else {
        failed += 1
      }
    })
    return {
      success,
      failed,
      total: success + failed,
      average: success ? Math.round(totalDelay / success) : 0,
      successRate: success + failed ? (success / (success + failed)) * 100 : 0,
    }
  }, [resultSnapshot])

  const targetSummary = useMemo(() => enabledTargets.map((target) => {
    let bestNode = ''
    let bestDelay = Number.POSITIVE_INFINITY
    let success = 0
    visibleNodes.forEach((node) => {
      const result = resultSnapshot.values.get(resultKey(node.name, target.id))
      if (result?.status === 'ok' && result.delayMs !== undefined) {
        success += 1
        if (result.delayMs < bestDelay) {
          bestDelay = result.delayMs
          bestNode = node.name
        }
      }
    })
    return { target, bestNode, bestDelay, success }
  }), [enabledTargets, resultSnapshot, visibleNodes])

  const cancelTest = useCallback(() => {
    runIdRef.current += 1
    setIsTesting(false)
    setMessageTone('info')
    setMessage('已停止创建新的测速任务；正在执行的少量请求会自然结束。')
  }, [])

  const runLatencyTest = useCallback(async () => {
    if (!isTauriRuntime()) {
      setMessageTone('info')
      setMessage('请打开桌面 EXE 执行真实代理测速。')
      return
    }
    if (!enabledTargets.length) {
      setMessageTone('error')
      setMessage('请至少启用一个有效 Base URL。')
      return
    }
    const saved = await saveSettings(true)
    if (!saved) {
      return
    }
    const selectedIds = new Set(saved.selectedSubscriptionIds)
    const selectedSavedSubscriptions = saved.subscriptions.filter((subscription) => selectedIds.has(subscription.id))
    const imported = new Set(selectedSavedSubscriptions.flatMap((subscription) => subscription.nodeNames))
    let currentNodes = nodes
    const needsProxyNodes = !saved.onlyImportedNodes || imported.size > 0
    if (!currentNodes.length && needsProxyNodes) {
      currentNodes = (await loadNodes(saved.includeLocalTest)) ?? []
    }
    const proxyCandidates = saved.useManagedEngine
      ? currentNodes
      : saved.onlyImportedNodes
      ? nodesForSubscriptions(currentNodes, selectedSavedSubscriptions)
      : currentNodes
    const candidates = saved.includeLocalTest ? [LOCAL_DIRECT_NODE, ...proxyCandidates] : proxyCandidates
    const query = nodeQuery.trim().toLowerCase()
    const testNodes = candidates.filter((node) => {
      const queryMatches = !query || node.name.toLowerCase().includes(query) || node.proxyType.toLowerCase().includes(query)
      const stat = rowStats.get(node.name)
      const filterMatches = resultFilter === 'all'
        || (resultFilter === 'alive' && node.alive !== false)
        || (resultFilter === 'failed' && Boolean(stat?.failed))
      return queryMatches && filterMatches
    })
    if (!testNodes.length) {
      setMessageTone('error')
      setMessage(saved.onlyImportedNodes
        ? saved.selectedSubscriptionIds.length
          ? '所选机场的节点名称与当前 Mihomo 控制器没有匹配项。请先在 Clash Verge 更新对应订阅，或关闭“仅所选机场”。'
          : '请至少选择一个机场，或启用“包含本地直连”。'
        : '当前筛选条件下没有可测速路线。')
      return
    }

    const tasks = testNodes.flatMap((node) => enabledTargets.map((target) => ({ node, target })))
    const runId = runIdRef.current + 1
    runIdRef.current = runId
    resultsRef.current = new Map()
    progressRef.current = { completed: 0, total: tasks.length }
    setProgress({ ...progressRef.current })
    setResultsVersion((version) => version + 1)
    setIsTesting(true)
    setMessageTone('info')
    setMessage(`正在通过 ${testNodes.length} 条路线测试 ${enabledTargets.length} 个 Base URL${saved.includeLocalTest ? '，包含本地直连' : ''}，不会切换当前代理。`)

    let cursor = 0
    const worker = async () => {
      while (runIdRef.current === runId) {
        const index = cursor
        cursor += 1
        const task = tasks[index]
        if (!task) {
          return
        }
        let result: ProxyDelayResult
        try {
          result = isLocalDirectNode(task.node)
            ? await testDirectDelay({
                targetUrl: normalizeUrl(task.target.url),
                timeoutMs: saved.timeoutMs,
              })
            : await testProxyDelay({
                node: task.node.name,
                targetUrl: normalizeUrl(task.target.url),
                timeoutMs: saved.timeoutMs,
              })
        } catch (error) {
          result = {
            node: task.node.name,
            targetUrl: task.target.url,
            status: 'error',
            durationMs: 0,
            detail: errorMessage(error),
          }
        }
        if (runIdRef.current !== runId) {
          return
        }
        resultsRef.current.set(resultKey(task.node.name, task.target.id), result)
        progressRef.current.completed += 1
        scheduleFlush()
      }
    }
    const workerCount = Math.min(saved.concurrency, tasks.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    if (runIdRef.current === runId) {
      flushResults()
      setIsTesting(false)
      setLastTestAt(Date.now())
      setMessageTone('success')
      setMessage('本轮测试路线 × Base URL 延迟测试已完成。')
    }
  }, [enabledTargets, flushResults, loadNodes, nodeQuery, nodes, resultFilter, rowStats, saveSettings, scheduleFlush])

  const progressPercent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0

  return (
    <div className="proxy-latency-page">
      <section className="proxy-summary-strip" aria-label="代理测速概况">
        <div>
          <span><RadioTower size={14} /> 控制器</span>
          <strong className={`proxy-state-${controllerState}`}>
            {controllerState === 'online' ? '已连接' : controllerState === 'loading' ? '连接中' : controllerState === 'error' ? '未连接' : '待连接'}
          </strong>
          <em>{controllerVersion || (isTauriRuntime() ? 'Mihomo / Clash Meta' : '桌面端执行真实测速')}</em>
        </div>
        <div>
          <span><Import size={14} /> 已选机场</span>
          <strong>{selectedSubscriptions.length}/{config.subscriptions.length}</strong>
          <em>{importedNodeNames.size.toLocaleString('zh-CN')} 个所选节点 · 共 {allImportedNodeNames.size.toLocaleString('zh-CN')} 个</em>
        </div>
        <div>
          <span><Network size={14} /> 可测速路线</span>
          <strong>{scopedNodes.length}</strong>
          <em>{useManagedEngine
            ? `内置引擎 ${nodes.length} 个${includeLocalTest ? ' + 本地' : ''}`
            : importedFilterActive
              ? `所选机场匹配 ${matchedNodes.length} 个${includeLocalTest ? ' + 本地' : ''}`
              : `控制器 ${nodes.length} 个${includeLocalTest ? ' + 本地' : ''}`}</em>
        </div>
        <div>
          <span><CircleGauge size={14} /> 本轮结果</span>
          <strong>{resultSummary.total ? `${resultSummary.average} ms` : '-'}</strong>
          <em>{resultSummary.total ? `成功率 ${resultSummary.successRate.toFixed(1)}%` : '尚未开始测速'}</em>
        </div>
      </section>

      {message && (
        <div className={`proxy-message proxy-message-${messageTone}`}>
          {messageTone === 'success' ? <Check size={15} /> : messageTone === 'error' ? <X size={15} /> : <Activity size={15} />}
          <span>{message}</span>
          <button type="button" aria-label="关闭提示" title="关闭提示" onClick={() => setMessage('')}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="proxy-config-grid">
        <section className="proxy-panel proxy-controller-panel">
          <header>
            <div><RadioTower size={17} /><h2>本机控制器</h2></div>
            <span className={`proxy-controller-dot ${controllerState}`} />
          </header>
          <div className="proxy-panel-body">
            <ControllerModeSwitch disabled={managedStatus.running} value={controllerMode} onChange={(mode) => {
              setUseManagedEngine(false)
              setControllerMode(mode)
              setControllerEndpoint(mode === 'namedPipe' ? String.raw`\\.\pipe\verge-mihomo` : 'http://127.0.0.1:9090')
            }} />
            <div className={managedStatus.running ? 'proxy-managed-engine active' : 'proxy-managed-engine'}>
              <div>
                <Cpu size={16} />
                <span>
                  <strong>内置测试引擎</strong>
                  <em>{managedStatus.running ? `运行中${managedStatus.version ? ` · ${managedStatus.version}` : ''}` : managedStatus.detail}</em>
                </span>
              </div>
              <button
                className={managedStatus.running ? 'danger' : 'primary'}
                type="button"
                onClick={managedStatus.running ? disableManagedEngine : enableManagedEngine}
                disabled={managedBusy || controllerState === 'loading' || subscriptionBusyId !== null}
              >
                {managedBusy ? <LoaderCircle className="spin" size={14} /> : managedStatus.running ? <Square size={12} /> : <Download size={14} />}
                {managedBusy ? '处理中' : managedStatus.running ? '停用' : managedStatus.installed ? '启动' : '安装并启用'}
              </button>
              <small>无需安装 Clash；首次从 MetaCubeX 官方 GitHub 下载独立 Mihomo 核心，不修改系统代理。</small>
            </div>
            <label className="proxy-field">
              <span>{controllerMode === 'namedPipe' ? '命名管道' : 'External Controller'}</span>
              <input disabled={managedStatus.running} value={controllerEndpoint} onChange={(event) => setControllerEndpoint(event.target.value)} spellCheck={false} />
            </label>
            <label className="proxy-field">
              <span>Secret {config.controller.hasSecret && !clearControllerSecret ? '（已保存）' : '（可选）'}</span>
              <input
                type="password"
                disabled={managedStatus.running}
                value={controllerSecret}
                placeholder={config.controller.hasSecret && !clearControllerSecret ? '留空保持原 Secret' : '控制器未设置可留空'}
                onChange={(event) => {
                  setControllerSecret(event.target.value)
                  setClearControllerSecret(false)
                }}
                autoComplete="off"
              />
            </label>
            {config.controller.hasSecret && !managedStatus.running && (
              <label className="proxy-checkline">
                <input type="checkbox" checked={clearControllerSecret} onChange={(event) => setClearControllerSecret(event.target.checked)} />
                <span>清除已保存 Secret</span>
              </label>
            )}
            <div className="proxy-button-row">
              <button type="button" onClick={discoverControllers} disabled={discovering || managedStatus.running}>
                <Search size={15} />
                {discovering ? '发现中' : '自动发现'}
              </button>
              <button className="primary" type="button" onClick={connectController} disabled={configBusy || controllerState === 'loading' || managedStatus.running}>
                {controllerState === 'loading' ? <LoaderCircle className="spin" size={15} /> : <Wifi size={15} />}
                {managedStatus.running ? '请先停用内置引擎' : '连接节点'}
              </button>
            </div>
            {discoveredControllers.length > 0 && (
              <div className="proxy-discovery-list">
                {discoveredControllers.slice(0, 4).map((candidate) => (
                  <button
                    className={candidate.available ? 'available' : ''}
                    type="button"
                    key={`${candidate.mode}-${candidate.endpoint}`}
                    onClick={() => {
                      setControllerMode(candidate.mode)
                      setControllerEndpoint(candidate.endpoint)
                    }}
                  >
                    <span>{candidate.available ? <Check size={13} /> : <X size={13} />}{candidate.label}</span>
                    <em>{candidate.version || candidate.detail}</em>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="proxy-panel proxy-subscription-panel">
          <header>
            <div><Import size={17} /><h2>代理订阅</h2></div>
            <span>已选 {selectedSubscriptions.length}/{config.subscriptions.length}</span>
          </header>
          <div className="proxy-panel-body">
            <div className="proxy-import-fields">
              <label className="proxy-field">
                <span>订阅名称</span>
                <input value={subscriptionName} placeholder="例如：工作节点" onChange={(event) => setSubscriptionName(event.target.value)} />
              </label>
              <label className="proxy-field">
                <span>订阅 URL</span>
                <input
                  type="password"
                  value={subscriptionUrl}
                  placeholder="粘贴 Clash / Base64 订阅地址"
                  onChange={(event) => setSubscriptionUrl(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <button className="proxy-wide-button primary" type="button" onClick={importSubscription} disabled={subscriptionBusyId !== null}>
                {subscriptionBusyId === 'new' ? <LoaderCircle className="spin" size={15} /> : <Import size={15} />}
                导入并解析节点
              </button>
            </div>
            {config.subscriptions.length > 0 && (
              <div className="proxy-subscription-selection">
                <span>选择一个或多个机场参与测速</span>
                <div>
                  <button type="button" onClick={selectAllSubscriptions} disabled={selectedSubscriptions.length === config.subscriptions.length}>全选</button>
                  <button type="button" onClick={clearSubscriptionSelection} disabled={!selectedSubscriptions.length}>清空</button>
                  <button type="button" onClick={selectLocalOnly} disabled={!selectedSubscriptions.length && onlyImportedNodes && includeLocalTest}>仅本地</button>
                </div>
              </div>
            )}
            <div className="proxy-subscription-list">
              {config.subscriptions.length ? config.subscriptions.map((subscription) => {
                const used = (subscription.usage?.upload ?? 0) + (subscription.usage?.download ?? 0)
                const total = subscription.usage?.total ?? 0
                const percent = total > 0 ? Math.min(100, (used / total) * 100) : 0
                return (
                  <div className={selectedSubscriptionIdSet.has(subscription.id) ? 'proxy-subscription-row selected' : 'proxy-subscription-row'} key={subscription.id}>
                    <input
                      className="proxy-subscription-enabled"
                      type="checkbox"
                      checked={selectedSubscriptionIdSet.has(subscription.id)}
                      aria-label={`选择机场 ${subscription.name}`}
                      onChange={(event) => toggleSubscriptionSelection(subscription.id, event.target.checked)}
                    />
                    <div className="proxy-subscription-main">
                      <strong>{subscription.name}</strong>
                      <span>{subscription.urlPreview}</span>
                      <em>{subscription.nodeCount} 个节点 · {formatUpdatedAt(subscription.updatedAt)}</em>
                    </div>
                    <div className="proxy-subscription-actions">
                      <button type="button" title="仅选择此机场" aria-label={`仅选择机场 ${subscription.name}`} onClick={() => selectOnlySubscription(subscription.id)} disabled={subscriptionBusyId !== null}>
                        <Crosshair size={14} />
                      </button>
                      <button type="button" title="更新订阅" aria-label={`更新 ${subscription.name}`} onClick={() => refreshSubscription(subscription.id)} disabled={subscriptionBusyId !== null}>
                        <RefreshCw className={subscriptionBusyId === subscription.id ? 'spin' : ''} size={14} />
                      </button>
                      <button type="button" title="移除订阅" aria-label={`移除 ${subscription.name}`} onClick={() => deleteSubscription(subscription.id, subscription.name)} disabled={subscriptionBusyId !== null}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {total > 0 && (
                      <div className="proxy-subscription-usage">
                        <div><span style={{ width: `${percent}%` }} /></div>
                        <em>{formatBytes(used)} / {formatBytes(total)} · 到期 {formatExpiry(subscription.usage?.expire)}</em>
                      </div>
                    )}
                  </div>
                )
              }) : (
                <div className="proxy-empty-compact">
                  <Link2 size={18} />
                  <span>导入订阅后会按节点名称与 Mihomo 当前节点匹配。</span>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="proxy-panel proxy-target-panel">
          <header>
            <div><Globe2 size={17} /><h2>Base URL 目标</h2></div>
            <span>{enabledTargets.length} 个启用</span>
          </header>
          <div className="proxy-panel-body">
            <div className="proxy-target-actions">
              <button type="button" title="加入当前站点" onClick={addSelectedSiteTarget}><Plus size={14} />当前站点</button>
              <button type="button" title="加入全部已配置站点" onClick={addAllSiteTargets}><Network size={14} />全部站点</button>
              <button type="button" title="新增自定义 Base URL" onClick={addBlankTarget}><Plus size={14} />自定义</button>
            </div>
            <div className="proxy-target-list">
              {targets.map((target) => (
                <div className="proxy-target-row" key={target.id}>
                  <input
                    className="proxy-target-enabled"
                    type="checkbox"
                    checked={target.enabled}
                    aria-label={`启用 ${target.name}`}
                    onChange={(event) => updateTarget(target.id, { enabled: event.target.checked })}
                  />
                  <div>
                    <input value={target.name} aria-label="目标名称" onChange={(event) => updateTarget(target.id, { name: event.target.value })} />
                    <input className={!validHttpUrl(target.url) ? 'invalid' : ''} value={target.url} aria-label="Base URL" spellCheck={false} onChange={(event) => updateTarget(target.id, { url: event.target.value })} />
                  </div>
                  <button type="button" title="删除目标" aria-label={`删除 ${target.name}`} onClick={() => removeTarget(target.id)}><Trash2 size={14} /></button>
                </div>
              ))}
              {!targets.length && (
                <div className="proxy-empty-compact"><Globe2 size={18} /><span>加入当前站点或添加自定义 Base URL。</span></div>
              )}
            </div>
            <div className="proxy-test-options">
              <label>
                <span>超时</span>
                <select value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))}>
                  <option value={3000}>3 秒</option>
                  <option value={5000}>5 秒</option>
                  <option value={8000}>8 秒</option>
                  <option value={12000}>12 秒</option>
                  <option value={20000}>20 秒</option>
                </select>
              </label>
              <label>
                <span>并发</span>
                <select value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>
                  {[2, 4, 6, 8, 12, 16].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="proxy-checkline compact">
                <input
                  type="checkbox"
                  checked={onlyImportedNodes}
                  onChange={(event) => {
                    setOnlyImportedNodes(event.target.checked)
                    resultsRef.current.clear()
                    setResultsVersion((version) => version + 1)
                  }}
                />
                <span>仅所选机场</span>
              </label>
              <label className="proxy-checkline compact">
                <input type="checkbox" checked={includeLocalTest} onChange={(event) => toggleLocalTest(event.target.checked)} />
                <span>包含本地直连</span>
              </label>
            </div>
            <button className="proxy-wide-button" type="button" onClick={() => saveSettings(false)} disabled={configBusy}>
              {configBusy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
              保存测速设置
            </button>
          </div>
        </section>
      </div>

      <section className="proxy-panel proxy-matrix-panel">
        <header className="proxy-matrix-header">
          <div><Gauge size={17} /><h2>节点 × Base URL 延迟矩阵</h2></div>
          <div className="proxy-matrix-actions">
            <button type="button" onClick={() => downloadResultsCsv(visibleNodes, enabledTargets, resultsRef.current)} disabled={!resultSummary.total}>
              <Download size={14} />导出 CSV
            </button>
            {isTesting ? (
              <button className="danger" type="button" onClick={cancelTest}><Square size={13} />停止</button>
            ) : (
              <button className="primary" type="button" onClick={runLatencyTest} disabled={!enabledTargets.length || (controllerState === 'loading' && !includeLocalTest)}>
                <Zap size={14} />开始测速
              </button>
            )}
          </div>
        </header>

        <div className="proxy-matrix-toolbar">
          <label className="proxy-search-field">
            <Search size={14} />
            <input value={nodeQuery} placeholder="筛选路线名称或协议" onChange={(event) => setNodeQuery(event.target.value)} />
          </label>
          <label>
            <span>状态</span>
            <select value={resultFilter} onChange={(event) => setResultFilter(event.target.value as ResultFilter)}>
              <option value="all">全部路线</option>
              <option value="alive">可用路线</option>
              <option value="failed">本轮失败</option>
            </select>
            <ChevronDown size={13} />
          </label>
          <label>
            <span>排序</span>
            <select
              value={resultSort}
              onChange={(event) => {
                setResultSort(event.target.value as ResultSort)
                setRouteSort(null)
              }}
            >
              <option value="latency">平均延迟</option>
              <option value="success">成功目标数</option>
              <option value="name">路线名称</option>
            </select>
            <ChevronDown size={13} />
          </label>
          <div className="proxy-matrix-count">
            <strong>{visibleNodes.length}</strong> 条路线 × <strong>{enabledTargets.length}</strong> 个目标
          </div>
          <div className="proxy-no-switch"><ShieldCheck size={14} />不切换当前代理</div>
        </div>

        {(isTesting || progress.total > 0) && (
          <div className="proxy-progress-row">
            <div><span style={{ width: `${progressPercent}%` }} /></div>
            <strong>{progress.completed}/{progress.total}</strong>
            <em>{isTesting ? `测速中 ${progressPercent}%` : `完成于 ${lastTestAt ? new Date(lastTestAt).toLocaleTimeString('zh-CN', { hour12: false }) : '-'}`}</em>
          </div>
        )}

        {targetSummary.some((summary) => summary.success > 0) && (
          <div className="proxy-best-targets">
            {targetSummary.map(({ target, bestNode, bestDelay, success }) => (
              <div key={target.id}>
                <span>{target.name}</span>
                <strong title={bestNode}>{bestNode || '暂无可用路线'}</strong>
                <em>{Number.isFinite(bestDelay) ? `${bestDelay} ms · ${success} 条成功` : '全部失败'}</em>
              </div>
            ))}
          </div>
        )}

        <div className="proxy-matrix-wrap">
          {visibleNodes.length && enabledTargets.length ? (
            <table className="proxy-matrix-table">
              <thead>
                <tr>
                  <th className="proxy-node-column">测试路线</th>
                  <th className="proxy-average-column">平均</th>
                  {enabledTargets.map((target) => {
                    const direction = routeSort?.targetId === target.id ? routeSort.direction : null
                    const sortTitle = direction === 'asc'
                      ? `${target.name}当前为延迟正序，点击切换为倒序`
                      : direction === 'desc'
                        ? `${target.name}当前为延迟倒序，点击恢复平均延迟排序`
                        : `按${target.name}延迟正序排列`
                    return (
                      <th key={target.id} aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}>
                        <div className="proxy-route-heading">
                          <strong title={target.name}>{target.name}</strong>
                          <button
                            className={direction ? 'proxy-route-sort active' : 'proxy-route-sort'}
                            type="button"
                            title={sortTitle}
                            aria-label={sortTitle}
                            onClick={() => cycleRouteSort(target.id)}
                          >
                            {direction === 'asc' ? <ChevronUp size={14} /> : direction === 'desc' ? <ChevronDown size={14} /> : <ChevronsUpDown size={14} />}
                          </button>
                        </div>
                        <span className="proxy-route-url" title={target.url}>{target.url}</span>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {visibleNodes.map((node) => {
                  const stat = rowStats.get(node.name)
                  return (
                    <tr key={node.name}>
                      <th className="proxy-node-column">
                        <span className={isLocalDirectNode(node) ? 'proxy-node-dot local' : node.alive === false ? 'proxy-node-dot down' : 'proxy-node-dot'} />
                        <div>
                          <strong title={node.name}>{node.name}</strong>
                          <span>{isLocalDirectNode(node) ? <><Monitor size={10} /> 当前网络 · 不经过 Mihomo</> : <>{node.proxyType}{node.udp ? ' · UDP' : ''}</>}</span>
                        </div>
                      </th>
                      <td className="proxy-average-column">
                        <strong>{stat && Number.isFinite(stat.average) ? `${Math.round(stat.average)} ms` : '-'}</strong>
                        <span>{stat ? `${stat.success}/${enabledTargets.length}` : '-'}</span>
                      </td>
                      {enabledTargets.map((target) => {
                        const result = resultsRef.current.get(resultKey(node.name, target.id))
                        return (
                          <td key={target.id}>
                            <div className={`proxy-latency-cell ${latencyTone(result)}`} title={result?.detail || '尚未测试'}>
                              {result?.status === 'ok' && result.delayMs !== undefined ? (
                                <><strong>{result.delayMs}</strong><span>ms</span></>
                              ) : result ? (
                                <><strong>{statusLabel(result.status)}</strong><span>{result.status === 'timeout' ? 'TIMEOUT' : 'ERROR'}</span></>
                              ) : (
                                <><strong>-</strong><span>等待</span></>
                              )}
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <div className="proxy-matrix-empty">
              <CircleGauge size={28} />
              <strong>{nodes.length || includeLocalTest ? '没有符合筛选条件的路线' : '尚未读取代理节点'}</strong>
              <span>{nodes.length || includeLocalTest ? '调整机场选择、节点筛选或启用本地直连。' : '确认 Clash Verge / Mihomo 正在运行，或启用“包含本地直连”。'}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
