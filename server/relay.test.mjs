import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RoomRegistry,
  SlidingRateLimit,
  tokenDigest,
  tokenMatches,
  validateAuth,
  validateRelayFrame,
} from './relay-core.mjs'
import { EncryptedUploadStore } from './upload-store.mjs'

const auth = {
  protocolVersion: 1,
  kind: 'auth',
  role: 'desktop',
  roomId: '019f6151-badc-72d0-b5ac-dc9bed3c2efd',
  deviceId: 'desktop-device-1',
  token: 'a'.repeat(43),
}

test('tokens are compared by digest', () => {
  const digest = tokenDigest(auth.token)
  assert.equal(tokenMatches(auth.token, digest), true)
  assert.equal(tokenMatches('b'.repeat(43), digest), false)
})

test('room registry isolates rooms and rejects a wrong token', () => {
  const registry = new RoomRegistry()
  const desktopSocket = { close() {} }
  const mobileSocket = { close() {} }
  const desktop = registry.authenticate(auth, desktopSocket)
  assert.equal(desktop.error, undefined)
  const rejected = registry.authenticate({ ...auth, role: 'mobile', deviceId: 'mobile-device-1', token: 'b'.repeat(43) }, mobileSocket)
  assert.match(rejected.error, /密钥/)
  const mobile = registry.authenticate({ ...auth, role: 'mobile', deviceId: 'mobile-device-1' }, mobileSocket)
  assert.equal(registry.targets(mobile.connection, auth.deviceId).length, 1)
  assert.equal(registry.authorizeUpload({
    roomId: auth.roomId,
    deviceId: mobile.connection.deviceId,
    targetDeviceId: auth.deviceId,
    token: auth.token,
  }), true)
  assert.equal(registry.authorizeUpload({
    roomId: auth.roomId,
    deviceId: mobile.connection.deviceId,
    targetDeviceId: 'missing-desktop',
    token: auth.token,
  }), false)
  const secondMobile = registry.authenticate({ ...auth, role: 'mobile', deviceId: 'mobile-device-2' }, { close() {} })
  assert.equal(registry.targets(mobile.connection, secondMobile.connection.deviceId).length, 0)
  assert.equal(registry.targets(mobile.connection, null).length, 0)
  assert.equal(registry.targets(desktop.connection, null).length, 2)
})

test('a mobile device cannot create or squat an empty room', () => {
  const registry = new RoomRegistry()
  const mobile = registry.authenticate(
    { ...auth, role: 'mobile', deviceId: 'mobile-device-1' },
    { close() {} },
  )
  assert.match(mobile.error, /电脑设备离线/)
  const desktop = registry.authenticate(auth, { close() {} })
  assert.equal(desktop.error, undefined)
})

test('relay frame sender must match authenticated connection', () => {
  const connection = { roomId: auth.roomId, deviceId: auth.deviceId }
  const frame = {
    protocolVersion: 1,
    kind: 'relay',
    roomId: auth.roomId,
    senderDeviceId: auth.deviceId,
    targetDeviceId: null,
    messageId: 'message-123',
    sequence: 1,
    nonce: 'nonce',
    payload: 'ciphertext',
  }
  assert.equal(validateRelayFrame(frame, connection), true)
  assert.equal(validateRelayFrame({ ...frame, senderDeviceId: 'other' }, connection), false)
  assert.equal(validateAuth({ ...auth, token: 'short' }), '访问密钥无效')
})

test('rate limit rejects excess messages inside the window', () => {
  const limit = new SlidingRateLimit(2, 1_000)
  assert.equal(limit.accept(1_000), true)
  assert.equal(limit.accept(1_100), true)
  assert.equal(limit.accept(1_200), false)
  assert.equal(limit.accept(2_001), true)
})

test('encrypted uploads are isolated, expire, and can only be consumed once', () => {
  const store = new EncryptedUploadStore({ maxUploadBytes: 64, maxStoreBytes: 128, ttlMs: 100 })
  const created = store.put({
    roomId: auth.roomId,
    senderDeviceId: 'mobile-device-1',
    targetDeviceId: auth.deviceId,
    ciphertext: Buffer.alloc(32, 7),
    now: 1_000,
  })

  assert.equal(store.consume({
    uploadId: created.uploadId,
    downloadToken: 'wrong',
    roomId: auth.roomId,
    targetDeviceId: auth.deviceId,
    now: 1_001,
  }), null)
  assert.equal(store.consume({
    uploadId: created.uploadId,
    downloadToken: created.downloadToken,
    roomId: auth.roomId,
    targetDeviceId: 'other-desktop',
    now: 1_001,
  }), null)

  const ciphertext = store.consume({
    uploadId: created.uploadId,
    downloadToken: created.downloadToken,
    roomId: auth.roomId,
    targetDeviceId: auth.deviceId,
    now: 1_001,
  })
  assert.equal(ciphertext.length, 32)
  assert.equal(store.consume({
    uploadId: created.uploadId,
    downloadToken: created.downloadToken,
    roomId: auth.roomId,
    targetDeviceId: auth.deviceId,
    now: 1_002,
  }), null)

  const expiring = store.put({
    roomId: auth.roomId,
    senderDeviceId: 'mobile-device-1',
    targetDeviceId: auth.deviceId,
    ciphertext: Buffer.alloc(17, 1),
    now: 2_000,
  })
  assert.equal(store.consume({
    uploadId: expiring.uploadId,
    downloadToken: expiring.downloadToken,
    roomId: auth.roomId,
    targetDeviceId: auth.deviceId,
    now: 2_101,
  }), null)
})
