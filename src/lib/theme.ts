import { useEffect, useState } from 'react'
import type { ThemeMode } from '../types'

const THEME_KEY = 'relay-meter-theme-v1'

export function loadTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'pink') {
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

  const toggle = () => setTheme((prev) => (prev === 'dark' ? 'light' : prev === 'light' ? 'pink' : 'dark'))
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
