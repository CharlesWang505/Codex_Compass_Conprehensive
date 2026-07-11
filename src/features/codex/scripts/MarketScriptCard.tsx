import { Download, ExternalLink, LoaderCircle } from 'lucide-react'
import type { ScriptMarketItem } from '../types'

type Props = {
  script: ScriptMarketItem
  busy: boolean
  disabled: boolean
  onInstall: (id: string) => void
  onOpenHomepage: (url: string) => void
}

export function MarketScriptCard({ script, busy, disabled, onInstall, onOpenHomepage }: Props) {
  const status = script.updateAvailable
    ? '可更新'
    : script.installed
      ? `已安装 ${script.installedVersion || script.version}`
      : '未安装'

  return (
    <article className="market-script-card">
      <header>
        <div><strong>{script.name}</strong><span>{script.author || '未知作者'}</span></div>
        <span className={script.updateAvailable ? 'script-badge update' : script.installed ? 'script-badge installed' : 'script-badge'}>{status}</span>
      </header>
      <p>{script.description || '暂无描述。'}</p>
      <div className="script-tags"><span>v{script.version}</span>{script.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
      <footer>
        <button type="button" className="primary" disabled={disabled} onClick={() => onInstall(script.id)}>{busy ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}{script.updateAvailable ? '更新' : script.installed ? '重新安装' : '安装'}</button>
        {script.homepage ? <button type="button" onClick={() => onOpenHomepage(script.homepage)}><ExternalLink size={14} />主页</button> : null}
      </footer>
    </article>
  )
}
