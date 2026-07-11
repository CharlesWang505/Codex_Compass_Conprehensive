import { CheckCircle2, CircleAlert } from 'lucide-react'
import type { HotSwitchProviderScan } from '../types'

export function ProviderScanResults({ providers }: { providers: HotSwitchProviderScan[] }) {
  if (!providers.length) return null

  return (
    <div className="codex-provider-scan-results">
      {providers.map((provider) => {
        const ok = !provider.error
        return (
          <article key={provider.relayId} className={ok ? 'ok' : 'error'}>
            <div>{ok ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}<strong>{provider.relayName}</strong></div>
            <span title={provider.endpoint}>{provider.endpoint || '未生成扫描地址'}</span>
            <small>{ok ? `${provider.models.length} 个模型` : provider.error}</small>
          </article>
        )
      })}
    </div>
  )
}
