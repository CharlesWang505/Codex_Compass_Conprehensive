import { useEffect, useId } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { LoadingButton } from './CodexPanel'

type Props = {
  open: boolean
  title: string
  description: string
  items?: string[]
  overflowCount?: number
  confirmLabel?: string
  busy?: boolean
  destructive?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  items = [],
  overflowCount = 0,
  confirmLabel = '确认',
  busy = false,
  destructive = false,
  onCancel,
  onConfirm,
}: Props) {
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onCancel, open])

  if (!open) return null

  return (
    <div className="codex-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel()
    }}>
      <section className="codex-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <header>
          <div className="codex-dialog-heading">
            <AlertTriangle size={19} />
            <strong id={titleId}>{title}</strong>
          </div>
          <button type="button" className="codex-dialog-close" aria-label="关闭" disabled={busy} onClick={onCancel}>
            <X size={17} />
          </button>
        </header>
        <div className="codex-dialog-body">
          <p id={descriptionId}>{description}</p>
          {items.length > 0 ? (
            <ul>
              {items.map((item) => <li key={item}>{item}</li>)}
              {overflowCount > 0 ? <li>以及另外 {overflowCount} 项</li> : null}
            </ul>
          ) : null}
        </div>
        <footer>
          <button type="button" disabled={busy} onClick={onCancel}>取消</button>
          <LoadingButton type="button" busy={busy} className={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </LoadingButton>
        </footer>
      </section>
    </div>
  )
}
