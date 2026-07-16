import { useEffect, useState } from 'react'
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { ThemeMode } from '../types'

const THEME_KEY = 'relay-meter-theme-v1'
const THEME_CHANGED_EVENT = 'codex-compass-theme-changed'

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'pink'
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function loadTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (isThemeMode(stored)) {
      return stored
    }
  } catch {
    // ignore
  }
  return 'dark'
}

/** 主题状态：持久化到 localStorage，并同步 data-theme 到 <html>。 */
export function useTheme(): [ThemeMode, () => void] {
  const [theme, setTheme] = useState<ThemeMode>(loadTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // ignore
    }
  }, [theme])

  useEffect(() => {
    const syncFromStorage = (event: StorageEvent) => {
      if (event.key === THEME_KEY && isThemeMode(event.newValue)) {
        setTheme(event.newValue)
      }
    }
    window.addEventListener('storage', syncFromStorage)

    let disposed = false
    let unlisten: UnlistenFn | undefined
    if (isTauriRuntime()) {
      void listen<ThemeMode>(THEME_CHANGED_EVENT, ({ payload }) => {
        if (isThemeMode(payload)) {
          setTheme(payload)
        }
      }).then((cleanup) => {
        if (disposed) cleanup()
        else unlisten = cleanup
      }).catch(() => undefined)
    }

    return () => {
      disposed = true
      unlisten?.()
      window.removeEventListener('storage', syncFromStorage)
    }
  }, [])

  const toggle = () => setTheme((prev) => {
    const next = prev === 'dark' ? 'light' : prev === 'light' ? 'pink' : 'dark'
    if (isTauriRuntime()) {
      void emit(THEME_CHANGED_EVENT, next).catch(() => undefined)
    }
    return next
  })
  return [theme, toggle]
}

/** 图表配色随主题切换，避免深色 tooltip 出现在浅色背景上。 */
export type ChartTheme = {
  grid: string
  axis: string
  tooltipBg: string
  tooltipBorder: string
  tooltipText: string
}

export function chartTheme(theme: ThemeMode): ChartTheme {
  if (theme === 'pink') {
    return {
      grid: '#eadbe5',
      axis: '#796775',
      tooltipBg: '#fff8fc',
      tooltipBorder: '#e6c8d9',
      tooltipText: '#35242f',
    }
  }
  if (theme === 'light') {
    return {
      grid: '#e2e7ed',
      axis: '#6b7684',
      tooltipBg: '#ffffff',
      tooltipBorder: '#d5dce4',
      tooltipText: '#1a2330',
    }
  }
  return {
    grid: '#26313d',
    axis: '#8b96a5',
    tooltipBg: '#121922',
    tooltipBorder: '#273342',
    tooltipText: '#e6edf5',
  }
}
