import type { RequestResult, SourceStatus } from '../types'

export type PlainRecord = Record<string, unknown>

export function asRecord(value: unknown): PlainRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as PlainRecord) : null
}

/** 把可能是字符串化 JSON 的字段解析成对象，兼容 New API 的 other 字段等。 */
export function parseMaybeJsonRecord(value: unknown): PlainRecord | null {
  if (asRecord(value)) {
    return value as PlainRecord
  }

  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  const candidate = !trimmed.startsWith('{') && /"[^"]+"\s*:/.test(trimmed)
    ? `{${trimmed.replace(/^[^{"]*/, '').replace(/}?\s*$/, '')}}`
    : trimmed
  if (!candidate || (!candidate.startsWith('{') && !candidate.startsWith('['))) {
    return null
  }

  try {
    return asRecord(JSON.parse(candidate) as unknown)
  } catch {
    return null
  }
}

export function pickNumber(record: PlainRecord | null, keys: string[]) {
  if (!record) {
    return undefined
  }

  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') {
      continue
    }
    const numberValue = typeof value === 'string' ? Number(value.replace(/,/g, '')) : Number(value)
    if (Number.isFinite(numberValue)) {
      return numberValue
    }
  }

  return undefined
}

export function pickNumberWithKey(record: PlainRecord | null, keys: string[]) {
  if (!record) {
    return undefined
  }

  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') {
      continue
    }
    const numberValue = typeof value === 'string' ? Number(value.replace(/,/g, '')) : Number(value)
    if (Number.isFinite(numberValue)) {
      return { key, value: numberValue }
    }
  }

  return undefined
}

export function pickString(record: PlainRecord | null, keys: string[], fallback = '') {
  if (!record) {
    return fallback
  }

  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    if (typeof value === 'number') {
      return String(value)
    }
  }

  return fallback
}

/** 展开一层 data 包裹。 */
export function unwrapData(value: unknown): unknown {
  const record = asRecord(value)
  if (!record) {
    return value
  }
  return 'data' in record ? record.data : value
}

/** 从多种返回结构中提取列表。 */
export function extractList(value: unknown): unknown[] {
  const unwrapped = unwrapData(value)
  if (Array.isArray(unwrapped)) {
    return unwrapped
  }

  const record = asRecord(unwrapped)
  if (!record) {
    return []
  }

  for (const key of ['items', 'logs', 'tokens', 'models', 'records', 'list', 'rows']) {
    const candidate = record[key]
    if (Array.isArray(candidate)) {
      return candidate
    }
  }

  return []
}

/**
 * 递归收集嵌套记录，兼容 New API / One API 把用量埋在
 * other / prompt_tokens_details / usage 等字段（含字符串化 JSON）的情况。
 */
export function collectNestedRecords(record: PlainRecord | null) {
  const records: PlainRecord[] = []
  const seen = new Set<PlainRecord>()
  const keys = [
    'other',
    'details',
    'detail',
    'usage',
    'metadata',
    'meta',
    'extra',
    'raw',
    'billing',
    'billing_info',
    'billingInfo',
    'billing_detail',
    'billingDetail',
    'subscription',
    'subscriptions',
    'subscription_info',
    'subscriptionInfo',
    'subscription_detail',
    'subscriptionDetail',
    'subscription_instance',
    'subscriptionInstance',
    'prompt_tokens_details',
    'promptTokensDetails',
    'completion_tokens_details',
    'completionTokensDetails',
  ]

  const visit = (candidate: PlainRecord | null, depth: number) => {
    if (!candidate || depth > 3 || seen.has(candidate)) {
      return
    }

    seen.add(candidate)
    records.push(candidate)

    keys.forEach((key) => {
      const nested = parseMaybeJsonRecord(candidate[key])
      if (nested) {
        visit(nested, depth + 1)
      }
      const list = candidate[key]
      if (Array.isArray(list)) {
        list.forEach((item) => visit(asRecord(item), depth + 1))
      }
    })
  }

  visit(record, 0)
  return records
}

