import { createHash, timingSafeEqual } from 'node:crypto'

export const PROTOCOL_VERSION = 1
export const MAX_MESSAGE_BYTES = 512 * 1024
export const MAX_MESSAGES_PER_MINUTE = 600

export function tokenDigest(token) {
  return createHash('sha256').update(String(token), 'utf8').digest()
}

export function tokenMatches(token, digest) {
  const candidate = tokenDigest(token)
  return candidate.length === digest.length && timingSafeEqual(candidate, digest)
}

export function validateAuth(value) {
  if (!value || value.protocolVersion !== PROTOCOL_VERSION || value.kind !== 'auth') {
    return '协议版本或认证消息无效'
  }
  if (!['desktop', 'mobile'].includes(value.role)) return '设备角色无效'
  if (!/^[A-Za-z0-9-]{16,128}$/.test(value.roomId || '')) return '房间 ID 无效'
  if (!/^[A-Za-z0-9-]{8,128}$/.test(value.deviceId || '')) return '设备 ID 无效'
  if (typeof value.token !== 'string' || value.token.length < 32 || value.token.length > 256) {
    return '访问密钥无效'
  }
  return null
}

export function validateRelayFrame(value, connection) {
  if (!value || value.protocolVersion !== PROTOCOL_VERSION || value.kind !== 'relay') return false
  if (value.roomId !== connection.roomId || value.senderDeviceId !== connection.deviceId) return false
  if (typeof value.messageId !== 'string' || value.messageId.length < 8 || value.messageId.length > 128) return false
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) return false
  if (typeof value.nonce !== 'string' || typeof value.payload !== 'string') return false
  if (value.targetDeviceId != null && typeof value.targetDeviceId !== 'string') return false
  return true
}

export class SlidingRateLimit {
  constructor(limit = MAX_MESSAGES_PER_MINUTE, windowMs = 60_000) {
    this.limit = limit
    this.windowMs = windowMs
    this.timestamps = []
  }

  accept(now = Date.now()) {
    while (this.timestamps.length && this.timestamps[0] <= now - this.windowMs) this.timestamps.shift()
    if (this.timestamps.length >= this.limit) return false
    this.timestamps.push(now)
    return true
  }
}

export class RoomRegistry {
  constructor() {
    this.rooms = new Map()
  }

  authenticate(auth, socket) {
    const error = validateAuth(auth)
    if (error) return { error }
    let room = this.rooms.get(auth.roomId)
    if (!room) {
      if (auth.role !== 'desktop') return { error: '电脑设备离线或尚未注册房间' }
      room = { tokenDigest: tokenDigest(auth.token), connections: new Map() }
      this.rooms.set(auth.roomId, room)
    } else if (!tokenMatches(auth.token, room.tokenDigest)) {
      return { error: '房间访问密钥不匹配' }
    }
    const existing = room.connections.get(auth.deviceId)
    if (existing && existing.socket !== socket) existing.socket.close(4002, 'replaced')
    const connection = {
      socket,
      roomId: auth.roomId,
      deviceId: auth.deviceId,
      role: auth.role,
      limiter: new SlidingRateLimit(),
      uploadLimiter: new SlidingRateLimit(30),
    }
    room.connections.set(auth.deviceId, connection)
    return { room, connection }
  }

  remove(connection) {
    const room = this.rooms.get(connection.roomId)
    if (!room) return
    if (room.connections.get(connection.deviceId)?.socket === connection.socket) {
      room.connections.delete(connection.deviceId)
    }
    if (room.connections.size === 0) this.rooms.delete(connection.roomId)
  }

  authorizeDevice({ roomId, deviceId, token, role }) {
    const room = this.rooms.get(roomId)
    if (!room || !tokenMatches(token, room.tokenDigest)) return false
    const connection = room.connections.get(deviceId)
    return connection?.role === role
  }

  authorizeUpload({ roomId, deviceId, targetDeviceId, token }) {
    const room = this.rooms.get(roomId)
    if (!room || !tokenMatches(token, room.tokenDigest)) return false
    const sender = room.connections.get(deviceId)
    const target = room.connections.get(targetDeviceId)
    return sender?.role === 'mobile'
      && target?.role === 'desktop'
      && sender.uploadLimiter.accept()
  }

  targets(connection, targetDeviceId) {
    const room = this.rooms.get(connection.roomId)
    if (!room) return []
    if (targetDeviceId) {
      const target = room.connections.get(targetDeviceId)
      const validRoles = connection.role === 'mobile'
        ? target?.role === 'desktop'
        : connection.role === 'desktop' && target?.role === 'mobile'
      return target && target.socket !== connection.socket && validRoles ? [target] : []
    }
    if (connection.role !== 'desktop') return []
    return [...room.connections.values()].filter((item) => item.socket !== connection.socket && item.role === 'mobile')
  }
}
