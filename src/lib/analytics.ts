import type { UsageLog, UsageSnapshot } from '../types'

export function safeDivide(value: number, divisor: number) {
  return divisor > 0 ? value / divisor : 0
}

function pct(value: number) {
  if (!Number.isFinite(value)) {
    return '0.0%'
  }
  return `${(value * 100).toFixed(1)}%`
}

function usd(value: number) {
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4, minimumFractionDigits: 4 })}`
}

export type Recommendation = { title: string; metric: string; detail: string }

export type Analytics = ReturnType<typeof computeAnalytics>

function parseLogTime(value: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
  if (hasTimezone) {
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  const withYear = /^\d{1,2}[/-]\d{1,2}(?:\s|$)/.test(trimmed) ? `${new Date().getFullYear()}/${trimmed}` : trimmed
  const normalized = withYear
    .replace(/[年月.-]/g, '/')
    .replace(/日/g, ' ')
    .replace('T', ' ')
    .trim()
  const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?/)
  if (match) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = match
    const parsed = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime()
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  const parsed = Date.parse(withYear)
  return Number.isNaN(parsed) ? undefined : parsed
}

function cleanTokenName(name: string) {
  const trimmed = name.trim()
  if (!trimmed || ['unknown', 'unkonw', 'undefined', 'null', '-'].includes(trimmed.toLowerCase())) {
    return '未命名令牌'
  }
  return trimmed
}

/**
 * 把总览/分析页所需的派生指标集中计算，组件里只负责渲染。
 * 依赖 snapshot.logs / models / summary，纯函数便于测试与复用。
 */
export function computeAnalytics(snapshot: UsageSnapshot) {
  const logs = snapshot.logs
  const modelLatency = new Map<string, { latencyTotal: number; latencyCount: number; firstTokenTotal: number; firstTokenCount: number }>()
  const groupMap = new Map<string, { group: string; cost: number; tokens: number; requests: number; cacheHit: number }>()
  const tokenMap = new Map<string, { name: string; cost: number; tokens: number; requests: number }>()

  logs.forEach((log) => {
    if (log.latencyMs > 0 || log.firstTokenMs > 0) {
      const latency = modelLatency.get(log.model) ?? { latencyTotal: 0, latencyCount: 0, firstTokenTotal: 0, firstTokenCount: 0 }
      if (log.latencyMs > 0) {
        latency.latencyTotal += log.latencyMs
        latency.latencyCount += 1
      }
      if (log.firstTokenMs > 0) {
        latency.firstTokenTotal += log.firstTokenMs
        latency.firstTokenCount += 1
      }
      modelLatency.set(log.model, latency)
    }

    const group = groupMap.get(log.group) ?? { group: log.group, cost: 0, tokens: 0, requests: 0, cacheHit: 0 }
    group.cost += log.cost
    group.tokens += log.total
    group.requests += 1
    group.cacheHit += log.cacheHit
    groupMap.set(log.group, group)

    const tokenName = cleanTokenName(log.tokenName)
    const token = tokenMap.get(tokenName) ?? { name: tokenName, cost: 0, tokens: 0, requests: 0 }
    token.cost += log.cost
    token.tokens += log.total
    token.requests += 1
    tokenMap.set(tokenName, token)
  })

  const modelEfficiency = snapshot.models.map((model) => {
    const latency = modelLatency.get(model.model)
    const avgLatency = latency && latency.latencyCount > 0 ? latency.latencyTotal / latency.latencyCount : 0
    const avgFirstToken = latency && latency.firstTokenCount > 0 ? latency.firstTokenTotal / latency.firstTokenCount : 0
    return {
      model: model.model,
      group: model.group,
      cost: model.cost,
      tokens: model.tokens,
      requests: model.requests,
      cacheHit: model.cacheHit,
      costPer1k: safeDivide(model.cost, model.tokens / 1000),
      costPerMillion: safeDivide(model.cost, model.tokens / 1_000_000),
      cacheRate: safeDivide(model.cacheHit, model.input),
      outputShare: safeDivide(model.output, model.tokens),
      avgLatency,
      avgFirstToken,
    }
  })

  const latencyBuckets = [
    { name: '<1s', min: 0, max: 1000, count: 0, cost: 0 },
    { name: '1-2s', min: 1000, max: 2000, count: 0, cost: 0 },
    { name: '2-4s', min: 2000, max: 4000, count: 0, cost: 0 },
    { name: '>4s', min: 4000, max: Number.POSITIVE_INFINITY, count: 0, cost: 0 },
  ]
  const firstTokenBuckets = [
    { name: '<0.5s', min: 0, max: 500, count: 0, cost: 0 },
    { name: '0.5-1s', min: 500, max: 1000, count: 0, cost: 0 },
    { name: '1-2s', min: 1000, max: 2000, count: 0, cost: 0 },
    { name: '>2s', min: 2000, max: Number.POSITIVE_INFINITY, count: 0, cost: 0 },
  ]
  const timeBuckets = [
    { name: '00-06', min: 0, max: 6, count: 0, cost: 0, tokens: 0 },
    { name: '06-12', min: 6, max: 12, count: 0, cost: 0, tokens: 0 },
    { name: '12-18', min: 12, max: 18, count: 0, cost: 0, tokens: 0 },
    { name: '18-24', min: 18, max: 24, count: 0, cost: 0, tokens: 0 },
  ]

  logs.forEach((log) => {
    const bucket = log.latencyMs > 0
      ? latencyBuckets.find((item) => log.latencyMs >= item.min && log.latencyMs < item.max)
      : undefined
    if (bucket) {
      bucket.count += 1
      bucket.cost += log.cost
    }
    const firstTokenBucket = log.firstTokenMs > 0
      ? firstTokenBuckets.find((item) => log.firstTokenMs >= item.min && log.firstTokenMs < item.max)
      : undefined
    if (firstTokenBucket) {
      firstTokenBucket.count += 1
      firstTokenBucket.cost += log.cost
    }

    const timestamp = parseLogTime(log.time)
    const hour = timestamp === undefined ? -1 : new Date(timestamp).getHours()
    const timeBucket = timeBuckets.find((item) => hour >= item.min && hour < item.max)
    if (timeBucket) {
      timeBucket.count += 1
      timeBucket.cost += log.cost
      timeBucket.tokens += log.total
    }
  })

  const tokenMix = [
    { name: '输入（含缓存）', value: snapshot.summary.input, fill: '#2f7df6' },
    { name: '输出', value: snapshot.summary.output, fill: '#11b6a0' },
  ].filter((item) => item.value > 0)

  const radarModels = modelEfficiency.slice(0, 5).map((model) => ({
    model: model.model,
    成本效率: Math.max(0, 100 - Math.min(100, model.costPer1k * 100)),
    缓存覆盖: Math.min(100, model.cacheRate * 100),
    输出占比: Math.min(100, model.outputShare * 100),
    响应速度: model.avgLatency > 0 ? Math.max(0, 100 - Math.min(100, model.avgLatency / 50)) : 0,
    首字速度: model.avgFirstToken > 0 ? Math.max(0, 100 - Math.min(100, model.avgFirstToken / 30)) : 0,
  }))

  const anomalyRows = [...logs]
    .sort((a, b) => {
      const aScore = a.cost * 1000 + a.latencyMs / 1000 + a.total / 10000
      const bScore = b.cost * 1000 + b.latencyMs / 1000 + b.total / 10000
      return bScore - aScore
    })
    .slice(0, 5)

  const topModel = [...modelEfficiency].sort((a, b) => b.cost - a.cost)[0]
  const avgCostPerMillion = safeDivide(snapshot.summary.cost, snapshot.summary.realTokens / 1_000_000)
  const latencyLogs = logs.filter((log) => log.latencyMs > 0)
  const firstTokenLogs = logs.filter((log) => log.firstTokenMs > 0)
  const avgLatency = safeDivide(
    latencyLogs.reduce((sum, log) => sum + log.latencyMs, 0),
    latencyLogs.length,
  )
  const avgFirstToken = safeDivide(
    firstTokenLogs.reduce((sum, log) => sum + log.firstTokenMs, 0),
    firstTokenLogs.length,
  )
  const cacheSaving = modelEfficiency.reduce((sum, model) => {
    return sum + model.cacheHit * safeDivide(model.cost, model.tokens)
  }, 0)
  const topModelShare = safeDivide(topModel?.cost ?? 0, snapshot.summary.cost)
  const cacheRanking = [...modelEfficiency].sort((a, b) => b.cacheRate - a.cacheRate).slice(0, 8)
  const tokenConcentration = Array.from(tokenMap.values()).sort((a, b) => b.cost - a.cost).slice(0, 5)
  const modelTokenStack = [...snapshot.models]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 7)
    .map((model) => ({
      model: model.model,
      输入: model.input,
      输出: model.output,
    }))
  const modelRiskRows = [...modelEfficiency]
    .map((model) => {
      const costShare = safeDivide(model.cost, snapshot.summary.cost)
      const latencyScore = Math.min(1, safeDivide(model.avgLatency, 4000))
      const firstTokenScore = Math.min(1, safeDivide(model.avgFirstToken, 2000))
      const cacheMissScore = Math.max(0, 1 - model.cacheRate)
      const score = costShare * 0.4 + latencyScore * 0.22 + firstTokenScore * 0.18 + cacheMissScore * 0.2
      const reason =
        costShare > 0.35
          ? '成本集中'
          : model.avgFirstToken > avgFirstToken * 1.35 && model.avgFirstToken > 0
            ? '首字偏慢'
          : model.avgLatency > avgLatency * 1.25
            ? '响应偏慢'
            : model.cacheRate < snapshot.summary.cacheHitRate * 0.75
              ? '缓存偏低'
              : '持续观察'
      return { model: model.model, reason, score, costShare, avgLatency: model.avgLatency }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)

  const recommendations = [
    topModelShare > 0.45 && topModel
      ? { title: '降低单模型成本集中', metric: pct(topModelShare), detail: `${topModel.model} 占主要成本，可对比低价模型或拆分任务。` }
      : null,
    snapshot.summary.cacheHitRate < 0.35
      ? { title: '提升缓存命中率', metric: pct(snapshot.summary.cacheHitRate), detail: '长上下文、重复系统提示词和工具定义可以优先做缓存。' }
      : null,
    avgLatency > 2000
      ? { title: '排查高延迟调用', metric: `${(avgLatency / 1000).toFixed(2)}s`, detail: '优先检查高成本洞察列表中的模型、分组和时间段。' }
      : null,
    avgFirstToken > 1000
      ? { title: '优化首字响应', metric: `${(avgFirstToken / 1000).toFixed(2)}s`, detail: '首字偏慢通常与排队、模型冷启动、长上下文预处理或网络链路有关。' }
      : null,
    cacheSaving > 0
      ? { title: '缓存节省估算', metric: usd(cacheSaving), detail: '按当前模型平均成本估算，实际金额以中转站计费为准。' }
      : null,
  ].filter(Boolean) as Recommendation[]

  return {
    avgCostPerMillion,
    avgLatency,
    avgFirstToken,
    cacheSaving,
    topModelShare,
    modelEfficiency,
    latencyBuckets,
    firstTokenBuckets,
    timeBuckets,
    tokenMix,
    radarModels,
    cacheRanking,
    tokenConcentration,
    modelTokenStack,
    modelRiskRows,
    recommendations:
      recommendations.length > 0
        ? recommendations
        : [{ title: '当前结构稳定', metric: 'OK', detail: '成本、缓存和延迟暂无明显异常，继续观察真实业务峰值。' }],
    groupMatrix: Array.from(groupMap.values()).sort((a, b) => b.cost - a.cost),
    anomalyRows,
    topModel,
  }
}

export type { UsageLog }
