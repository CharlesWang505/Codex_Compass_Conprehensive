import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { validateMappings } from '../src/features/codex/hotSwitch/mappingValidation.ts'
import { setContextEnabled } from '../src/features/codex/context/contextTypes.ts'
import { removeRelayProfileFromSettings } from '../src/features/codex/providers/providerSettings.ts'
import {
  configuredModelNames,
  normalizeModelImageHandling,
  parseModelImageHandling,
  updateModelImageHandling,
} from '../src/features/codex/providers/modelImageHandling.ts'
import {
  MODEL_HEALTH_COMMANDS,
  MODEL_HEALTH_EVENTS,
  modelHealthControlState,
  modelHealthNoticeFromEvent,
  modelHealthSummary,
  modelHealthTimestamp,
  modelHealthTone,
} from '../src/features/codex/providers/modelHealth.ts'
import { normalizeDurationValueMs } from '../src/lib/duration.ts'
import { buildTimeWindow, DAY_MS } from '../src/lib/timeWindow.ts'
import { summarizeWorkspacePermissions } from '../src/features/remote-control/workspacePermissions.ts'

const profiles = [
  { id: 'relay-a', name: 'A', relayMode: 'pureApi' },
  { id: 'relay-b', name: 'B', relayMode: 'pureApi' },
  { id: 'aggregate', name: 'Aggregate', relayMode: 'aggregate' },
]
const codexTypesSource = readFileSync(
  new URL('../src/features/codex/types.ts', import.meta.url),
  'utf8',
)

test('valid model mapping accepts a real primary provider and unique fallbacks', () => {
  const result = validateMappings([{
    model: 'gpt-5',
    upstreamModel: 'gpt-5-2025',
    relayId: 'relay-a',
    candidateRelayIds: ['relay-b'],
    fallbackRelayIds: ['relay-b'],
  }], profiles)
  assert.equal(result.valid, true)
  assert.deepEqual(result.messages, [])
})

test('mapping validation rejects duplicate aliases and invalid fallback chains', () => {
  const result = validateMappings([
    { model: 'gpt-5', upstreamModel: 'one', relayId: 'relay-a', candidateRelayIds: [], fallbackRelayIds: ['relay-a', 'missing', 'missing'] },
    { model: 'gpt-5', upstreamModel: '', relayId: 'relay-a', candidateRelayIds: [], fallbackRelayIds: [] },
  ], profiles)
  assert.equal(result.valid, false)
  assert.ok(result.messages.some((message) => message.includes('模型别名“gpt-5”在同一首选供应商中重复')))
  assert.ok(result.messages.some((message) => message.includes('备用供应商不能包含首选供应商')))
  assert.ok(result.messages.some((message) => message.includes('备用供应商 missing 不存在')))
  assert.ok(result.messages.some((message) => message.includes('上游模型不能为空')))
})

test('mapping validation allows the same Codex alias for different providers', () => {
  const result = validateMappings([
    { model: 'gpt-5', upstreamModel: 'gpt-5', relayId: 'relay-a', candidateRelayIds: ['relay-a', 'relay-b'], fallbackRelayIds: [] },
    { model: 'gpt-5', upstreamModel: 'gpt-5', relayId: 'relay-b', candidateRelayIds: ['relay-a', 'relay-b'], fallbackRelayIds: [] },
  ], profiles)

  assert.equal(result.valid, true)
  assert.deepEqual(result.messages, [])
})

test('mapping validation reserves the Codex Compass auto model alias', () => {
  const result = validateMappings([{
    model: 'codex-compass-auto',
    upstreamModel: 'real-model',
    relayId: 'relay-a',
    candidateRelayIds: ['relay-a'],
    fallbackRelayIds: [],
  }], profiles)

  assert.equal(result.valid, false)
  assert.ok(result.messages.some((message) => message.includes('自动模型保留名称')))
})

test('context toggle replaces root flags without changing nested table flags', () => {
  const source = 'enabled = false\ndisabled = true\ncommand = "node"\n\n[environment]\ndisabled = true\n'
  const enabled = setContextEnabled(source, true)
  const rootSection = enabled.split('[environment]')[0]
  assert.match(enabled, /^enabled = true/m)
  assert.doesNotMatch(rootSection, /^disabled = true/m)
  assert.match(enabled, /\[environment\]\ndisabled = true/)
})

test('rolling 24-hour window uses the supplied refresh time', () => {
  const now = Date.parse('2026-07-11T08:30:00.000Z')
  const window = buildTimeWindow('24h', '', '', now)

  assert.equal(window.startMs, now - DAY_MS)
  assert.equal(window.endMs, now)
  assert.equal(window.valid, true)
})

