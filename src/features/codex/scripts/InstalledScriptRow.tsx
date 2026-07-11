import { CircleAlert, LoaderCircle, Power, PowerOff, Trash2 } from 'lucide-react'
import type { InstalledScript } from './types'

type Props = {
  script: InstalledScript
  busy: boolean
  disabled: boolean
  onToggle: (script: InstalledScript) => void
  onDelete: (script: InstalledScript) => void
}

function sourceLabel(script: InstalledScript) {
  if (script.marketId) return '市场安装'
  if (script.source === 'builtin') return '内置'
  if (script.source === 'user') return '用户'
  return script.source || '未知来源'
}

export function InstalledScriptRow({ script, busy, disabled, onToggle, onDelete }: Props) {
  const canDelete = script.source === 'user'
  return (
    <article className="installed-script-row">
      <div className="installed-script-main">
        <div><strong>{script.name}</strong><span className={script.enabled ? 'script-badge installed' : 'script-badge'}>{script.enabled ? '已启用' : '已停用'}</span></div>
        <span>{sourceLabel(script)}{script.version ? ` · v${script.version}` : ''}</span>
        {script.homepage ? <small>{script.homepage}</small> : null}
      </div>
      <div className="installed-script-status">
        <strong>{script.status || '状态未知'}</strong>
        {script.error ? <details><summary><CircleAlert size={13} />运行错误</summary><code>{script.error}</code></details> : <span>未报告运行错误</span>}
      </div>
      <div className="installed-script-actions">
        <button type="button" disabled={disabled} onClick={() => onToggle(script)}>{busy ? <LoaderCircle className="spin" size={14} /> : script.enabled ? <PowerOff size={14} /> : <Power size={14} />}{script.enabled ? '停用' : '启用'}</button>
        {canDelete ? <button type="button" className="danger" disabled={disabled} onClick={() => onDelete(script)}><Trash2 size={14} />删除</button> : null}
      </div>
    </article>
  )
}
