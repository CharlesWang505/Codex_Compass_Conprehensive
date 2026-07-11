import { Save, Sparkles, Zap } from 'lucide-react'
import type { BackendSettings, HotSwitchMappingResult, HotSwitchModelMapping, HotSwitchResult } from '../types'
import { CodexField, CodexPanel, LoadingButton, StatusPill } from '../shared/CodexPanel'
import { ModelMappingEditor } from './ModelMappingEditor'
import { validateMappings } from './mappingValidation'
import './HotSwitchPage.css'

export function HotSwitchPage({
  settings,
  status,
  mappings,
  scan,
  busy,
  onPatchSettings,
  onMappingsChange,
  onToggle,
  onScan,
  onSaveMappings,
  onSaveSettings,
  onSetFloatingEnabled,
  onResetFloatingPosition,
}: {
  settings: BackendSettings
  status: HotSwitchResult | null
  mappings: HotSwitchModelMapping[]
  scan: HotSwitchMappingResult | null
  busy: string
  onPatchSettings: (patch: Partial<BackendSettings>) => void
  onMappingsChange: (mappings: HotSwitchModelMapping[]) => void
  onToggle: (enabled: boolean) => void
  onScan: () => void
  onSaveMappings: () => void
  onSaveSettings: () => void
  onSetFloatingEnabled: (enabled: boolean) => void
  onResetFloatingPosition: () => void
}) {
  const validation = validateMappings(mappings, settings.relayProfiles)
  const enabled = Boolean(status?.enabled ?? settings.hotSwitchEnabled)
  const operationBusy = Boolean(busy)
  const applying = busy === 'save-settings' || busy === 'save-mappings-before-hot' || busy === 'set-hot'
  const state = status?.error ? 'error' : status?.running ? 'running' : enabled ? 'waiting' : 'off'
  const stateLabel = state === 'error' ? '网关错误' : state === 'running' ? '网关运行中' : state === 'waiting' ? '配置已开启，进程未运行' : '配置已关闭'
  const stateTone = state === 'running' ? 'ok' : state === 'error' ? 'error' : state === 'waiting' ? 'warning' : 'info'

  return (
    <div className="codex-hot-switch-page">
      <CodexPanel title="8787 本地网关" icon={<Zap size={18} />} action={<StatusPill tone={stateTone}>{stateLabel}</StatusPill>}>
        {status?.error ? <div className="codex-hot-switch-error">{status.error}</div> : null}
        <div className="codex-form-grid">
          <CodexField label="固定供应商">
            <select value={settings.hotSwitchRelayId} disabled={operationBusy} onChange={(event) => onPatchSettings({ hotSwitchRelayId: event.target.value })}>
              {settings.relayProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.relayMode === 'aggregate' ? '（聚合）' : ''}</option>)}
            </select>
          </CodexField>
          <CodexField label="固定模型"><input value={settings.hotSwitchModel} disabled={operationBusy} onChange={(event) => onPatchSettings({ hotSwitchModel: event.target.value })} /></CodexField>
          <CodexField label="默认推理强度">
            <select value={settings.defaultReasoning ?? 'auto'} disabled={operationBusy} onChange={(event) => onPatchSettings({ defaultReasoning: event.target.value })}>
              <option value="auto">自动</option><option value="off">关闭</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option>
            </select>
          </CodexField>
          <CodexField label="模型自动路由">
            <select value={settings.hotSwitchModelRoutingEnabled ? 'on' : 'off'} disabled={operationBusy} onChange={(event) => onPatchSettings({ hotSwitchModelRoutingEnabled: event.target.value === 'on' })}>
              <option value="off">关闭</option><option value="on">开启</option>
            </select>
          </CodexField>
        </div>
        {!validation.valid && !enabled ? <p className="codex-result-text">映射规则仍有错误；修正后才能应用并开启自动路由。</p> : null}
        <div className="codex-toolbar">
          <LoadingButton busy={applying} className={enabled ? 'danger' : 'primary'} disabled={operationBusy || (!enabled && settings.hotSwitchModelRoutingEnabled && !validation.valid)} onClick={() => onToggle(!enabled)}>
            <Zap size={14} />{enabled ? '关闭热切换' : '应用并开启'}
          </LoadingButton>
          <span className="codex-path">{status?.baseUrl ?? 'http://127.0.0.1:8787/v1'}</span>
        </div>
      </CodexPanel>

      <CodexPanel title="悬浮切换" icon={<Sparkles size={18} />}>
        <div className="codex-switch-row"><div><strong>悬浮球与快速切换面板</strong><span>开启后立即显示悬浮球；单击悬浮球打开快速切换面板。</span></div><button className={settings.floatingSwitchEnabled ? 'toggle on' : 'toggle'} type="button" role="switch" aria-label="悬浮切换面板" aria-checked={settings.floatingSwitchEnabled} disabled={operationBusy} onClick={() => onSetFloatingEnabled(!settings.floatingSwitchEnabled)}><span /></button></div>
        <div className="codex-toolbar">
          <LoadingButton busy={busy === 'save-settings'} disabled={operationBusy} onClick={onSaveSettings}><Save size={14} />保存悬浮设置</LoadingButton>
          <button type="button" disabled={operationBusy} onClick={onResetFloatingPosition}>恢复默认位置</button>
        </div>
      </CodexPanel>

      <ModelMappingEditor profiles={settings.relayProfiles} mappings={mappings} scan={scan} validation={validation} busy={busy} onChange={onMappingsChange} onScan={onScan} onSave={onSaveMappings} />
    </div>
  )
}
