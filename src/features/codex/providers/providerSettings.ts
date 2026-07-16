import type { BackendSettings, HotSwitchModelMapping } from '../types'

function uniqueRelayIds(relayIds: string[], validRelayIds: Set<string>) {
  return Array.from(new Set(relayIds.filter((relayId) => validRelayIds.has(relayId))))
}

function removeRelayFromMapping(
  mapping: HotSwitchModelMapping,
  removedRelayId: string,
  validRelayIds: Set<string>,
): HotSwitchModelMapping | null {
  const candidates = uniqueRelayIds(
    (mapping.candidateRelayIds ?? []).filter((relayId) => relayId !== removedRelayId),
    validRelayIds,
  )
  const fallbacks = uniqueRelayIds(
    (mapping.fallbackRelayIds ?? []).filter((relayId) => relayId !== removedRelayId),
    validRelayIds,
  )
  const relayId = mapping.relayId !== removedRelayId && validRelayIds.has(mapping.relayId)
    ? mapping.relayId
    : candidates[0] ?? fallbacks[0] ?? ''

  if (!relayId) return null

  return {
    ...mapping,
    relayId,
    candidateRelayIds: [relayId, ...candidates.filter((candidate) => candidate !== relayId)],
    fallbackRelayIds: fallbacks.filter((fallback) => fallback !== relayId),
  }
}

export function removeRelayProfileFromSettings(
  settings: BackendSettings,
  removedRelayId: string,
): BackendSettings | null {
  if (settings.relayProfiles.length <= 1) return null
  if (!settings.relayProfiles.some((profile) => profile.id === removedRelayId)) return null

  const relayProfiles = settings.relayProfiles.filter((profile) => profile.id !== removedRelayId)
  const firstProfileId = relayProfiles[0]?.id ?? ''
  const firstApiProfileId = relayProfiles.find((profile) => profile.relayMode !== 'aggregate')?.id ?? firstProfileId
  const validApiRelayIds = new Set(
    relayProfiles
      .filter((profile) => profile.relayMode !== 'aggregate')
      .map((profile) => profile.id),
  )
  const hotSwitchModelMappings = settings.hotSwitchModelMappings.flatMap((mapping) => {
    const next = removeRelayFromMapping(mapping, removedRelayId, validApiRelayIds)
    return next ? [next] : []
  })
  const hotSwitchRelayId = settings.hotSwitchRelayId === removedRelayId
    ? hotSwitchModelMappings[0]?.relayId ?? firstApiProfileId
    : settings.hotSwitchRelayId

  return {
    ...settings,
    relayProfiles,
    aggregateRelayProfiles: settings.aggregateRelayProfiles
      .filter((profile) => profile.id !== removedRelayId)
      .map((profile) => ({
        ...profile,
        members: profile.members.filter((member) => member.relayId !== removedRelayId),
      })),
    activeRelayId: settings.activeRelayId === removedRelayId ? firstProfileId : settings.activeRelayId,
    hotSwitchRelayId,
    activeAggregateRelayId: settings.activeAggregateRelayId === removedRelayId
      ? ''
      : settings.activeAggregateRelayId,
    hotSwitchModelMappings,
    hotSwitchModelRoutingEnabled: hotSwitchModelMappings.length > 0
      ? settings.hotSwitchModelRoutingEnabled
      : false,
  }
}
