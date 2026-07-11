import { isTauriRuntime, loadStoredSites, saveStoredSites } from './desktop'
import { defaultSites } from './sampleData'
import type { ApiKeyProbe, RelaySite } from '../types'
import {
  LEGACY_SITES_KEY,
  markLegacySitesMigration,
  sitesMatchAfterMigration,
} from './legacyStorageMigration'

const SELECTED_SITE_KEY = 'relay-meter-selected-site-v1'

function createId() {
  return `site_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function coerceApiKeyProbe(value: Partial<ApiKeyProbe>, index: number): ApiKeyProbe {
  const tokenName = value.tokenName?.trim() || value.name?.trim() || ''
  return {
    id: value.id || `probe_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 6)}`,
    name: tokenName,
    key: value.key ?? '',
    tokenName,
    enabled: value.enabled ?? true,
  }
}

function coerceSite(value: Partial<RelaySite>, fallback: RelaySite): RelaySite {
  const refreshMinutes = Number(value.refreshMinutes ?? fallback.refreshMinutes)
  const apiKeyProbes = Array.isArray(value.apiKeyProbes)
    ? value.apiKeyProbes.map(coerceApiKeyProbe)
    : fallback.apiKeyProbes ?? []

  return {
    id: value.id || fallback.id || createId(),
    name: value.name?.trim() || fallback.name,
    baseUrl: value.baseUrl?.trim() || fallback.baseUrl,
    apiKey: value.apiKey ?? fallback.apiKey,
    apiKeyTokenName: value.apiKeyTokenName?.trim() ?? fallback.apiKeyTokenName ?? '',
    apiKeyProbes,
    userId: value.userId?.trim() ?? fallback.userId ?? '',
    cookie: value.cookie?.trim() ?? fallback.cookie ?? '',
    loginUsername: value.loginUsername?.trim() ?? fallback.loginUsername ?? '',
    loginPassword: value.loginPassword ?? fallback.loginPassword ?? '',
    autoLogin: value.autoLogin ?? fallback.autoLogin ?? false,
    kind: value.kind ?? fallback.kind,
    refreshMinutes: Number.isFinite(refreshMinutes) && refreshMinutes > 0 ? refreshMinutes : 5,
    availabilityProbe: value.availabilityProbe ?? fallback.availabilityProbe,
  }
}

function normalizeSites(values: Partial<RelaySite>[]) {
  return values.map((site, index) => coerceSite(site, defaultSites[index] ?? defaultSites[0]))
}

/** 仅用于从同一 WebView 的旧网页版本迁移一次，后续不再写入 localStorage。 */
export function loadSites(): RelaySite[] {
  try {
    const raw = localStorage.getItem(LEGACY_SITES_KEY)
    if (!raw) {
      return defaultSites
    }

    const parsed = JSON.parse(raw) as Partial<RelaySite>[]
    return Array.isArray(parsed) && parsed.length > 0 ? normalizeSites(parsed) : defaultSites
  } catch {
    return defaultSites
  }
}

export async function initializeSiteStorage(legacySites: RelaySite[]) {
  if (!isTauriRuntime()) {
    return legacySites
  }

  const storedSites = await loadStoredSites()
  const sites = storedSites.length > 0 ? normalizeSites(storedSites) : legacySites
  if (storedSites.length === 0) {
    await saveStoredSites(sites)
    const verifiedSites = normalizeSites(await loadStoredSites())
    if (!sitesMatchAfterMigration(sites, verifiedSites)) {
      throw new Error('站点配置迁移写入校验失败')
    }
    markLegacySitesMigration(localStorage, 'copied-and-verified', verifiedSites.length)
    return verifiedSites
  }
  markLegacySitesMigration(localStorage, 'backend-present', sites.length)
  return sites
}

export async function saveSites(sites: RelaySite[]) {
  if (isTauriRuntime()) {
    await saveStoredSites(sites)
  }
}

export function loadSelectedSiteId(sites: RelaySite[]) {
  const stored = localStorage.getItem(SELECTED_SITE_KEY)
  return sites.some((site) => site.id === stored) ? stored : sites[0]?.id
}

export function saveSelectedSiteId(siteId: string) {
  localStorage.setItem(SELECTED_SITE_KEY, siteId)
}

export function createBlankSite(): RelaySite {
  return {
    id: createId(),
    name: '新中转站',
    baseUrl: 'https://',
    apiKey: '',
    apiKeyTokenName: '',
    apiKeyProbes: [],
    userId: '',
    cookie: '',
    loginUsername: '',
    loginPassword: '',
    autoLogin: false,
    kind: 'auto',
    refreshMinutes: 5,
    availabilityProbe: true,
  }
}
