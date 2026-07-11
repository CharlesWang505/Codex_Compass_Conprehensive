export function TaskProgress({
  label,
  completed,
  total,
  detail,
}: {
  label: string
  completed: number
  total: number
  detail?: string
}) {
  const safeTotal = Math.max(total, 1)
  const percent = Math.min(100, Math.round((completed / safeTotal) * 100))

  return (
    <div className="codex-task-progress" role="status" aria-live="polite">
      <div><strong>{label}</strong><span>{completed}/{total}</span></div>
      <div className="codex-task-progress-track" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
      {detail ? <small>{detail}</small> : null}
    </div>
  )
}
