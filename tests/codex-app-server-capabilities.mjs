import { spawn } from 'node:child_process'
import path from 'node:path'

const codexBin = process.env.CODEX_BIN || 'codex'
const cwd = path.resolve(process.argv[2] || process.cwd())
const pending = new Map()
let nextId = 1
let stdoutBuffer = ''

const child = spawn(codexBin, ['app-server', '--stdio'], {
  cwd,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
child.stderr.on('data', () => undefined)
child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString('utf8')
  while (true) {
    const newline = stdoutBuffer.indexOf('\n')
    if (newline < 0) break
    const line = stdoutBuffer.slice(0, newline).trim()
    stdoutBuffer = stdoutBuffer.slice(newline + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id !== undefined && message.method) {
      child.stdin.write(`${JSON.stringify({
        id: message.id,
        error: { code: -32601, message: 'Diagnostic probe rejects server requests' },
      })}\n`)
      continue
    }
    const request = pending.get(message.id)
    if (!request) continue
    clearTimeout(request.timer)
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message || 'request failed'))
    else request.resolve(message.result)
  }
})

function request(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, 30_000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
}

const result = {
  cwd,
  accountType: null,
  skillCount: 0,
  pluginCount: 0,
  marketplaces: [],
  skillSamples: [],
  errors: [],
}

try {
  await request('initialize', {
    clientInfo: { name: 'codex-compass-capability-probe', title: 'Codex Compass Capability Probe', version: '1' },
    capabilities: { experimentalApi: false },
  })
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
  const [account, skills, plugins] = await Promise.all([
    request('account/read', { refreshToken: false }),
    request('skills/list', { cwds: [cwd], forceReload: false }),
    request('plugin/installed', { cwds: [cwd], installSuggestionPluginNames: [] }),
  ])
  result.accountType = account?.account?.type || null
  const skillEntries = Array.isArray(skills?.data) ? skills.data : []
  const enabledSkills = skillEntries.flatMap((entry) => entry.skills || []).filter((skill) => skill.enabled)
  result.skillCount = enabledSkills.length
  result.skillSamples = enabledSkills.slice(0, 12).map((skill) => skill.name)
  const marketplaces = Array.isArray(plugins?.marketplaces) ? plugins.marketplaces : []
  result.marketplaces = marketplaces.map((marketplace) => marketplace.name)
  result.pluginCount = marketplaces
    .flatMap((marketplace) => marketplace.plugins || [])
    .filter((plugin) => plugin.installed && plugin.enabled)
    .length
} catch (error) {
  result.errors.push(error.message || String(error))
} finally {
  child.stdin.end()
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
      resolve()
    }, 2_000)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (result.errors.length) process.exitCode = 1
