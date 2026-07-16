import { gcm } from '@noble/ciphers/aes.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const elements = Object.fromEntries(
  [...document.querySelectorAll('[id]')].map((element) => [element.id, element]),
)
const query = new URLSearchParams(location.search)
const fragment = new URLSearchParams(location.hash.slice(1))
const invitationCode = normalizeCode(query.get('code') || '')
const invitationSecret = fragment.get('secret') || ''

const state = {
  cancelled: false,
  pollTimer: null,
  requestId: '',
  pollToken: '',
  pairingKey: null,
  expiresAt: 0,
}

function randomBytes(length) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('当前浏览器无法生成安全随机数，请使用新版 Chrome、Edge 或 Safari。')
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

function randomUuid() {
  const bytes = randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function bytesToBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlToBytes(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
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

function normalizeCode(value) {
  return value.replace(/\D/g, '').slice(0, 6)
}

function defaultDeviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '手机'
  const mobile = navigator.userAgentData?.mobile ? '手机' : '浏览器'
  return `${platform} ${mobile}`.trim()
}

function savedDeviceId() {
  const stored = localStorage.getItem('codexCompassRemoteDeviceId')
  if (stored) return stored
  const created = randomUuid()
  localStorage.setItem('codexCompassRemoteDeviceId', created)
  return created
}

function showView(name) {
  elements.requestView.hidden = name !== 'request'
  elements.waitingView.hidden = name !== 'waiting'
  elements.resultView.hidden = name !== 'result'
}

function showResult(title, message) {
  clearTimeout(state.pollTimer)
  elements.resultTitle.textContent = title
  elements.resultMessage.textContent = message
  showView('result')
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

function deriveVerificationCode(sharedSecret, requestId) {
  const digest = sha256(concatBytes(
    encoder.encode('codex-compass-lan-pairing-verify-v1\0'),
    sharedSecret,
    encoder.encode(requestId),
  ))
  const value = new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(0) % 1_000_000
  return String(value).padStart(6, '0')
}

async function beginPairing({ mode, code = '', credentialKind = '', credential = new Uint8Array() }) {
  state.cancelled = false
  elements.submitCodeButton.disabled = true
  elements.directRequestButton.disabled = true
  try {
    const keyPair = x25519.keygen(randomBytes(32))
    const clientPublicKey = bytesToBase64Url(keyPair.publicKey)
    const requestNonce = bytesToBase64Url(randomBytes(16))
    const deviceId = savedDeviceId()
    const canonical = proofMessage(mode, code, deviceId, clientPublicKey, requestNonce)
    const proof = mode === 'invite'
      ? bytesToBase64Url(hmac(sha256, credential, encoder.encode(canonical)))
      : null
    const response = await fetch('/api/lan/pairing/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
        code: code || null,
        credentialKind: credentialKind || null,
        proof,
        clientPublicKey,
        requestNonce,
        deviceId,
        deviceName: elements.deviceNameInput.value.trim() || defaultDeviceName(),
        browser: navigator.userAgent,
        platform: navigator.userAgentData?.platform || navigator.platform || '未知系统',
      }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || `配对请求失败（${response.status}）`)
    const sharedSecret = x25519.getSharedSecret(
      keyPair.secretKey,
      base64UrlToBytes(result.serverPublicKey),
    )
    const verificationCode = deriveVerificationCode(sharedSecret, result.requestId)
    if (verificationCode !== result.verificationCode) {
      throw new Error('双端密钥校验失败，请检查局域网是否可信。')
    }
    state.requestId = result.requestId
    state.pollToken = result.pollToken
    state.expiresAt = result.expiresAt
    state.pairingKey = derivePairingKey(
      sharedSecret,
      credential,
      result.requestId,
      mode,
    )
    elements.verificationCode.textContent = verificationCode
    elements.waitingDeviceName.textContent = elements.deviceNameInput.value.trim() || defaultDeviceName()
    elements.pairingModeText.textContent = mode === 'invite'
      ? credentialKind === 'secret' ? '电脑邀请二维码' : '六位配对码'
      : '手机主动请求'
    showView('waiting')
    updateExpiryText()
    await pollStatus()
  } catch (error) {
    showResult('无法发起配对', error.message || '请确认手机和电脑处于同一局域网。')
  } finally {
    elements.submitCodeButton.disabled = false
    elements.directRequestButton.disabled = false
  }
}

async function pollStatus() {
  if (state.cancelled || !state.requestId) return
  try {
    const response = await fetch(`/api/lan/pairing/status/${encodeURIComponent(state.requestId)}`, {
      headers: { Authorization: `Bearer ${state.pollToken}` },
      cache: 'no-store',
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || '无法读取电脑确认状态')
    if (result.status === 'approved' && result.encryptedPayload) {
      const encrypted = result.encryptedPayload
      const plaintext = gcm(
        state.pairingKey,
        base64UrlToBytes(encrypted.nonce),
        encoder.encode(encrypted.aad),
      ).decrypt(base64UrlToBytes(encrypted.ciphertext))
      const credentials = JSON.parse(decoder.decode(plaintext))
      const target = new URL(credentials.publicWebUrl)
      target.searchParams.set('room', credentials.roomId)
      target.searchParams.set('desktop', credentials.desktopDeviceId)
      target.hash = new URLSearchParams({
        token: credentials.token,
        key: credentials.key,
      }).toString()
      elements.expiryText.textContent = '电脑已批准，正在进入远程工作台'
      location.replace(target.toString())
      return
    }
    if (result.status === 'rejected') {
      showResult('电脑已拒绝请求', '这台手机未获得控制权限。需要时可重新发起配对。')
      return
    }
    if (Date.now() >= result.expiresAt) {
      showResult('配对请求已过期', '请在电脑端重新创建邀请，或再次发起请求。')
      return
    }
    updateExpiryText()
    state.pollTimer = setTimeout(pollStatus, 1500)
  } catch {
    if (Date.now() >= state.expiresAt) {
      showResult('配对请求已过期', '没有在有效时间内收到电脑确认。')
      return
    }
    elements.expiryText.textContent = '网络暂时中断，正在重试'
    state.pollTimer = setTimeout(pollStatus, 2500)
  }
}

function updateExpiryText() {
  const seconds = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000))
  elements.expiryText.textContent = `${seconds} 秒后过期`
}

