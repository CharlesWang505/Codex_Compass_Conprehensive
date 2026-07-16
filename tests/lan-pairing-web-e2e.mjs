import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { gcm } from '@noble/ciphers/aes.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

const host = '127.0.0.1'
const port = 4183
const baseUrl = `http://${host}:${port}`
const encoder = new TextEncoder()
const invitationCode = '381204'
const invitationSecret = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const credentials = {
  protocolVersion: 1,
  publicWebUrl: `${baseUrl}/remote`,
  roomId: '019f6d5d-4f9f-79f5-8f18-6463a2d3288a',
  desktopDeviceId: '019f6d5d-7ba4-72e4-a08d-9dd79f4eebc8',
  token: 't'.repeat(43),
  key: 'k'.repeat(43),
}
const requests = new Map()
const files = new Map([
  ['/pair', ['text/html; charset=utf-8', await readFile('server/web/lan-pairing.html')]],
  ['/lan-pairing.css', ['text/css; charset=utf-8', await readFile('server/web/lan-pairing.css')]],
  ['/lan-pairing.js', ['text/javascript; charset=utf-8', await readFile('server/web/lan-pairing.bundle.js')]],
])

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

function concatBytes(...values) {
  const length = values.reduce((sum, value) => sum + value.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.length
  }
  return result
}

function proofMessage(mode, code, deviceId, clientPublicKey, requestNonce) {
  return `codex-compass-lan-pairing-proof-v1\n${mode}\n${code}\n${deviceId}\n${clientPublicKey}\n${requestNonce}`
}

function derivePairingKey(sharedSecret, credential, requestId, mode) {
  return sha256(concatBytes(
    encoder.encode('codex-compass-lan-pairing-key-v1\0'),
    sharedSecret,
    sha256(credential),
    encoder.encode(requestId),
    new Uint8Array([0]),
    encoder.encode(mode),
  ))
}

function verificationCode(sharedSecret, requestId) {
  const digest = sha256(concatBytes(
    encoder.encode('codex-compass-lan-pairing-verify-v1\0'),
    sharedSecret,
    encoder.encode(requestId),
  ))
  return String(new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(0) % 1_000_000).padStart(6, '0')
}

async function bodyJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, baseUrl)
  if (request.method === 'POST' && url.pathname === '/api/lan/pairing/request') {
    const input = await bodyJson(request)
    const credential = input.mode === 'invite'
      ? input.credentialKind === 'secret'
        ? invitationSecret
        : encoder.encode(invitationCode)
      : new Uint8Array()
    if (input.mode === 'invite') {
      assert.equal(input.code, invitationCode)
      const expected = hmac(
        sha256,
        credential,
        encoder.encode(proofMessage(
          input.mode,
          input.code,
          input.deviceId,
          input.clientPublicKey,
          input.requestNonce,
        )),
      )
      assert.equal(Buffer.from(input.proof, 'base64url').equals(Buffer.from(expected)), true)
    }
    const serverKeys = x25519.keygen()
    const shared = x25519.getSharedSecret(
      serverKeys.secretKey,
      Buffer.from(input.clientPublicKey, 'base64url'),
    )
    const requestId = crypto.randomUUID()
    const pollToken = crypto.randomUUID()
    const pairingKey = derivePairingKey(shared, credential, requestId, input.mode)
    requests.set(requestId, { pairingKey, pollToken, polls: 0, input })
    json(response, 201, {
      requestId,
      pollToken,
      serverPublicKey: bytesToBase64Url(serverKeys.publicKey),
      verificationCode: verificationCode(shared, requestId),
      expiresAt: Date.now() + 120_000,
    })
    return
  }

  const statusMatch = url.pathname.match(/^\/api\/lan\/pairing\/status\/([^/]+)$/)
  if (request.method === 'GET' && statusMatch) {
    const pending = requests.get(statusMatch[1])
    assert.ok(pending)
    assert.equal(request.headers.authorization, `Bearer ${pending.pollToken}`)
    pending.polls += 1
    if (pending.polls < 2) {
      json(response, 200, { status: 'pending', expiresAt: Date.now() + 120_000 })
      return
    }
    const aad = `codex-compass-lan-pairing-payload-v1\n${statusMatch[1]}`
    const nonce = Uint8Array.from({ length: 12 }, (_, index) => 20 + index)
    const ciphertext = gcm(pending.pairingKey, nonce, encoder.encode(aad))
      .encrypt(encoder.encode(JSON.stringify(credentials)))
    json(response, 200, {
      status: 'approved',
      expiresAt: Date.now() + 120_000,
      encryptedPayload: {
        nonce: bytesToBase64Url(nonce),
        ciphertext: bytesToBase64Url(ciphertext),
        aad,
      },
    })
    return
  }

  if (url.pathname === '/remote') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>paired</title><p id="paired">paired</p>')
    return
  }
  const file = files.get(url.pathname === '/' ? '/pair' : url.pathname)
  if (file) {
    response.writeHead(200, { 'Content-Type': file[0], 'Cache-Control': 'no-store' })
    response.end(file[1])
    return
  }
  response.writeHead(404)
  response.end()
})

await new Promise((resolve) => server.listen(port, host, resolve))
const browser = await chromium.launch({ headless: true })
const consoleErrors = []
const screenshot = path.join(process.env.TEMP || '.', 'codex-compass-lan-pairing.png')

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  await page.goto(`${baseUrl}/pair?code=${invitationCode}#secret=${bytesToBase64Url(invitationSecret)}`)
  await page.locator('#waitingView').waitFor({ state: 'visible' })
  assert.match(await page.locator('#verificationCode').textContent(), /^\d{6}$/)
  await page.screenshot({ path: screenshot, fullPage: false })
  await page.locator('#paired').waitFor({ timeout: 10_000 })
  const pairedUrl = new URL(page.url())
  assert.equal(pairedUrl.searchParams.get('room'), credentials.roomId)
  assert.equal(pairedUrl.searchParams.get('desktop'), credentials.desktopDeviceId)
  const pairedFragment = new URLSearchParams(pairedUrl.hash.slice(1))
  assert.equal(pairedFragment.get('token'), credentials.token)
  assert.equal(pairedFragment.get('key'), credentials.key)

  const directPage = await browser.newPage({ viewport: { width: 390, height: 844 } })
  directPage.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  directPage.on('pageerror', (error) => consoleErrors.push(error.message))
  await directPage.goto(`${baseUrl}/pair`)
  await directPage.locator('#deviceNameInput').fill('主动请求手机')
  await directPage.locator('#directRequestButton').click()
  await directPage.locator('#waitingView').waitFor({ state: 'visible' })
  await directPage.getByText('手机主动请求', { exact: true }).waitFor()
  await directPage.locator('#paired').waitFor({ timeout: 10_000 })
  assert.equal(new URL(directPage.url()).searchParams.get('room'), credentials.roomId)
  assert.deepEqual(consoleErrors, [])
  process.stdout.write(`${JSON.stringify({
    ok: true,
    insecureHttpCryptoFallback: true,
    requests: [...requests.values()].map((request) => ({
      mode: request.input.mode,
      credentialKind: request.input.credentialKind,
      polls: request.polls,
    })),
    screenshot,
  }, null, 2)}\n`)
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
