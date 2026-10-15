import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { keepPastExpiry, wordCount } from './retention.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETENTION_MS = 14 * DAY_MS
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024

function safeId(value) {
  const id = String(value || '').trim()
  return id && id.length <= 120 && /^[a-zA-Z0-9._-]+$/.test(id) ? id : null
}

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback
}

function wavHeader(bytes, sampleRate, channels) {
  const header = Buffer.alloc(44)
  const blockAlign = channels * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + bytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(bytes, 40)
  return header
}

export class Recordings {
  constructor({ rootPath, retentionMs = DEFAULT_RETENTION_MS, maxSessionBytes = DEFAULT_MAX_BYTES } = {}) {
    this.rootPath = rootPath
    this.retentionMs = positiveInt(retentionMs, DEFAULT_RETENTION_MS)
    this.maxSessionBytes = positiveInt(maxSessionBytes, DEFAULT_MAX_BYTES)
    if (this.rootPath) mkdirSync(this.rootPath, { recursive: true, mode: 0o700 })
    this.prune()
  }

  #paths(sessionId) {
    const id = safeId(sessionId)
    if (!id || !this.rootPath) return null
    const dir = join(this.rootPath, id)
    return {
      id,
      dir,
      pcm: join(dir, 'audio.pcm'),
      transcript: join(dir, 'transcript.jsonl'),
      manifest: join(dir, 'manifest.json'),
    }
  }

  #read(sessionId) {
    const paths = this.#paths(sessionId)
    if (!paths || !existsSync(paths.manifest)) return null
    try {
      const raw = JSON.parse(readFileSync(paths.manifest, 'utf8'))
      const bytes = existsSync(paths.pcm) ? statSync(paths.pcm).size : 0
      const sampleRate = positiveInt(raw.sampleRate, 16_000)
      const channels = positiveInt(raw.channels, 1)
      return {
        ...raw,
        sessionId: paths.id,
        sampleRate,
        channels,
        bytes,
        durationSeconds: Math.round((bytes / (sampleRate * channels * 2)) * 10) / 10,
        available: bytes > 0,
      }
    } catch {
      return null
    }
  }

  #write(paths, manifest) {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
    const temp = `${paths.manifest}.tmp`
    writeFileSync(temp, JSON.stringify(manifest, null, 2), { mode: 0o600 })
    renameSync(temp, paths.manifest)
  }

  addChunk(sessionId, pcm, { sampleRate = 16_000, channels = 1, clientId = null, at = Date.now() } = {}) {
    const paths = this.#paths(sessionId)
    const data = Buffer.from(pcm || [])
    if (!paths || data.length === 0) return { ok: false, error: 'empty recording chunk' }
    try {
      const existing = this.#read(paths.id)
      const rate = positiveInt(sampleRate, 16_000)
      const channelCount = positiveInt(channels, 1)
      if (existing && (existing.sampleRate !== rate || existing.channels !== channelCount)) {
        return { ok: false, error: 'recording format changed' }
      }
      const chunkId = safeId(clientId)
      const chunkIds = Array.isArray(existing?.chunkIds) ? existing.chunkIds : []
      if (chunkId && chunkIds.includes(chunkId)) return { ok: true, duplicate: true, recording: existing }
      const bytes = Number(existing?.bytes) || 0
      if (bytes + data.length > this.maxSessionBytes) {
        return { ok: false, error: 'recording reached session size limit', recording: existing }
      }

      mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
      appendFileSync(paths.pcm, data, { mode: 0o600 })
      const stamp = positiveInt(at, Date.now())
      const manifest = {
        schemaVersion: 1,
        sessionId: paths.id,
        sampleRate: rate,
        channels: channelCount,
        createdAt: existing?.createdAt || stamp,
        updatedAt: stamp,
        endedAt: existing?.endedAt || null,
        kept: existing?.kept === true,
        expiresAt: existing?.kept === true ? null : stamp + this.retentionMs,
        chunkCount: (Number(existing?.chunkCount) || 0) + 1,
        chunkIds: chunkId ? [...chunkIds, chunkId].slice(-10_000) : chunkIds,
      }
      this.#write(paths, manifest)
      return { ok: true, recording: this.#read(paths.id) }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  }

  finalize(sessionId, endedAt = Date.now()) {
    const paths = this.#paths(sessionId)
    const existing = this.#read(sessionId)
    if (!paths || !existing) return { ok: false, error: 'recording not found' }
    try {
      const stamp = positiveInt(endedAt, Date.now())
      this.#write(paths, {
        ...existing,
        endedAt: stamp,
        updatedAt: stamp,
        expiresAt: existing.kept ? null : stamp + this.retentionMs,
        durationSeconds: undefined,
        available: undefined,
        bytes: undefined,
      })
      return { ok: true, recording: this.#read(sessionId) }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  }

  setKeep(sessionId, keep = true) {
    const paths = this.#paths(sessionId)
    const existing = this.#read(sessionId)
    if (!paths || !existing) return { ok: false, error: 'recording not found' }
    try {
      const kept = keep === true
      const anchor = existing.endedAt || existing.updatedAt || Date.now()
      this.#write(paths, {
        ...existing,
        kept,
        expiresAt: kept ? null : anchor + this.retentionMs,
        durationSeconds: undefined,
        available: undefined,
        bytes: undefined,
      })
      return { ok: true, recording: this.#read(sessionId) }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  }

  addTranscriptSegment(sessionId, segment = {}) {
    const paths = this.#paths(sessionId)
    if (!paths || !existsSync(paths.manifest)) return { ok: false, error: 'recording not found' }
    const text = String(segment.text || '').replace(/\s+/g, ' ').trim().slice(0, 2_000)
    if (!text) return { ok: false, error: 'empty transcript segment' }
    const row = {
      id: String(segment.id || '').slice(0, 120) || null,
      clientId: String(segment.clientId || '').slice(0, 120) || null,
      speaker: String(segment.speaker || 'someone').slice(0, 32),
      text,
      final: segment.final !== false,
      at: positiveInt(segment.at, Date.now()),
    }
    try {
      appendFileSync(paths.transcript, `${JSON.stringify(row)}\n`, { mode: 0o600 })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  }

  transcript(sessionId) {
    const paths = this.#paths(sessionId)
    if (!paths || !existsSync(paths.transcript)) return []
    try {
      return readFileSync(paths.transcript, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter(segment => segment?.text && segment.final !== false)
    } catch {
      return []
    }
  }

  get(sessionId) {
    return this.#read(sessionId)
  }

  summary(sessionId) {
    const recording = this.#read(sessionId)
    return recording ? this.#public(recording) : null
  }

  wav(sessionId) {
    const paths = this.#paths(sessionId)
    const recording = this.#read(sessionId)
    if (!paths || !recording?.available) return null
    const pcm = readFileSync(paths.pcm)
    return Buffer.concat([wavHeader(pcm.length, recording.sampleRate, recording.channels), pcm])
  }

  list(now = Date.now()) {
    this.prune(now)
    if (!this.rootPath || !existsSync(this.rootPath)) return []
    return readdirSync(this.rootPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => this.#read(entry.name))
      .filter(recording => recording?.available)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(recording => this.#public(recording))
  }

  /** Spoken recordings outlive their expiry date in dev retention mode. */
  #retained(recording) {
    if (recording.kept) return false
    const words = wordCount(this.transcript(recording.sessionId).map(segment => segment.text))
    return keepPastExpiry({ words, seconds: recording.durationSeconds })
  }

  #public(recording) {
    const retained = this.#retained(recording)
    return {
      sessionId: recording.sessionId,
      createdAt: recording.createdAt,
      updatedAt: recording.updatedAt,
      endedAt: recording.endedAt,
      kept: recording.kept,
      // Truthful: a recording dev retention protects does not expire.
      expiresAt: retained ? null : recording.expiresAt,
      retained,
      bytes: recording.bytes,
      durationSeconds: recording.durationSeconds,
      chunkCount: recording.chunkCount,
      available: recording.available,
    }
  }

  prune(now = Date.now()) {
    if (!this.rootPath || !existsSync(this.rootPath)) return 0
    let removed = 0
    for (const entry of readdirSync(this.rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const recording = this.#read(entry.name)
      if (!recording || recording.kept || !recording.expiresAt || recording.expiresAt > now) continue
      if (this.#retained(recording)) continue
      rmSync(join(this.rootPath, entry.name), { recursive: true, force: true })
      removed += 1
    }
    return removed
  }
}
