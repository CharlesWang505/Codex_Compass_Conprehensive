import type { LocalSession } from '../types'

export type SessionStatusFilter = 'all' | 'active' | 'archived'

export type DeleteSessionResult = {
  status: string
  message: string
  sessionId: string
  undoToken: string | null
  backupPath: string | null
}

export type DeleteSummary = {
  requested: number
  deleted: LocalSession[]
  failed: Array<{ session: LocalSession; message: string }>
  backupPaths: string[]
}

export type ProviderSyncTarget = {
  id: string
  sources: string[]
  isCurrentProvider: boolean
  isManual: boolean
  isSaved: boolean
}

export type ProviderSyncTargetsResult = {
  status: string
  message: string
  currentProvider: string
  targets: ProviderSyncTarget[]
}

export type ProviderSyncResult = {
  status: string
  message: string
  syncStatus: string
  targetProvider: string
  changedSessionFiles: number
  skippedLockedRolloutFiles: string[]
  sqliteRowsUpdated: number
  sqliteProviderRowsUpdated: number
  sqliteUserEventRowsUpdated: number
  sqliteCwdRowsUpdated: number
  updatedWorkspaceRoots: number
  encryptedContentWarning: string | null
  backupDir: string | null
  syncMessage: string
}

export type SessionIndexCleanupCandidate = {
  id: string
  threadName: string
  updatedAt: string
}

export type SessionIndexCleanupPreviewResult = {
  status: string
  message: string
  snapshotSha256: string
  candidates: SessionIndexCleanupCandidate[]
}

export type SessionIndexCleanupApplyResult = {
  status: string
  message: string
  prunedEntries: number
  backupDir: string | null
}

export type ConfirmDeleteState = {
  sessions: LocalSession[]
}
