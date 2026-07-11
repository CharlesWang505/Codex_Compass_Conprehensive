import type { NoticeTone } from './CodexPanel'

export function CodexNotice({
  tone,
  text,
  onDismiss,
}: {
  tone: NoticeTone
  text: string
  onDismiss: () => void
}) {
  return (
    <div className={`codex-notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span>{text}</span>
      <button type="button" aria-label="关闭通知" onClick={onDismiss}>×</button>
    </div>
  )
}
