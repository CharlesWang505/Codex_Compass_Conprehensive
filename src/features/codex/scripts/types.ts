import type { UserScriptInventory } from '../types'

export type InstalledScript = NonNullable<UserScriptInventory['scripts']>[number]

export type ScriptPageNotice = {
  tone: 'ok' | 'warning' | 'error'
  text: string
}

export type DeleteScriptState = {
  script: InstalledScript
}
