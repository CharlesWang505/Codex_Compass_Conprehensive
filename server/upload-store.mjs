import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 + 16
export const MAX_UPLOAD_STORE_BYTES = 128 * 1024 * 1024
export const UPLOAD_TTL_MS = 15 * 60 * 1000

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest()
}

function tokenMatches(value, expected) {
  const candidate = digest(value)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

export class EncryptedUploadStore {
  constructor({
    maxUploadBytes = MAX_UPLOAD_BYTES,
    maxStoreBytes = MAX_UPLOAD_STORE_BYTES,
    ttlMs = UPLOAD_TTL_MS,
  } = {}) {
    this.maxUploadBytes = maxUploadBytes
    this.maxStoreBytes = maxStoreBytes
    this.ttlMs = ttlMs
    this.bytes = 0
    this.uploads = new Map()
  }

  put({ roomId, senderDeviceId, targetDeviceId, ciphertext, now = Date.now() }) {
    this.purge(now)
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length < 17 || ciphertext.length > this.maxUploadBytes) {
      throw new Error('encrypted upload size is invalid')
    }
    if (this.bytes + ciphertext.length > this.maxStoreBytes) {
      throw new Error('encrypted upload store is full')
    }
    const uploadId = randomUUID()
    const downloadToken = randomBytes(32).toString('base64url')
    this.uploads.set(uploadId, {
      roomId,
      senderDeviceId,
      targetDeviceId,
      downloadTokenDigest: digest(downloadToken),
      ciphertext,
      expiresAt: now + this.ttlMs,
    })
    this.bytes += ciphertext.length
    return { uploadId, downloadToken, expiresAt: now + this.ttlMs }
  }

  consume({ uploadId, downloadToken, roomId, targetDeviceId, now = Date.now() }) {
    this.purge(now)
    const upload = this.uploads.get(uploadId)
    if (
      !upload
      || upload.roomId !== roomId
      || upload.targetDeviceId !== targetDeviceId
      || !tokenMatches(downloadToken, upload.downloadTokenDigest)
    ) {
      return null
    }
    this.uploads.delete(uploadId)
    this.bytes -= upload.ciphertext.length
    return upload.ciphertext
  }

  purge(now = Date.now()) {
    for (const [uploadId, upload] of this.uploads) {
      if (upload.expiresAt > now) continue
      this.uploads.delete(uploadId)
      this.bytes -= upload.ciphertext.length
    }
  }
}
