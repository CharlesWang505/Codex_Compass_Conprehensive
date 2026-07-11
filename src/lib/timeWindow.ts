export type TimeRange = 'today' | '24h' | '7d' | '30d' | 'custom'

export type TimeWindow = {
  startMs: number
  endMs: number
  label: string
  valid: boolean
}

export const DAY_MS = 24 * 60 * 60 * 1000

function parseDateTimeInput(value: string) {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

export function buildTimeWindow(
  range: TimeRange,
  customStart: string,
  customEnd: string,
  now = Date.now(),
): TimeWindow {
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)

  if (range === 'today') {
    return { startMs: todayStart.getTime(), endMs: now, label: '今天', valid: true }
  }
  if (range === '7d') {
    return { startMs: now - 7 * DAY_MS, endMs: now, label: '近 7 天', valid: true }
  }
  if (range === '30d') {
    return { startMs: now - 30 * DAY_MS, endMs: now, label: '近 30 天', valid: true }
  }
  if (range === 'custom') {
    const startMs = parseDateTimeInput(customStart)
    const endMs = parseDateTimeInput(customEnd)
    return {
      startMs,
      endMs,
      label: '自定义时间',
      valid: Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs,
    }
  }
  return { startMs: now - DAY_MS, endMs: now, label: '近 24 小时', valid: true }
}

export function timeWindowKey(window: TimeWindow) {
  return `${Math.floor(window.startMs / 1000)}:${Math.floor(window.endMs / 1000)}:${window.label}`
}
