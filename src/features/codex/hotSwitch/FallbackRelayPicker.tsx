import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import type { RelayProfile } from '../types'

export function FallbackRelayPicker({
  profiles,
  primaryId,
  selectedIds,
  candidateIds,
  disabled,
  onChange,
}: {
  profiles: RelayProfile[]
  primaryId: string
  selectedIds: string[]
  candidateIds: string[]
  disabled: boolean
  onChange: (ids: string[]) => void
}) {
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]))
  const candidates = profiles
    .filter((profile) => profile.id !== primaryId && !selectedIds.includes(profile.id))
    .toSorted((left, right) => {
      const leftPreferred = candidateIds.includes(left.id) ? 0 : 1
      const rightPreferred = candidateIds.includes(right.id) ? 0 : 1
      return leftPreferred - rightPreferred || left.name.localeCompare(right.name, 'zh-CN')
    })

  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset
    if (target < 0 || target >= selectedIds.length) return
    const next = [...selectedIds]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  return (
    <div className="codex-fallback-picker">
      {selectedIds.length ? (
        <div className="codex-fallback-list">
          {selectedIds.map((relayId, index) => (
            <div key={relayId}>
              <span>{index + 1}. {profileMap.get(relayId)?.name ?? `失效供应商：${relayId}`}</span>
              <div>
                <button type="button" aria-label="上移" disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
                <button type="button" aria-label="下移" disabled={disabled || index === selectedIds.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
                <button type="button" aria-label="移除" disabled={disabled} onClick={() => onChange(selectedIds.filter((id) => id !== relayId))}><X size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      ) : <small>尚未设置备用供应商。</small>}
      <label>
        <Plus size={13} />
        <select value="" disabled={disabled || !candidates.length} onChange={(event) => event.target.value && onChange([...selectedIds, event.target.value])}>
          <option value="">{candidates.length ? '添加备用供应商' : '没有其他可用供应商'}</option>
          {candidates.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </label>
    </div>
  )
}
