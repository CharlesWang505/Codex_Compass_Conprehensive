import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REQUEST_TIMEOUT_MS = 30_000
const TURN_TIMEOUT_MS = 120_000
const EXPECTED_REPLY = 'CODEX_COMPASS_PHASE0_OK'
const codexBin = process.env.CODEX_BIN || 'codex'
const requireChatgpt = process.argv.includes('--require-chatgpt')
const requestedModel = process.env.CODEX_PHASE0_MODEL?.trim() || null

const result = {
  protocolVersion: 2,
  cliVersion: null,
  requestedModel,
  initialized: false,
  accountDetected: false,
  accountType: null,
  localAuthenticationReusable: false,
  officialAccountReusable: false,
  credentialsExported: false,
  threadCreated: false,
  firstTurnCompleted: false,
  firstTurnStatus: null,
  firstTurnErrorCode: null,
  firstTurnHttpStatus: null,
  firstTurnErrorSummary: null,
  threadResumed: false,
  streamReceived: false,
  streamDeltaCount: 0,
  fixedReplyMatched: false,
  interruptAccepted: false,
  interruptedObserved: false,
  interruptLatencyMs: null,
  approvalsRejected: 0,
  testThreadDeleted: false,
  childExited: false,
  phase0GatePassed: false,
  chatgptGatePassed: false,
  error: null,
}

let child
let workspace
let threadId
let nextId = 1
let stdoutBuffer = ''
let interruptArmThreadId = null
let interruptStartedAt = null
let interruptPromise = null
const pending = new Map()
const notifications = []

function redact(value) {
  return String(value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|sess|codex)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replaceAll(process.env.USERPROFILE || '__NO_HOME__', '%USERPROFILE%')
}

function summarizeCodexError(error) {
  const info = error?.codexErrorInfo
  if (typeof info === 'string') return { code: info, httpStatus: null }
  if (!info || typeof info !== 'object') return { code: error ? 'other' : null, httpStatus: null }
  const [code, details] = Object.entries(info)[0] || []
  return {
    code: code || 'other',
    httpStatus: Number.isInteger(details?.httpStatusCode) ? details.httpStatusCode : null,
  }
}

