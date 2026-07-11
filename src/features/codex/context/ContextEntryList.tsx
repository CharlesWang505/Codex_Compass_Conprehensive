import { Pencil, Power, Trash2 } from 'lucide-react'
import type { CodexContextEntry } from '../types'
import { CodexEmptyState, LoadingButton, StatusPill } from '../shared/CodexPanel'

export function ContextEntryList({
  entries,
  busy,
  disabled,
  onEdit,
  onToggle,
  onDelete,
}: {
  entries: CodexContextEntry[]
  busy: string
  disabled: boolean
  onEdit: (entry: CodexContextEntry) => void
  onToggle: (entry: CodexContextEntry) => void
  onDelete: (entry: CodexContextEntry) => void
}) {
  if (!entries.length) return <CodexEmptyState text="当前分类还没有配置。" />

  return (
    <div className="codex-context-entry-list">
      {entries.map((entry) => (
        <article key={`${entry.kind}-${entry.id}`}>
          <div className="codex-context-entry-copy">
            <div className="codex-context-entry-title">
              <strong>{entry.title || entry.id}</strong>
              <StatusPill ok={entry.enabled}>{entry.enabled ? '已启用' : '已停用'}</StatusPill>
            </div>
            <span>{entry.summary || '暂无摘要'}</span>
            <small>{entry.id}</small>
          </div>
          <div className="codex-inline-actions">
            <LoadingButton
              type="button"
              busy={busy === `toggle-context-${entry.kind}-${entry.id}`}
              disabled={disabled}
              title={entry.enabled ? '停用' : '启用'}
              onClick={() => onToggle(entry)}
            >
              <Power size={14} />{entry.enabled ? '停用' : '启用'}
            </LoadingButton>
            <button type="button" disabled={disabled} onClick={() => onEdit(entry)}><Pencil size={14} />编辑</button>
            <button type="button" className="danger" disabled={disabled} onClick={() => onDelete(entry)}><Trash2 size={14} />删除</button>
          </div>
        </article>
      ))}
    </div>
  )
}