export function pickNumberDeep(records: PlainRecord[], keys: string[]) {
  for (const record of records) {
    const result = pickNumber(record, keys)
    if (result !== undefined) {
      return result
    }
  }
  return undefined
}

export function pickNumberDeepWithKey(records: PlainRecord[], keys: string[]) {
  for (const record of records) {
    const result = pickNumberWithKey(record, keys)
    if (result) {
      return result
    }
  }
  return undefined
}

export function pickStringDeep(records: PlainRecord[], keys: string[], fallback = '') {
  for (const record of records) {
    const result = pickString(record, keys)
    if (result) {
      return result
    }
  }
  return fallback
}

/** 缓存字段有多套命名与形态，统一在此归一化。 */
const CACHE_CREATION_KEYS = [
  'cache_creation_input_tokens',
  'cache_creation_input_token',
  'cache_creation_tokens',
  'cache_creation',
  'cache_write_input_tokens',
  'cache_write_tokens',
  'cache_write',
  'cacheCreateTokens',
  'cacheCreate',
  'write_cache_tokens',
]

const CACHE_HIT_KEYS = [
  'cache_tokens',
  'cache_read_input_tokens',
  'cache_read_input_token',
  'cache_read_tokens',
  'cache_read',
  'cached_tokens',
  'cached_input_tokens',
  'cache_hit_tokens',
  'cache_hit',
  'cacheReadTokens',
  'cacheRead',
  'read_cache_tokens',
]

/**
 * Anthropic 风格里 cache_creation_input_tokens / cache_read_input_tokens 是
 * 独立于 input 之外的额外 token，需要额外累加；而 New API 的 cache_tokens 通常
 * 已包含在 input 内，不重复累加。
 */
const ADDITIVE_CACHE_KEYS = new Set([
  'cache_creation_input_tokens',
  'cache_creation_input_token',
  'cache_read_input_tokens',
  'cache_read_input_token',
])

export type CacheTokens = {
  cacheCreation: number
  cacheHit: number
  /** 缓存 token 是否需要额外累加进总量。 */
  additive: boolean
}

export function normalizeCacheTokens(records: PlainRecord[]): CacheTokens {
  const creationPick = pickNumberDeepWithKey(records, CACHE_CREATION_KEYS)
  const hitPick = pickNumberDeepWithKey(records, CACHE_HIT_KEYS)
  const additive =
    Boolean(creationPick && ADDITIVE_CACHE_KEYS.has(creationPick.key)) ||
    Boolean(hitPick && ADDITIVE_CACHE_KEYS.has(hitPick.key))

  return {
    cacheCreation: creationPick?.value ?? 0,
    cacheHit: hitPick?.value ?? 0,
    additive,
  }
}

/** 把 quota 原始值折算成货币金额。 */
export function quotaToCurrency(value: number | undefined) {
  if (!Number.isFinite(value)) {
    return 0
  }
  const safeValue = Number(value)
  return Math.abs(safeValue) > 1000 ? safeValue / 500000 : safeValue
}

/** New API 的 quota/抵扣字段始终使用 500000 额度 = 1 美元。 */
export function quotaUnitsToCurrency(value: number | undefined) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Number(value) / 500000
}

/**
 * 根据 HTTP 结果与业务错误，将接口来源分类为
 * OK / 权限不足 / 超时 / 失败，供设置页“接口来源”精确展示。
 */
export function classifySource(result: RequestResult, apiError: string | null): SourceStatus {
  if (result.ok && !apiError) {
    return 'ok'
  }
  if (result.status === 401 || result.status === 403) {
    return 'forbidden'
  }
  if (result.status === 0) {
    const text = (result.statusText || '').toLowerCase()
    if (text.includes('abort') || text.includes('timeout') || text.includes('timed out')) {
      return 'timeout'
    }
  }
  return 'fail'
}
