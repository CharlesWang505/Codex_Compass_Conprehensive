import type { ModelHealthSnapshot } from '../types'

export const MODEL_HEALTH_COMMANDS = {
  status: 'get_model_health_status',
  setEnabled: 'set_model_health_check_enabled',
  runNow: 'run_model_health_check_now',
} as const

export const MODEL_HEALTH_EVENTS = {
  updated: 'model-health-check:updated',
  failed: 'model-health-check:failed',
  recovered: 'model-health-check:recovered',
} as const

type ModelHealthSummaryInput = Pick<
  ModelHealthSnapshot,
  | 'enabled'
  | 'checking'
  | 'paused'
  | 'availableCount'
  | 'unavailableCount'
  | 'skippedCount'
>

type ModelHealthControlSnapshot = Pick<
  ModelHealthSnapshot,
  'checking' | 'paused'
>

export function modelHealthSummary(snapshot: ModelHealthSummaryInput) {
  if (!snapshot.enabled) return '已关闭'
  if (snapshot.checking) return '检测中'
  if (snapshot.paused) return '已暂停'
  if (
    snapshot.availableCount === 0
    && snapshot.unavailableCount === 0
    && snapshot.skippedCount === 0
  ) {
    return '等待首次检测'
  }
  return `可用 ${snapshot.availableCount} · 不可用 ${snapshot.unavailableCount} · 跳过 ${snapshot.skippedCount}`
}

export function modelHealthTimestamp(timestamp: number | null) {
  if (timestamp === null) return '尚未检测'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

export function modelHealthTone(
  snapshot: Pick<
    ModelHealthSnapshot,
    'enabled' | 'checking' | 'paused' | 'availableCount' | 'unavailableCount'
  > | null,
): 'ok' | 'warning' | 'error' | 'info' {
  if (!snapshot || !snapshot.enabled || snapshot.checking) return 'info'
  if (snapshot.paused) return 'warning'
  if (snapshot.unavailableCount > 0) return 'error'
  if (snapshot.availableCount > 0) return 'ok'
  return 'info'
}

export function modelHealthControlState(
  runtimeAvailable: boolean,
  busy: boolean,
  snapshot: ModelHealthControlSnapshot | null,
) {
  return {
    toggleDisabled: !runtimeAvailable || busy || !snapshot,
    runDisabled: !runtimeAvailable || busy || !snapshot || snapshot.checking || snapshot.paused,
  }
}

export function modelHealthNoticeFromEvent(
  event: 'failed' | 'recovered',
  payload: { text: string },
) {
  return {
    tone: event === 'failed' ? 'error' as const : 'ok' as const,
    text: payload.text,
  }
}
