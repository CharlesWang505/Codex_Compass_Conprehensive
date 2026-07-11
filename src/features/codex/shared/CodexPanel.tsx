import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Boxes, CheckCircle2, CircleAlert, LoaderCircle } from 'lucide-react'

export type NoticeTone = 'ok' | 'warning' | 'error' | 'info'

export function CodexPanel({
  title,
  icon,
  action,
  children,
  className = '',
}: {
  title: string
  icon: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`codex-panel ${className}`}>
      <header>
        <div className="codex-panel-title">{icon}<strong>{title}</strong></div>
        {action}
      </header>
      <div className="codex-panel-body">{children}</div>
    </section>
  )
}

export function StatusPill({
  ok,
  tone,
  children,
}: {
  ok?: boolean
  tone?: NoticeTone
  children: ReactNode
}) {
  const resolvedTone = tone ?? (ok ? 'ok' : 'error')
  const className = resolvedTone === 'error' ? 'bad' : resolvedTone
  const Icon = resolvedTone === 'ok' ? CheckCircle2 : CircleAlert
  return (
    <span className={`codex-status ${className}`}>
      <Icon size={13} />
      {children}
    </span>
  )
}

export function CodexField({
  label,
  hint,
  children,
  wide = false,
}: {
  label: string
  hint?: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <label className={wide ? 'codex-field wide' : 'codex-field'}>
      <span>{label}</span>
      {children}
      {hint ? <em>{hint}</em> : null}
    </label>
  )
}

export function CodexEmptyState({ text }: { text: string }) {
  return <div className="codex-empty"><Boxes size={22} /><span>{text}</span></div>
}

export function LoadingButton({
  busy,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button {...props} disabled={busy || props.disabled}>
      {busy ? <LoaderCircle className="spin" size={15} /> : null}
      {children}
    </button>
  )
}
