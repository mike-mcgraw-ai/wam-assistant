import { randomUUID, createHash } from 'node:crypto'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'voice-profile')
const MAX_BYTES = 1_200_000
const MIN_SECONDS = 3
const MAX_SECONDS = 30
const CLIP_ID = /^[a-f0-9-]{36}$/

function inspectWav(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('clip must be a WAV file')
  }
  let format = null
  let audio = null
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + size > bytes.length) throw new Error('truncated WAV chunk')
    const kind = bytes.toString('ascii', offset, offset + 4)
    if (kind === 'fmt ' && size >= 16) {
      format = {
        encoding: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        rate: bytes.readUInt32LE(start + 4),
        bits: bytes.readUInt16LE(start + 14),
      }
    }
    if (kind === 'data') audio = bytes.subarray(start, start + size)
    offset = start + size + (size % 2)
  }
  if (!format || format.encoding !== 1 || format.channels !== 1 || format.rate !== 16_000 || format.bits !== 16) {
    throw new Error('clip must be 16 kHz mono 16-bit PCM')
  }
  if (!audio || audio.length % 2 !== 0) throw new Error('clip has no valid PCM')
  const seconds = audio.length / 32_000
  if (seconds < MIN_SECONDS || seconds > MAX_SECONDS) throw new Error('clip must contain 3–30 seconds of audio')
  let hasSignal = false
  for (let offset = 0; offset < audio.length; offset += 2) {
    if (audio.readInt16LE(offset) !== 0) { hasSignal = true; break }
  }
  if (!hasSignal) throw new Error('clip is silent')
  return { seconds: Math.round(seconds * 10) / 10 }
}

export class VoiceProfileStore {
  constructor(root = DEFAULT_ROOT) {
    if (basename(root) !== 'voice-profile') throw new Error('voice profile root must be a dedicated voice-profile directory')
    this.root = root
  }

  #ensurePrivateRoot() {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const info = lstatSync(this.root)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error('voice profile directory must be private and must not be a symlink')
    }
  }

  #manifest() {
    if (!existsSync(this.root)) return { schemaVersion: 1, clips: [] }
    this.#ensurePrivateRoot()
    const path = join(this.root, 'manifest.json')
    if (!existsSync(path)) return { schemaVersion: 1, clips: [] }
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error('voice profile manifest must be a private regular file')
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.clips)) throw new Error('unsupported voice profile manifest')
    return parsed
  }

  #save(manifest) {
    const temp = join(this.root, `manifest-${randomUUID()}.tmp`)
    try {
      writeFileSync(temp, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 })
      renameSync(temp, join(this.root, 'manifest.json'))
    } finally {
      rmSync(temp, { force: true })
    }
  }

  status() {
    const manifest = this.#manifest()
    return {
      stagedClipCount: manifest.clips.length,
      clips: manifest.clips.map(({ id, seconds, stagedAt }) => ({ id, seconds, stagedAt })),
      verificationReady: false,
      model: null,
    }
  }

  stageClip(sourcePath, { selected = false, mike = false, clean = false, consent = false } = {}) {
    if (!selected || !mike || !clean || !consent) {
      throw new Error('explicit selection and Mike/clean/consent confirmations are required')
    }
    if (!sourcePath || !statSync(sourcePath).isFile() || lstatSync(sourcePath).isSymbolicLink()) {
      throw new Error('clip must be a regular local file')
    }
    const size = statSync(sourcePath).size
    if (size > MAX_BYTES) throw new Error('clip exceeds the 30-second size limit')
    const bytes = readFileSync(sourcePath)
    const { seconds } = inspectWav(bytes)
    this.#ensurePrivateRoot()
    const manifest = this.#manifest()
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (manifest.clips.some(clip => clip.sha256 === sha256)) throw new Error('clip is already staged')
    const id = randomUUID()
    const path = join(this.root, `${id}.wav`)
    try {
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
      chmodSync(path, 0o600)
      manifest.clips.push({ id, sha256, seconds, stagedAt: Date.now(), attestation: 'manual-clean-mike' })
      this.#save(manifest)
    } catch (error) {
      rmSync(path, { force: true })
      throw error
    }
    return { id, seconds, verificationReady: false }
  }

  removeClip(id) {
    if (!CLIP_ID.test(String(id))) throw new Error('invalid clip id')
    this.#ensurePrivateRoot()
    const manifest = this.#manifest()
    if (!manifest.clips.some(clip => clip.id === id)) throw new Error('unknown clip id')
    manifest.clips = manifest.clips.filter(clip => clip.id !== id)
    this.#save(manifest)
    rmSync(join(this.root, `${id}.wav`), { force: true })
    return this.status()
  }

  reset() {
    if (!existsSync(this.root)) return this.status()
    this.#ensurePrivateRoot()
    const owned = name => name === 'manifest.json'
      || (name.endsWith('.wav') && CLIP_ID.test(name.slice(0, -4)))
      || (name.startsWith('manifest-') && name.endsWith('.tmp') && CLIP_ID.test(name.slice(9, -4)))
    if (readdirSync(this.root).some(name => !owned(name))) throw new Error('unexpected voice profile files; reset refused')
    rmSync(this.root, { recursive: true, force: true })
    return this.status()
  }
}
