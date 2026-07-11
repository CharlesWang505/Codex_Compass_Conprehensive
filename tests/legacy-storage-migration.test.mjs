import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  LEGACY_SITES_KEY,
  LEGACY_SITES_MIGRATION_MARKER_KEY,
  markLegacySitesMigration,
  sitesMatchAfterMigration,
} from '../src/lib/legacyStorageMigration.ts'

test('site migration verification requires an exact persisted round trip', () => {
  const sites = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]

  assert.equal(sitesMatchAfterMigration(sites, structuredClone(sites)), true)
  assert.equal(sitesMatchAfterMigration(sites, sites.slice(0, 1)), false)
  assert.equal(sitesMatchAfterMigration(sites, [{ id: 'a', name: 'changed' }, sites[1]]), false)
})

test('migration marker is added without removing the legacy snapshot', () => {
  const values = new Map([[LEGACY_SITES_KEY, '[{"id":"legacy"}]']])
  const storage = {
    setItem(key, value) {
      values.set(key, value)
    },
  }

  markLegacySitesMigration(storage, 'copied-and-verified', 1)

  assert.equal(values.get(LEGACY_SITES_KEY), '[{"id":"legacy"}]')
  assert.deepEqual(JSON.parse(values.get(LEGACY_SITES_MIGRATION_MARKER_KEY)), {
    version: 2,
    verified: true,
    source: 'copied-and-verified',
    siteCount: 1,
  })
})

test('storage workflow never deletes the legacy sites key', async () => {
  const source = await readFile(new URL('../src/lib/storage.ts', import.meta.url), 'utf8')

  assert.equal(source.includes('removeItem(LEGACY_SITES_KEY)'), false)
})
