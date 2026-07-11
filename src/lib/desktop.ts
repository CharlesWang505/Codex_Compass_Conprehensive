import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { RelaySite, RequestInput, RequestResult } from '../types'

export type CloseBehavior = 'ask' | 'tray' | 'exit'
export type CloseResolution = 'tray' | 'exit' | 'cancel'

export type AppPreferences = {
  closeBehavior: CloseBehavior
}

export function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function relayRequest(input: RequestInput): Promise<RequestResult> {
  return invoke<RequestResult>('relay_request', { input })
}

export async function loadStoredSites(): Promise<RelaySite[]> {
  return invoke<RelaySite[]>('load_sites')
}

export async function saveStoredSites(sites: RelaySite[]): Promise<void> {
  await invoke('save_sites', { sites })
}

export async function getSensitiveStoragePath(): Promise<string> {
  return invoke<string>('sensitive_storage_path')
}

export async function getAppVersion(): Promise<string> {
  return invoke<string>('app_version')
}

export async function loadAppPreferences(): Promise<AppPreferences> {
  if (!isTauriRuntime()) {
    return { closeBehavior: 'ask' }
  }
  return invoke<AppPreferences>('load_app_preferences')
}

export async function saveCloseBehavior(closeBehavior: CloseBehavior): Promise<AppPreferences> {
  if (!isTauriRuntime()) {
    return { closeBehavior }
  }
  return invoke<AppPreferences>('save_close_behavior', { closeBehavior })
}

export async function resolveCloseRequest(resolution: CloseResolution, remember: boolean): Promise<void> {
  if (!isTauriRuntime()) {
    return
  }
  await invoke('resolve_close_request', { resolution, remember })
}

export async function listenForCloseRequest(handler: () => void): Promise<UnlistenFn> {
  return listen('app-close-requested', handler)
}