test('rolling window advances both boundaries on a later refresh', () => {
  const firstNow = Date.parse('2026-07-11T08:30:00.000Z')
  const secondNow = firstNow + 15 * 60_000
  const first = buildTimeWindow('24h', '', '', firstNow)
  const second = buildTimeWindow('24h', '', '', secondNow)

  assert.equal(second.startMs - first.startMs, 15 * 60_000)
  assert.equal(second.endMs - first.endMs, 15 * 60_000)
})

test('custom window remains fixed when refresh time advances', () => {
  const customStart = '2026-07-01T09:00'
  const customEnd = '2026-07-02T18:30'
  const first = buildTimeWindow('custom', customStart, customEnd, Date.parse('2026-07-11T08:30:00.000Z'))
  const second = buildTimeWindow('custom', customStart, customEnd, Date.parse('2026-07-12T08:30:00.000Z'))

  assert.deepEqual(second, first)
  assert.equal(first.valid, true)
})

test('usage log keeps New API frt values in milliseconds', () => {
  assert.equal(normalizeDurationValueMs('frt', 3136), 3136)
  assert.equal(normalizeDurationValueMs('ttft', 3339), 3339)
})

test('usage log still accepts fractional frt values in seconds', () => {
  assert.equal(normalizeDurationValueMs('frt', 3.339), 3339)
  assert.equal(normalizeDurationValueMs('ttft', 3.136), 3136)
})

test('workspace permission summary supports checked and indeterminate master states', () => {
  const workspaces = [
    { allowWrite: true, allowCommands: true, allowUploads: false },
    { allowWrite: true, allowCommands: false, allowUploads: false },
  ]

  assert.deepEqual(
    summarizeWorkspacePermissions(workspaces, ['allowWrite']),
    { checked: true, indeterminate: false },
  )
  assert.deepEqual(
    summarizeWorkspacePermissions(workspaces, ['allowCommands']),
    { checked: false, indeterminate: true },
  )
  assert.deepEqual(
    summarizeWorkspacePermissions(
      workspaces,
      ['allowWrite', 'allowCommands', 'allowUploads'],
    ),
    { checked: false, indeterminate: true },
  )
  assert.deepEqual(
    summarizeWorkspacePermissions([], ['allowWrite']),
    { checked: false, indeterminate: false },
  )
})

test('removing a provider persists a clean replacement settings shape', () => {
  const settings = {
    relayProfiles: [
      { id: 'relay-a', relayMode: 'pureApi' },
      { id: 'relay-b', relayMode: 'pureApi' },
      { id: 'aggregate', relayMode: 'aggregate' },
    ],
    aggregateRelayProfiles: [{
      id: 'aggregate',
      name: 'Aggregate',
      strategy: 'failover',
      members: [{ relayId: 'relay-a', weight: 1 }, { relayId: 'relay-b', weight: 1 }],
    }],
    activeRelayId: 'relay-a',
    activeAggregateRelayId: '',
    hotSwitchRelayId: 'relay-a',
    hotSwitchModelRoutingEnabled: true,
    hotSwitchModelMappings: [{
      model: 'gpt-5',
      upstreamModel: 'gpt-5',
      relayId: 'relay-a',
      candidateRelayIds: ['relay-a', 'relay-b'],
      fallbackRelayIds: ['relay-b'],
    }],
  }

  const result = removeRelayProfileFromSettings(settings, 'relay-a')

  assert.ok(result)
  assert.deepEqual(result.relayProfiles.map((profile) => profile.id), ['relay-b', 'aggregate'])
  assert.equal(result.activeRelayId, 'relay-b')
  assert.equal(result.hotSwitchRelayId, 'relay-b')
  assert.equal(result.hotSwitchModelMappings[0].relayId, 'relay-b')
  assert.deepEqual(result.hotSwitchModelMappings[0].candidateRelayIds, ['relay-b'])
  assert.deepEqual(result.aggregateRelayProfiles[0].members, [{ relayId: 'relay-b', weight: 1 }])
})

test('model image handling stores only explicit policies for configured models', () => {
  const models = 'gpt-5\nclaude-vision\ngpt-5'
  assert.deepEqual(configuredModelNames(models), ['gpt-5', 'claude-vision'])

  const withVlm = updateModelImageHandling(models, '{}', 'claude-vision', 'vlm')
  assert.deepEqual(parseModelImageHandling(withVlm), { 'claude-vision': 'vlm' })

  const withStrip = updateModelImageHandling(models, withVlm, 'gpt-5', 'strip')
  assert.deepEqual(parseModelImageHandling(withStrip), {
    'claude-vision': 'vlm',
    'gpt-5': 'strip',
  })
  assert.equal(
    normalizeModelImageHandling('gpt-5', withStrip),
    JSON.stringify({ 'gpt-5': 'strip' }),
  )
})

