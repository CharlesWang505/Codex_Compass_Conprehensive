import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Archive,
  CheckSquare2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Database,
  FolderClock,
  LoaderCircle,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { callCodex } from '../api'
import type { BackendSettings, LocalSession, LocalSessionsResult, SettingsResult } from '../types'
import type {
  ConfirmDeleteState,
  DeleteSessionResult,
  DeleteSummary,
  ProviderSyncResult,
  ProviderSyncTargetsResult,
  SessionIndexCleanupApplyResult,
  SessionIndexCleanupPreviewResult,
  SessionStatusFilter,
} from './types'
import { CodexNotice } from '../shared/CodexNotice'
import './SessionsPage.css'

type Props = {
  settings: BackendSettings
  onSettingsChange: (settings: BackendSettings) => void
}

type PageNotice = { tone: 'ok' | 'warning' | 'error'; text: string }

const SUCCESS_DELETE_STATUSES = new Set(['ok', 'accepted', 'local_deleted', 'server_deleted', 'partial'])
const EMPTY_SESSIONS: LocalSession[] = []

function formatSessionTime(value: number | null) {
  if (!value) return '时间未知'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function sessionMatches(session: LocalSession, query: string, filter: SessionStatusFilter) {
  if (filter === 'active' && session.archived) return false
  if (filter === 'archived' && !session.archived) return false
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return [session.title, session.id, session.cwd, session.modelProvider, session.rolloutPath]
    .some((value) => value.toLocaleLowerCase().includes(needle))
}

function sourceLabel(value: string) {
  if (value === 'config') return '配置'
  if (value === 'rollout') return '会话'
  if (value === 'sqlite') return '数据库'
  if (value === 'manual') return '手动'
  return value
}

export function SessionsPage({ settings, onSettingsChange }: Props) {
  const [sessions, setSessions] = useState<LocalSessionsResult | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>('all')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [selectionMode, setSelectionMode] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDeleteState | null>(null)
  const [deleteSummary, setDeleteSummary] = useState<DeleteSummary | null>(null)
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set())
  const [syncTargets, setSyncTargets] = useState<ProviderSyncTargetsResult | null>(null)
  const [syncTarget, setSyncTarget] = useState(settings.providerSyncLastSelectedProvider || '')
  const [syncResult, setSyncResult] = useState<ProviderSyncResult | null>(null)
  const [cleanupDialog, setCleanupDialog] = useState<SessionIndexCleanupPreviewResult | null>(null)
  const [cleanupSelectedIds, setCleanupSelectedIds] = useState<Set<string>>(() => new Set())
  const [cleanupResult, setCleanupResult] = useState<SessionIndexCleanupApplyResult | null>(null)
  const [autoRepair, setAutoRepair] = useState(settings.providerSyncEnabled)
  const operationBusy = busyKeys.size > 0
  const deleteBusy = busyKeys.has('delete')
  const cleanupBusy = busyKeys.has('index-cleanup')

  const beginBusy = useCallback((key: string) => {
    setBusyKeys((current) => {
      const next = new Set(current)
      next.add(key)
      return next
    })
  }, [])

  const endBusy = useCallback((key: string) => {
    setBusyKeys((current) => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }, [])

  const items = sessions?.sessions ?? EMPTY_SESSIONS
  const pageOffset = sessions?.offset ?? 0
  const pageSize = sessions?.limit ?? 50
  const currentPage = Math.floor(pageOffset / pageSize) + 1
  const hasPreviousPage = pageOffset > 0
  const hasNextPage = sessions?.hasMore === true
  const filteredItems = useMemo(
    () => items.filter((session) => sessionMatches(session, query, statusFilter)),
    [items, query, statusFilter],
  )
  const activeCount = useMemo(() => items.reduce((count, session) => count + Number(!session.archived), 0), [items])
  const archivedCount = items.length - activeCount
  const selectedSessions = useMemo(() => items.filter((session) => selectedIds.has(session.id)), [items, selectedIds])
  const filteredIds = useMemo(() => filteredItems.map((session) => session.id), [filteredItems])
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id))

  useEffect(() => setAutoRepair(settings.providerSyncEnabled), [settings.providerSyncEnabled])

  useEffect(() => {
    const available = new Set(items.map((session) => session.id))
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)))
      if (next.size === current.size && [...next].every((id) => current.has(id))) return current
      return next
    })
  }, [items])

  const refreshSessions = useCallback(async (silent = false, offset = 0) => {
    beginBusy('sessions')
    try {
      let result = await callCodex<LocalSessionsResult>('list_local_sessions', {
        request: { offset, limit: 50 },
      })
      if (!result.sessions.length && result.offset > 0) {
        result = await callCodex<LocalSessionsResult>('list_local_sessions', {
          request: { offset: Math.max(0, result.offset - result.limit), limit: result.limit },
        })
      }
      setSessions(result)
      if (!silent || result.status === 'failed') {
        setNotice({ tone: result.status === 'failed' ? 'error' : result.status === 'warning' ? 'warning' : 'ok', text: result.message })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      endBusy('sessions')
    }
  }, [beginBusy, endBusy])

  const loadSyncTargets = useCallback(async (silent = false) => {
    beginBusy('sync-targets')
    try {
      const result = await callCodex<ProviderSyncTargetsResult>('load_provider_sync_targets')
      setSyncTargets(result)
      setSyncTarget((current) => current || result.currentProvider || result.targets[0]?.id || '')
      if (!silent || result.status === 'failed') {
        setNotice({ tone: result.status === 'failed' ? 'error' : 'ok', text: result.message })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      endBusy('sync-targets')
    }
  }, [beginBusy, endBusy])

  useEffect(() => {
    void Promise.all([refreshSessions(true), loadSyncTargets(true)])
  }, [loadSyncTargets, refreshSessions])

  useEffect(() => {
    if (!confirmDelete) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleteBusy) setConfirmDelete(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmDelete, deleteBusy])

  useEffect(() => {
    if (!cleanupDialog) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !cleanupBusy) setCleanupDialog(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cleanupBusy, cleanupDialog])

  const toggleSession = useCallback((id: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const toggleSelectFiltered = useCallback(() => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allFilteredSelected) filteredIds.forEach((id) => next.delete(id))
      else filteredIds.forEach((id) => next.add(id))
      return next
    })
  }, [allFilteredSelected, filteredIds])

  const executeDelete = useCallback(async () => {
    const targets = confirmDelete?.sessions ?? []
    if (!targets.length) return
    beginBusy('delete')
    const summary: DeleteSummary = { requested: targets.length, deleted: [], failed: [], backupPaths: [] }
    try {
      for (const session of targets) {
        try {
          const result = await callCodex<DeleteSessionResult>('delete_local_session', {
            request: { sessionId: session.id, title: session.title, dbPath: session.dbPath || null },
          })
          if (SUCCESS_DELETE_STATUSES.has(result.status)) {
            summary.deleted.push(session)
            if (result.backupPath) summary.backupPaths.push(result.backupPath)
          } else {
            summary.failed.push({ session, message: result.message })
          }
        } catch (error) {
          summary.failed.push({ session, message: error instanceof Error ? error.message : String(error) })
        }
      }
      setDeleteSummary(summary)
      setSelectedIds((current) => {
        const next = new Set(current)
        summary.deleted.forEach((session) => next.delete(session.id))
        return next
      })
      setNotice({
        tone: summary.failed.length ? 'warning' : 'ok',
        text: summary.failed.length
          ? `已删除 ${summary.deleted.length} 个，失败 ${summary.failed.length} 个。`
          : `已删除 ${summary.deleted.length} 个会话，并创建本地备份。`,
      })
      setConfirmDelete(null)
      await refreshSessions(true, sessions?.offset ?? 0)
    } finally {
      endBusy('delete')
    }
  }, [beginBusy, confirmDelete, endBusy, refreshSessions, sessions?.offset])

  const previewSessionIndexCleanup = useCallback(async (silentWhenEmpty = false) => {
    beginBusy('index-preview')
    try {
      const result = await callCodex<SessionIndexCleanupPreviewResult>('preview_session_index_cleanup')
      if (result.status === 'failed') {
        setNotice({ tone: 'error', text: result.message })
        return result
      }
      if (result.candidates.length) {
        setCleanupSelectedIds(new Set())
        setCleanupDialog(result)
      } else if (!silentWhenEmpty) {
        setNotice({ tone: 'ok', text: '未发现仅存在于 session_index.jsonl 的失效候选记录。' })
      }
      return result
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
      return null
    } finally {
      endBusy('index-preview')
    }
  }, [beginBusy, endBusy])

  const applySessionIndexCleanup = useCallback(async () => {
    if (!cleanupDialog || !cleanupSelectedIds.size) return
    beginBusy('index-cleanup')
    try {
      const result = await callCodex<SessionIndexCleanupApplyResult>('apply_session_index_cleanup', {
        snapshotSha256: cleanupDialog.snapshotSha256,
        threadIds: [...cleanupSelectedIds],
      })
      setCleanupResult(result)
      setNotice({
        tone: result.status === 'failed' ? 'error' : 'ok',
        text: result.backupDir ? `${result.message} 备份目录：${result.backupDir}` : result.message,
      })
      if (result.status !== 'failed') {
        setCleanupDialog(null)
        setCleanupSelectedIds(new Set())
      }
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      endBusy('index-cleanup')
    }
  }, [beginBusy, cleanupDialog, cleanupSelectedIds, endBusy])

  const runProviderSync = useCallback(async () => {
    beginBusy('sync')
    setSyncResult(null)
    try {
      const result = await callCodex<ProviderSyncResult>('sync_providers_now', { targetProvider: syncTarget || null })
      setSyncResult(result)
      setNotice({ tone: result.status === 'failed' ? 'error' : result.status === 'warning' ? 'warning' : 'ok', text: result.message })
      if (result.status !== 'failed') {
        await loadSyncTargets(true)
        await previewSessionIndexCleanup(true)
      }
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      endBusy('sync')
    }
  }, [beginBusy, endBusy, loadSyncTargets, previewSessionIndexCleanup, syncTarget])

  const saveAutoRepair = useCallback(async () => {
    beginBusy('save-auto-repair')
    try {
      const result = await callCodex<SettingsResult>('save_settings', {
        settings: { ...settings, providerSyncEnabled: autoRepair },
      })
      onSettingsChange(result.settings)
      setNotice({ tone: result.status === 'failed' ? 'error' : result.status === 'warning' ? 'warning' : 'ok', text: result.message })
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      endBusy('save-auto-repair')
    }
  }, [autoRepair, beginBusy, endBusy, onSettingsChange, settings])

  return (
    <div className="sessions-page">
      {notice ? <CodexNotice tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} /> : null}

      <section className="sessions-panel sessions-overview-panel">
        <header><div><FolderClock size={18} /><strong>会话管理</strong></div><button type="button" disabled={operationBusy} onClick={() => void refreshSessions()}>{busyKeys.has('sessions') ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新会话</button></header>
        <div className="session-metrics">
          <div><span>本页会话</span><strong>{items.length}</strong><small>第 {currentPage} 页</small></div>
          <div><span>未归档</span><strong>{activeCount}</strong><small>活跃会话</small></div>
          <div><span>已归档</span><strong>{archivedCount}</strong><small>历史归档</small></div>
          <div><span>数据库</span><strong>{sessions?.dbPaths.length ?? 0}</strong><small title={sessions?.dbPath}>{sessions?.dbPath || '尚未读取'}</small></div>
        </div>
      </section>

      <section className="sessions-panel session-list-panel">
        <header><div><Database size={18} /><strong>本地会话</strong></div><span>{filteredItems.length} / {items.length}</span></header>
        <div className="session-filter-bar">
          <label className="session-search"><Search size={15} /><input value={query} placeholder="搜索标题、ID、项目路径或 Provider" onChange={(event) => setQuery(event.target.value)} /></label>
          <select value={statusFilter} aria-label="会话状态筛选" onChange={(event) => setStatusFilter(event.target.value as SessionStatusFilter)}><option value="all">全部状态</option><option value="active">未归档</option><option value="archived">已归档</option></select>
          <button type="button" className={selectionMode ? 'active' : ''} onClick={() => { setSelectionMode((value) => !value); if (selectionMode) setSelectedIds(new Set()) }}><CheckSquare2 size={14} />{selectionMode ? '退出多选' : '多选'}</button>
        </div>

        {selectionMode ? (
          <div className="session-selection-bar">
            <button type="button" disabled={!filteredItems.length} onClick={toggleSelectFiltered}>{allFilteredSelected ? '取消全选当前结果' : '全选当前结果'}</button>
            <span>已选择 {selectedIds.size} 个</span>
            <button type="button" className="danger" disabled={!selectedSessions.length || operationBusy} onClick={() => setConfirmDelete({ sessions: selectedSessions })}><Trash2 size={14} />删除已选</button>
          </div>
        ) : null}

        {filteredItems.length ? (
          <div className="session-list">
            {filteredItems.map((session) => (
              <article className={selectedIds.has(session.id) ? 'selected' : ''} key={`${session.dbPath}:${session.id}`}>
                {selectionMode ? <label className="session-checkbox"><input type="checkbox" checked={selectedIds.has(session.id)} aria-label={`选择会话 ${session.title || session.id}`} onChange={(event) => toggleSession(session.id, event.target.checked)} /></label> : null}
                <div className="session-copy">
                  <div className="session-title"><strong>{session.title || '未命名会话'}</strong><span className={session.archived ? 'archived' : 'active'}>{session.archived ? <Archive size={12} /> : <ShieldCheck size={12} />}{session.archived ? '已归档' : '活跃'}</span></div>
                  <code>{session.id}</code>
                  <span title={session.cwd || session.rolloutPath}>{session.cwd || session.rolloutPath || '未记录项目路径'}</span>
                </div>
                <div className="session-meta"><strong>{session.modelProvider || 'Provider 未记录'}</strong><span>{formatSessionTime(session.updatedAtMs)}</span><small title={session.dbPath}>{session.dbPath}</small></div>
                <button type="button" className="danger session-delete" disabled={operationBusy} onClick={() => setConfirmDelete({ sessions: [session] })}><Trash2 size={14} />删除</button>
              </article>
            ))}
          </div>
        ) : <div className="sessions-empty"><Search size={22} /><span>{items.length ? '没有符合筛选条件的会话。' : '未读取到本地会话，或 SQLite 会话库不存在。'}</span></div>}
        <footer className="session-pagination">
          <span>第 {currentPage} 页，每页 {pageSize} 条</span>
          <div>
            <button type="button" aria-label="上一页" disabled={!hasPreviousPage || operationBusy} onClick={() => void refreshSessions(false, Math.max(0, pageOffset - pageSize))}><ChevronLeft size={15} />上一页</button>
            <button type="button" aria-label="下一页" disabled={!hasNextPage || operationBusy} onClick={() => void refreshSessions(false, pageOffset + pageSize)}>下一页<ChevronRight size={15} /></button>
          </div>
        </footer>
      </section>

      <section className="sessions-panel provider-sync-panel">
        <header><div><RefreshCw size={18} /><strong>历史会话 Provider 修复</strong></div><span className={settings.providerSyncEnabled ? 'sync-enabled' : ''}>{settings.providerSyncEnabled ? '启动前自动修复已开启' : '自动修复已关闭'}</span></header>
        <p>统一修复 rollout、SQLite 索引与工作区记录中的 Provider 标记。修复前会创建备份，正在使用的文件会安全跳过。</p>
        <div className="provider-sync-controls">
          <label><span>同步目标</span><select value={syncTarget} disabled={operationBusy} onChange={(event) => setSyncTarget(event.target.value)}><option value="">自动选择当前 Provider</option>{syncTargets?.targets.map((target) => <option key={target.id} value={target.id}>{target.id}{target.isCurrentProvider ? '（当前）' : ''} · {target.sources.map(sourceLabel).join('/')}</option>)}</select></label>
          <button type="button" disabled={operationBusy} onClick={() => void loadSyncTargets()}>{busyKeys.has('sync-targets') ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />}扫描目标</button>
          <button type="button" disabled={operationBusy} onClick={() => void previewSessionIndexCleanup()}>{busyKeys.has('index-preview') ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />}扫描失效索引</button>
          <button type="button" className="primary" disabled={operationBusy} onClick={() => void runProviderSync()}>{busyKeys.has('sync') ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{busyKeys.has('sync') ? '正在修复' : '立即修复'}</button>
        </div>
        {busyKeys.has('sync') ? <div className="sync-progress" role="progressbar" aria-label="Provider 修复进行中"><span /></div> : null}
      <div className="auto-repair-row"><div><strong>启动 Codex 前自动修复</strong><span>每次通过 Codex Compass 启动 Codex 前整理旧会话 Provider 标记。</span></div><button type="button" role="switch" aria-label="启动 Codex 前自动修复 Provider" aria-checked={autoRepair} disabled={operationBusy} className={autoRepair ? 'session-toggle on' : 'session-toggle'} onClick={() => setAutoRepair((value) => !value)}><span /></button><button type="button" disabled={operationBusy || autoRepair === settings.providerSyncEnabled} onClick={() => void saveAutoRepair()}>{busyKeys.has('save-auto-repair') ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存</button></div>
        {syncResult ? <div className="sync-result-grid"><div><span>目标 Provider</span><strong>{syncResult.targetProvider || '-'}</strong></div><div><span>会话文件</span><strong>{syncResult.changedSessionFiles}</strong></div><div><span>SQLite 行</span><strong>{syncResult.sqliteRowsUpdated}</strong></div><div><span>工作区根目录</span><strong>{syncResult.updatedWorkspaceRoots}</strong></div><div><span>跳过占用文件</span><strong>{syncResult.skippedLockedRolloutFiles.length}</strong></div><div><span>备份目录</span><strong title={syncResult.backupDir ?? ''}>{syncResult.backupDir || '-'}</strong></div>{syncResult.encryptedContentWarning ? <p><CircleAlert size={14} />{syncResult.encryptedContentWarning}</p> : null}</div> : null}
        {cleanupResult && cleanupResult.status !== 'failed' ? <div className="index-cleanup-result"><span>最近清理</span><strong>{cleanupResult.prunedEntries} 条</strong><small title={cleanupResult.backupDir ?? ''}>{cleanupResult.backupDir || '未生成备份'}</small></div> : null}
      </section>

      {deleteSummary ? <section className="sessions-panel delete-summary-panel"><header><div><Trash2 size={18} /><strong>最近一次删除结果</strong></div><button type="button" onClick={() => setDeleteSummary(null)}>关闭</button></header><div className="delete-summary-metrics"><span>请求 {deleteSummary.requested}</span><span>成功 {deleteSummary.deleted.length}</span><span>失败 {deleteSummary.failed.length}</span><span>备份 {deleteSummary.backupPaths.length}</span></div>{deleteSummary.failed.length ? <ul>{deleteSummary.failed.map(({ session, message }) => <li key={`${session.dbPath}:${session.id}`}><strong>{session.title || session.id}</strong><span>{message}</span></li>)}</ul> : null}{deleteSummary.backupPaths.length ? <details><summary>查看备份路径</summary>{deleteSummary.backupPaths.map((path) => <code key={path}>{path}</code>)}</details> : null}</section> : null}

      {confirmDelete ? <div className="session-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleteBusy) setConfirmDelete(null) }}><section className="session-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="session-delete-title" aria-describedby="session-delete-description"><header><div><Trash2 size={18} /><strong id="session-delete-title">确认删除会话</strong></div><button type="button" aria-label="关闭" disabled={deleteBusy} onClick={() => setConfirmDelete(null)}><X size={16} /></button></header><p id="session-delete-description">将删除本地数据库记录和对应 rollout 文件，并为每个会话创建备份。</p><div className="session-delete-preview">{confirmDelete.sessions.slice(0, 6).map((session) => <div key={`${session.dbPath}:${session.id}`}><strong>{session.title || '未命名会话'}</strong><span>{session.id}</span></div>)}{confirmDelete.sessions.length > 6 ? <small>以及另外 {confirmDelete.sessions.length - 6} 个会话</small> : null}</div><footer><button type="button" disabled={deleteBusy} onClick={() => setConfirmDelete(null)}>取消</button><button type="button" className="danger" disabled={deleteBusy} onClick={() => void executeDelete()}>{deleteBusy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}确认删除 {confirmDelete.sessions.length} 个</button></footer></section></div> : null}

      {cleanupDialog ? <div className="session-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !cleanupBusy) setCleanupDialog(null) }}><section className="session-confirm-dialog session-index-dialog" role="dialog" aria-modal="true" aria-labelledby="session-index-title" aria-describedby="session-index-description"><header><div><CircleAlert size={18} /><strong id="session-index-title">清理失效任务索引</strong></div><button type="button" aria-label="关闭" disabled={cleanupBusy} onClick={() => setCleanupDialog(null)}><X size={16} /></button></header><p id="session-index-description">发现 {cleanupDialog.candidates.length} 条仅存在于 session_index.jsonl、未在本地数据库或 rollout 中找到来源的候选记录。它们也可能仍在云端同步，请逐项核对；执行前需要完全退出 Codex App 和 ChatGPT。</p><label className="session-index-select-all"><input type="checkbox" checked={cleanupSelectedIds.size === cleanupDialog.candidates.length} disabled={cleanupBusy} onChange={(event) => setCleanupSelectedIds(event.target.checked ? new Set(cleanupDialog.candidates.map((candidate) => candidate.id)) : new Set())} /><span>选择全部候选记录</span></label><div className="session-index-list">{cleanupDialog.candidates.map((candidate) => <label key={candidate.id}><input type="checkbox" checked={cleanupSelectedIds.has(candidate.id)} disabled={cleanupBusy} onChange={(event) => setCleanupSelectedIds((current) => { const next = new Set(current); if (event.target.checked) next.add(candidate.id); else next.delete(candidate.id); return next })} /><span><strong>{candidate.threadName || '未命名任务'}</strong><code>{candidate.id}</code><small>{candidate.updatedAt}</small></span></label>)}</div><footer><button type="button" disabled={cleanupBusy} onClick={() => setCleanupDialog(null)}>取消</button><button type="button" className="danger" disabled={cleanupBusy || !cleanupSelectedIds.size} onClick={() => void applySessionIndexCleanup()}>{cleanupBusy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}确认清理 {cleanupSelectedIds.size} 条</button></footer></section></div> : null}
    </div>
  )
}
