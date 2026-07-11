import { invoke } from '@tauri-apps/api/core'

function camelizeKey(key: string) {
  return key.replace(/_([a-z0-9])/g, (_, character: string) => character.toUpperCase())
}

function normalizeCodexValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCodexValue)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [camelizeKey(key), normalizeCodexValue(child)]),
  )
}

export async function callCodex<T>(command: string, args?: Record<string, unknown>) {
  const result = await invoke<unknown>(command, args)
  return normalizeCodexValue(result) as T
}

export function commandSucceeded(result: { status: string }) {
  return result.status === 'ok' || result.status === 'warning'
}
