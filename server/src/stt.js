const DEFAULT_PROVIDER = 'local'
const DEFAULT_LOCAL_BIN = 'whisper-cli'
const DEFAULT_DEEPGRAM_MODEL = 'nova-3'
const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo'

import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim()
}

function envBool(name, fallback) {
  const raw = env(name)
  if (!raw) return fallback
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase())
}

function le16(value) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(value)
  return b
}

function le32(value) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value)
  return b
}

export function wavFromPcm(pcm, { sampleRate = 16_000, channels = 1 } = {}) {
  const data = Buffer.from(pcm)
  const rate = Math.max(8_000, Math.min(48_000, Number(sampleRate) || 16_000))
  const channelCount = Math.max(1, Math.min(2, Number(channels) || 1))
  const bitsPerSample = 16
  const blockAlign = channelCount * bitsPerSample / 8
  const byteRate = rate * blockAlign

  return Buffer.concat([
    Buffer.from('RIFF'),
    le32(36 + data.length),
    Buffer.from('WAVE'),
    Buffer.from('fmt '),
    le32(16),
    le16(1),
    le16(channelCount),
    le32(rate),
    le32(byteRate),
    le16(blockAlign),
    le16(bitsPerSample),
    Buffer.from('data'),
    le32(data.length),
    data,
  ])
}

function sttConfig() {
  const provider = env('STT_PROVIDER', DEFAULT_PROVIDER).toLowerCase()
  const providerKey =
    provider === 'groq'
      ? env('GROQ_API_KEY')
      : provider === 'deepgram'
        ? env('DEEPGRAM_API_KEY')
        : ''
  const apiKey = env('STT_API_KEY') || providerKey
  const defaultModel =
    provider === 'groq'
      ? DEFAULT_GROQ_MODEL
      : provider === 'local'
        ? ''
        : DEFAULT_DEEPGRAM_MODEL
  return {
    provider,
    apiKey,
    model: env('STT_MODEL', defaultModel),
    language: env('STT_LANGUAGE', 'en'),
    smartFormat: envBool('STT_SMART_FORMAT', true),
    localBin: env('STT_LOCAL_BIN', DEFAULT_LOCAL_BIN),
    localModel: env('STT_LOCAL_MODEL'),
    localThreads: Number(process.env.STT_LOCAL_THREADS) || 4,
    localTimeoutMs: Number(process.env.STT_LOCAL_TIMEOUT_MS) || 120_000,
    sampleRate: Number(process.env.STT_SAMPLE_RATE || process.env.AUDIO_SAMPLE_RATE) || 16_000,
    channels: Number(process.env.STT_CHANNELS || process.env.AUDIO_CHANNELS) || 1,
  }
}

async function transcribeWithDeepgram(wav, config) {
  const params = new URLSearchParams({
    model: config.model,
    smart_format: String(config.smartFormat),
    tag: 'wam-listen',
  })
  if (config.language) params.set('language', config.language)

  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${config.apiKey}`,
      'Content-Type': 'audio/wav',
    },
    body: wav,
  })
  const payload = await res.json().catch(() => null)
  if (!res.ok) throw new Error(payload?.err_msg || payload?.message || payload?.error || `stt ${res.status}`)
  return String(payload?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function transcribeWithGroq(wav, config) {
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'wam-listen.wav')
  form.append('model', config.model)
  form.append('response_format', 'json')
  form.append('temperature', '0')
  if (config.language) form.append('language', config.language)

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
  })
  const payload = await res.json().catch(() => null)
  if (!res.ok) throw new Error(payload?.error?.message || payload?.error || `stt ${res.status}`)
  return String(payload?.text || '').replace(/\s+/g, ' ').trim()
}

/**
 * Transcribe on this machine with whisper.cpp.
 *
 * The default, deliberately. The alternatives bill per minute and ship Mike's
 * conversations to somebody else's server; this keeps both the money and the
 * audio at home, which is the whole architecture of this system — the glasses
 * are a display, the work happens on his Mac.
 *
 * `-nt` drops timestamps so stdout is just the words. Progress goes to stderr
 * and is discarded. The wav is written to a private temp dir and removed in a
 * finally, including on timeout: leaving recordings of someone's conversations
 * lying around in /tmp is not an acceptable failure mode.
 */
async function transcribeLocally(wav, config) {
  if (!config.localModel) throw new Error('STT_LOCAL_MODEL is not set')
  if (!existsSync(config.localModel)) throw new Error(`model not found: ${config.localModel}`)

  const dir = mkdtempSync(join(tmpdir(), 'wam-stt-'))
  const wavPath = join(dir, 'clip.wav')
  try {
    writeFileSync(wavPath, wav)
    const { stdout } = await run(
      config.localBin,
      ['-m', config.localModel, '-f', wavPath, '-nt', '-l', config.language, '-t', String(config.localThreads)],
      { timeout: config.localTimeoutMs, maxBuffer: 8 * 1024 * 1024 },
    )
    // whisper.cpp emits a bracketed marker for a silent clip; that is not text.
    return stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !/^\[[^\]]*\]$/.test(line))
      .join(' ')
      .trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function hasTranscriber() {
  const config = sttConfig()
  if (config.provider === 'local') return Boolean(config.localModel) && existsSync(config.localModel)
  return Boolean(config.apiKey) && ['deepgram', 'groq'].includes(config.provider)
}

export function transcriberInfo() {
  const config = sttConfig()
  return {
    provider: config.provider,
    model: config.provider === 'local' ? config.localModel || '(no model set)' : config.model,
    language: config.language,
    sampleRate: config.sampleRate,
    channels: config.channels,
    configured: hasTranscriber(),
  }
}

export async function transcribePcm(pcm, options = {}) {
  const config = { ...sttConfig(), ...options }
  if (!['local', 'deepgram', 'groq'].includes(config.provider)) {
    return { ok: false, code: 400, error: `unsupported STT_PROVIDER "${config.provider}"` }
  }
  if (config.provider === 'local' && !hasTranscriber()) {
    return {
      ok: false,
      code: 503,
      error: config.localModel
        ? `whisper model not found at ${config.localModel}`
        : 'STT_LOCAL_MODEL is not set',
    }
  }
  if (config.provider !== 'local' && !config.apiKey) {
    const keyNames = config.provider === 'groq' ? 'GROQ_API_KEY or STT_API_KEY' : 'DEEPGRAM_API_KEY or STT_API_KEY'
    return { ok: false, code: 503, error: `${keyNames} is not set` }
  }

  const wav = wavFromPcm(pcm, { sampleRate: config.sampleRate, channels: config.channels })
  try {
    const text =
      config.provider === 'local'
        ? await transcribeLocally(wav, config)
        : config.provider === 'groq'
          ? await transcribeWithGroq(wav, config)
          : await transcribeWithDeepgram(wav, config)
    return {
      ok: true,
      text,
      provider: config.provider,
      model: config.provider === 'local' ? config.localModel : config.model,
    }
  } catch (err) {
    return { ok: false, code: 502, error: err.message }
  }
}
