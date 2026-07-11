export const LEGACY_SITES_KEY = 'relay-meter-sites-v1'
export const LEGACY_SITES_MIGRATION_MARKER_KEY = 'relay-meter-sites-migration-v2'

export type LegacySitesMigrationSource = 'copied-and-verified' | 'backend-present'

export function sitesMatchAfterMigration<T>(expected: T[], actual: T[]) {
  return expected.length === actual.length
    && expected.every((site, index) => JSON.stringify(site) === JSON.stringify(actual[index]))
}

export function markLegacySitesMigration(
  storage: Pick<Storage, 'setItem'>,
  source: LegacySitesMigrationSource,
  siteCount: number,
) {
  storage.setItem(LEGACY_SITES_MIGRATION_MARKER_KEY, JSON.stringify({
    version: 2,
    verified: true,
    source,
    siteCount,
  }))
}