test('model health summary preserves disabled and paused states', () => {
  assert.equal(modelHealthSummary({
    enabled: false,
    checking: false,
    paused: true,
    availableCount: 0,
    unavailableCount: 0,
    skippedCount: 0,
  }), '已关闭')

  assert.equal(modelHealthSummary({
    enabled: true,
    checking: false,
    paused: true,
    availableCount: 0,
    unavailableCount: 0,
    skippedCount: 0,
  }), '已暂停')
})

test('model health summary prioritizes checking and reports result counts', () => {
  assert.equal(modelHealthSummary({
    enabled: true,
    checking: true,
    paused: false,
    availableCount: 0,
    unavailableCount: 0,
    skippedCount: 0,
  }), '检测中')

  assert.equal(modelHealthSummary({
    enabled: true,
    checking: false,
    paused: false,
    availableCount: 2,
    unavailableCount: 1,
    skippedCount: 3,
  }), '可用 2 · 不可用 1 · 跳过 3')
})

test('model health timestamp renders a stable local label', () => {
  assert.equal(modelHealthTimestamp(null), '尚未检测')
  assert.match(modelHealthTimestamp(Date.parse('2026-07-22T12:00:00Z')), /\d{2}:\d{2}/)
})

test('model health tone prioritizes failures and paused state', () => {
  assert.equal(modelHealthTone(null), 'info')
  assert.equal(modelHealthTone({
    enabled: true,
    checking: false,
    paused: false,
    availableCount: 2,
    unavailableCount: 1,
  }), 'error')
  assert.equal(modelHealthTone({
    enabled: true,
    checking: false,
    paused: true,
    availableCount: 2,
    unavailableCount: 0,
  }), 'warning')
  assert.equal(modelHealthTone({
    enabled: true,
    checking: false,
    paused: false,
    availableCount: 2,
    unavailableCount: 0,
  }), 'ok')
  assert.equal(modelHealthTone({
    enabled: true,
    checking: false,
    paused: true,
    availableCount: 0,
    unavailableCount: 1,
  }), 'warning')
})

test('model health command and event contracts stay aligned with Tauri', () => {
  assert.deepEqual(MODEL_HEALTH_COMMANDS, {
    status: 'get_model_health_status',
    setEnabled: 'set_model_health_check_enabled',
    runNow: 'run_model_health_check_now',
  })
  assert.deepEqual(MODEL_HEALTH_EVENTS, {
    updated: 'model-health-check:updated',
    failed: 'model-health-check:failed',
    recovered: 'model-health-check:recovered',
  })
})

test('model health controls disable unavailable runtime and paused runs', () => {
  const snapshot = {
    enabled: true,
    checking: false,
    paused: false,
  }
  assert.deepEqual(modelHealthControlState(false, false, snapshot), {
    toggleDisabled: true,
    runDisabled: true,
  })
  assert.deepEqual(modelHealthControlState(true, false, { ...snapshot, paused: true }), {
    toggleDisabled: false,
    runDisabled: true,
  })
  assert.deepEqual(modelHealthControlState(true, false, snapshot), {
    toggleDisabled: false,
    runDisabled: false,
  })
})

test('model health events map to existing floating notice tones', () => {
  assert.deepEqual(
    modelHealthNoticeFromEvent('failed', { text: '供应商不可用' }),
    { tone: 'error', text: '供应商不可用' },
  )
  assert.deepEqual(
    modelHealthNoticeFromEvent('recovered', { text: '供应商已恢复' }),
    { tone: 'ok', text: '供应商已恢复' },
  )
})

test('TypeScript mirrors the backend model routing settings contract without runtime defaults', () => {
  assert.match(codexTypesSource, /export type ModelSelectionMode = 'all' \| 'custom'/)
  assert.match(codexTypesSource, /export type ModelChannelPreference = \{[\s\S]*manualRate: number \| null[\s\S]*\}/)
  assert.match(codexTypesSource, /export type ModelRouteLock = \{[\s\S]*canonicalModel: string[\s\S]*sourceRef: string[\s\S]*\}/)
  for (const field of [
    'modelCostRoutingEnabled: boolean',
    'modelAutoFailoverEnabled: boolean',
    'modelTimeoutFailoverEnabled: boolean',
    'modelChannelPreferences: ModelChannelPreference[]',
    'modelRouteLocks: ModelRouteLock[]',
  ]) {
    assert.ok(codexTypesSource.includes(field), `missing ${field}`)
  }
  assert.doesNotMatch(codexTypesSource, /withModelRoutingDefaults|defaultModelRoutingSettings/)
})
