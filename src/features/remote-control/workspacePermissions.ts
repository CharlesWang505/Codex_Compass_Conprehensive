import type { AuthorizedWorkspace } from './types'

export type WorkspacePermissionKey =
  | 'allowWrite'
  | 'allowCommands'
  | 'allowUploads'

export type WorkspacePermissionSelection = {
  checked: boolean
  indeterminate: boolean
}

export function summarizeWorkspacePermissions(
  workspaces: AuthorizedWorkspace[],
  permissions: WorkspacePermissionKey[],
): WorkspacePermissionSelection {
  const total = workspaces.length * permissions.length
  if (total === 0) return { checked: false, indeterminate: false }

  const selected = workspaces.reduce(
    (count, workspace) => count + permissions.filter((permission) => workspace[permission]).length,
    0,
  )
  return {
    checked: selected === total,
    indeterminate: selected > 0 && selected < total,
  }
}