elements.deviceNameInput.value = localStorage.getItem('codexCompassPairingDeviceName') || defaultDeviceName()
elements.deviceNameInput.addEventListener('change', () => {
  localStorage.setItem('codexCompassPairingDeviceName', elements.deviceNameInput.value.trim())
})
elements.pairingCodeInput.value = invitationCode
elements.pairingCodeInput.addEventListener('input', () => {
  elements.pairingCodeInput.value = normalizeCode(elements.pairingCodeInput.value)
})
elements.submitCodeButton.addEventListener('click', () => {
  const code = normalizeCode(elements.pairingCodeInput.value)
  if (code.length !== 6) {
    showResult('配对码格式不正确', '请输入电脑端显示的六位数字配对码。')
    return
  }
  void beginPairing({
    mode: 'invite',
    code,
    credentialKind: 'code',
    credential: encoder.encode(code),
  })
})
elements.directRequestButton.addEventListener('click', () => {
  void beginPairing({ mode: 'direct' })
})
elements.cancelButton.addEventListener('click', () => {
  state.cancelled = true
  state.requestId = ''
  clearTimeout(state.pollTimer)
  showView('request')
})
elements.retryButton.addEventListener('click', () => showView('request'))

if (invitationCode && invitationSecret) {
  elements.introText.textContent = '已读取电脑邀请，正在建立加密配对请求。'
  history.replaceState(null, '', `${location.pathname}?code=${encodeURIComponent(invitationCode)}`)
  void beginPairing({
    mode: 'invite',
    code: invitationCode,
    credentialKind: 'secret',
    credential: base64UrlToBytes(invitationSecret),
  })
}
