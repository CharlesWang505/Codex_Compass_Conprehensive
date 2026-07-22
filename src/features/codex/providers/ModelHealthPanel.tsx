import { Activity, RefreshCw } from 'lucide-react'
import { CodexPanel, StatusPill } from '../shared/CodexPanel'
import type { ModelHealthResult, ModelHealthSnapshot } from '../types'
import {
  modelHealthControlState,
  modelHealthSummary,
  modelHealthTimestamp,
  modelHealthTone,
} from './modelHealth'

type Props = {
  snapshot: ModelHealthSnapshot | null
  runtimeAvailable: boolean
  busy: boolean
  onToggle: (enabled: boolean) => void
  onRunNow: () => void
}

function resultPresentation(result: ModelHealthResult) {
  if (result.status === 'available') return { label: '可用', tone: 'ok' as const }
  if (result.status === 'unavailable') return { label: '不可用', tone: 'error' as const }
  return { label: '跳过', tone: 'info' as const }
}

export function ModelHealthPanel({
  snapshot,
  runtimeAvailable,
  busy,
  onToggle,
  onRunNow,
}: Props) {
  const enabled = snapshot?.enabled ?? false
  const checking = snapshot?.checking ?? false
  const paused = snapshot?.paused ?? false
  const controls = modelHealthControlState(runtimeAvailable, busy, snapshot)

  return (
    <CodexPanel
      title="模型自动自检"
      icon={<Activity size={18} />}
      action={(
        <StatusPill tone={modelHealthTone(snapshot)}>
          {snapshot ? modelHealthSummary(snapshot) : '读取中'}
        </StatusPill>
      )}
      className="model-health-panel"
    >
      <div className="model-health-control">
        <div>
          <strong>每 10 分钟检测全部可用供应商</strong>
          <span>开启后立即检测一次；仅在首次失败、状态故障和恢复时提醒。</span>
        </div>
        <button
          className={enabled ? 'toggle on' : 'toggle'}
          type="button"
          role="switch"
          aria-label="模型自动自检"
          aria-checked={enabled}
          disabled={controls.toggleDisabled}
          onClick={() => onToggle(!enabled)}
        >
          <span />
        </button>
      </div>

      {snapshot?.error ? <div className="model-health-error">{snapshot.error}</div> : null}
      {paused ? <div className="model-health-paused">供应商配置总开关已关闭，自动检测暂时暂停。</div> : null}

      <div className="model-health-metrics" aria-live="polite">
        <div><span>可用</span><strong>{snapshot?.availableCount ?? 0}</strong></div>
        <div><span>不可用</span><strong>{snapshot?.unavailableCount ?? 0}</strong></div>
        <div><span>跳过</span><strong>{snapshot?.skippedCount ?? 0}</strong></div>
      </div>

      <div className="model-health-toolbar">
        <button
          type="button"
          disabled={controls.runDisabled}
          onClick={onRunNow}
        >
          <RefreshCw className={checking ? 'spin' : ''} size={14} />
          {checking ? '检测中' : '立即检测'}
        </button>
        <span>最近检测：{modelHealthTimestamp(snapshot?.lastCheckedAt ?? null)}</span>
      </div>

      {snapshot?.results.length ? (
        <div className="model-health-results">
          {snapshot.results.map((result, index) => {
            const presentation = resultPresentation(result)
            return (
              <div className="model-health-result" key={`${result.relayId}:${index}`}>
                <div>
                  <strong>{result.relayName || '未命名供应商'}</strong>
                  <span>{result.model || '未配置测试模型'}</span>
                </div>
                <StatusPill tone={presentation.tone}>{presentation.label}</StatusPill>
                <small>{result.detail}</small>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="model-health-empty">
          {enabled ? '等待首次检测结果' : '开启自动自检，或点击“立即检测”进行手动检查'}
        </div>
      )}
    </CodexPanel>
  )
}