function summarizeErrorMessage(error) {
  if (!error?.message) return null
  return redact(error.message)
    .replace(/https?:\/\/[^\s"']+/gi, '[URL]')
    .replace(/[A-Za-z]:\\[^\r\n"']+/g, '[PATH]')
    .slice(0, 240)
}

function write(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

function request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method}: timed out`))
    }, timeoutMs)
    pending.set(id, { method, resolve, reject, timer })
    write({ id, method, params })
  })
}

function rejectServerRequest(message) {
  const decisionMethods = new Set([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'applyPatchApproval',
    'execCommandApproval',
  ])

  let payload
  if (decisionMethods.has(message.method)) {
    payload = { decision: 'decline' }
  } else if (message.method === 'item/tool/requestUserInput') {
    payload = { answers: {} }
  } else if (message.method === 'item/permissions/requestApproval') {
    payload = { permissions: {}, scope: 'turn' }
  } else {
    write({ id: message.id, error: { code: -32601, message: 'Rejected by phase 0 probe' } })
    result.approvalsRejected += 1
    return
  }

  write({ id: message.id, result: payload })
  result.approvalsRejected += 1
}

function handleMessage(message) {
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const entry = pending.get(message.id)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(message.id)
    if (message.error) {
      entry.reject(new Error(`${entry.method}: ${message.error.message || 'request failed'}`))
    } else {
      entry.resolve(message.result)
    }
    return
  }

  if (message.id !== undefined && message.method) {
    rejectServerRequest(message)
    return
  }

  if (!message.method) return
  notifications.push(message)

  if (
    message.method === 'turn/started' &&
    interruptArmThreadId &&
    message.params?.threadId === interruptArmThreadId &&
    !interruptPromise
  ) {
    const turnId = message.params?.turn?.id
    interruptStartedAt = Date.now()
    interruptPromise = request('turn/interrupt', { threadId: interruptArmThreadId, turnId })
      .then(() => {
        result.interruptAccepted = true
        result.interruptLatencyMs = Date.now() - interruptStartedAt
      })
  }
}

function waitForNotification(predicate, timeoutMs = TURN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const poll = () => {
      const match = notifications.find(predicate)
      if (match) {
        resolve(match)
      } else if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('notification: timed out'))
      } else {
        setTimeout(poll, 20)
      }
    }
    poll()
  })
}

function parseStdout(chunk) {
  stdoutBuffer += chunk.toString('utf8')
  while (true) {
    const newline = stdoutBuffer.indexOf('\n')
    if (newline < 0) return
    const line = stdoutBuffer.slice(0, newline).trim()
    stdoutBuffer = stdoutBuffer.slice(newline + 1)
    if (!line) continue
    try {
      handleMessage(JSON.parse(line))
    } catch {
      // stderr and malformed protocol data are deliberately not echoed.
    }
  }
}

async function stopChild() {
  if (!child || child.exitCode !== null) {
    result.childExited = true
    return
  }

  child.stdin.end()
  const waitForClose = (timeoutMs) => new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true)
      return
    }
    const onClose = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.removeListener('close', onClose)
      resolve(false)
    }, timeoutMs)
    child.once('close', onClose)
  })
  let exited = await waitForClose(2_000)
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL')
    exited = await waitForClose(5_000)
  }
  result.childExited = exited || child.exitCode !== null
}

async function main() {
  const versionOutput = execFileSync(codexBin, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  result.cliVersion = versionOutput.match(/\d+\.\d+\.\d+/)?.[0] || 'unknown'
  workspace = await mkdtemp(path.join(tmpdir(), 'codex-compass-phase0-'))

  child = spawn(codexBin, ['app-server', '--stdio'], {
    cwd: workspace,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', parseStdout)
  child.stderr.on('data', () => undefined)

  await request('initialize', {
    clientInfo: { name: 'codex-compass-phase0', title: 'Codex Compass Phase 0', version: '1' },
    capabilities: { experimentalApi: false },
  })
  write({ method: 'initialized', params: {} })
  result.initialized = true

  const account = await request('account/read', { refreshToken: false })
  result.accountDetected = Boolean(account?.account)
  result.accountType = account?.account?.type || null
  result.localAuthenticationReusable = ['apiKey', 'chatgpt'].includes(result.accountType)
  result.officialAccountReusable = result.accountType === 'chatgpt'

  const threadStartParams = {
    cwd: workspace,
    ephemeral: false,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    developerInstructions: 'Do not call tools or access files. Reply only with the requested text.',
  }
  if (requestedModel) threadStartParams.model = requestedModel
  const created = await request('thread/start', threadStartParams)
  threadId = created?.thread?.id
  result.threadCreated = Boolean(threadId)

  const first = await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: `Reply with exactly ${EXPECTED_REPLY} and nothing else.` }],
    approvalPolicy: 'never',
  })
  const firstTurnId = first?.turn?.id
  const firstCompleted = await waitForNotification(
    (event) => event.method === 'turn/completed' && event.params?.turn?.id === firstTurnId,
  )
  result.firstTurnStatus = firstCompleted.params?.turn?.status || null
  result.firstTurnCompleted = result.firstTurnStatus === 'completed'
  const firstError = summarizeCodexError(firstCompleted.params?.turn?.error)
  result.firstTurnErrorCode = firstError.code
  result.firstTurnHttpStatus = firstError.httpStatus
  result.firstTurnErrorSummary = summarizeErrorMessage(firstCompleted.params?.turn?.error)

  const deltas = notifications
    .filter((event) => event.method === 'item/agentMessage/delta' && event.params?.turnId === firstTurnId)
    .map((event) => event.params?.delta || '')
  const streamedReply = deltas.join('').trim()
  result.streamDeltaCount = deltas.length
  result.streamReceived = deltas.length > 0
  result.fixedReplyMatched = streamedReply === EXPECTED_REPLY

  const resumed = await request('thread/resume', { threadId })
  result.threadResumed = resumed?.thread?.id === threadId

  interruptArmThreadId = threadId
  const second = await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Write a long numbered list from 1 to 1000.' }],
    approvalPolicy: 'never',
  })
  const secondTurnId = second?.turn?.id
  const secondCompleted = await waitForNotification(
    (event) => event.method === 'turn/completed' && event.params?.turn?.id === secondTurnId,
  )
  if (interruptPromise) await interruptPromise
  result.interruptedObserved = secondCompleted.params?.turn?.status === 'interrupted'

  result.phase0GatePassed = Boolean(
    result.threadCreated &&
    result.threadResumed &&
    result.streamReceived &&
    result.fixedReplyMatched &&
    result.interruptAccepted &&
    result.interruptedObserved &&
    result.localAuthenticationReusable,
  )
  result.chatgptGatePassed = result.phase0GatePassed && result.officialAccountReusable
}

try {
  await main()
} catch (error) {
  result.error = redact(error?.message || error)
} finally {
  if (threadId && child?.exitCode === null) {
    try {
      await request('thread/delete', { threadId }, 5_000)
      result.testThreadDeleted = true
    } catch {
      result.testThreadDeleted = false
    }
  }
  await stopChild()
  if (workspace) {
    try {
      await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch (error) {
      result.error ||= `temporary workspace cleanup failed: ${redact(error?.code || error)}`
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (result.error) process.exitCode = 1
else if (requireChatgpt && !result.chatgptGatePassed) process.exitCode = 2
