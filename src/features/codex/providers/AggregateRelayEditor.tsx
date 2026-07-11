import { CircleAlert } from 'lucide-react'
import type { AggregateRelayProfile, AggregateRelayStrategy, RelayProfile } from '../types'
import { CodexField } from '../shared/CodexPanel'

const STRATEGY_LABELS: Record<AggregateRelayStrategy, string> = {
  failover: '按顺序故障切换',
  conversationRoundRobin: '按会话轮询',
  requestRoundRobin: '按请求轮询',
  weightedRoundRobin: '加权轮询',
}

export function AggregateRelayEditor({
  profile,
  relayProfiles,
  disabled,
  onChange,
}: {
  profile: AggregateRelayProfile
  relayProfiles: RelayProfile[]
  disabled: boolean
  onChange: (profile: AggregateRelayProfile) => void
}) {
  const availableMembers = relayProfiles.filter((relay) => relay.relayMode !== 'aggregate' && relay.id !== profile.id)
  const availableMemberIds = new Set(availableMembers.map((relay) => relay.id))
  const invalidMembers = profile.members.filter((member) => !availableMemberIds.has(member.relayId))
  const validMemberCount = profile.members.length - invalidMembers.length
  const memberMap = new Map(profile.members.map((member) => [member.relayId, member]))

  const toggleMember = (relayId: string, selected: boolean) => {
    const members = selected
      ? [...profile.members, { relayId, weight: 1 }]
      : profile.members.filter((member) => member.relayId !== relayId)
    onChange({ ...profile, members })
  }

  const updateWeight = (relayId: string, weight: number) => {
    const normalizedWeight = Number.isFinite(weight) ? Math.min(1000, Math.max(1, Math.round(weight))) : 1
    onChange({
      ...profile,
      members: profile.members.map((member) => member.relayId === relayId ? { ...member, weight: normalizedWeight } : member),
    })
  }

  return (
    <div className="codex-aggregate-editor">
      <div className="codex-aggregate-intro">
        <CircleAlert size={16} />
        <span>聚合供应商本身不保存 API Key，而是按下面的策略调度已有普通供应商。</span>
      </div>
      <CodexField label="聚合策略" wide>
        <select value={profile.strategy} disabled={disabled} onChange={(event) => onChange({ ...profile, strategy: event.target.value as AggregateRelayStrategy })}>
          {(Object.entries(STRATEGY_LABELS) as Array<[AggregateRelayStrategy, string]>).map(([strategy, label]) => <option key={strategy} value={strategy}>{label}</option>)}
        </select>
      </CodexField>
      <fieldset className="codex-aggregate-members" disabled={disabled}>
        <legend>成员供应商</legend>
        {availableMembers.length ? availableMembers.map((relay) => {
          const member = memberMap.get(relay.id)
          return (
            <article key={relay.id}>
              <label>
                <input type="checkbox" checked={Boolean(member)} onChange={(event) => toggleMember(relay.id, event.target.checked)} />
                <span><strong>{relay.name}</strong><small>{relay.protocol} · {relay.baseUrl || relay.upstreamBaseUrl}</small></span>
              </label>
              {profile.strategy === 'weightedRoundRobin' && member ? (
                <CodexField label="权重"><input type="number" min={1} max={1000} value={member.weight} onChange={(event) => updateWeight(relay.id, event.currentTarget.valueAsNumber)} /></CodexField>
              ) : null}
            </article>
          )
        }) : <p>请先创建至少一个普通 API 供应商。</p>}
      </fieldset>
      {invalidMembers.length ? (
        <div className="codex-aggregate-warning" role="alert">
          <span>检测到 {invalidMembers.length} 个已删除或不可用的成员：{invalidMembers.map((member) => member.relayId).join('、')}</span>
          <button type="button" disabled={disabled} onClick={() => onChange({ ...profile, members: profile.members.filter((member) => availableMemberIds.has(member.relayId)) })}>移除失效成员</button>
        </div>
      ) : null}
      {!validMemberCount ? <div className="codex-aggregate-warning">至少选择一个有效成员供应商后才能使用此聚合配置。</div> : null}
    </div>
  )
}
