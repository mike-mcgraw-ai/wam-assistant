/**
 * One transcription of a whole recorded session, for everything that is saved.
 *
 * Live speech-to-text runs on ~2 s chunks so the glasses can show words while
 * Mike talks. Each chunk is transcribed with no context, and the model guesses
 * badly at the edges: on his real recordings the chunks produced "dashes" for
 * dishes, "clean the cap" for clean the counters, "the wheel room" for the
 * living room and "call the bet" for call the vet. The same model on the same
 * audio, run once over the whole recording, got every one of those right
 * (2026-10-15, base.en, ~1 s for 44 s of audio).
 *
 * So: chunks for the live screen, this for anything that persists — the
 * Start Day draft, the saved note, the spoken-work review card.
 *
 * Reads the recording's files directly and never constructs `Recordings`,
 * whose constructor prunes. `transcribe` is injected so the hub can pass its
 * single-file queue (one whisper process at a time) and tests can pass a fake.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SAFE_ID = /^[a-zA-Z0-9._-]{1,120}$/
// whisper labels background sound in lowercase parentheses, e.g.
// "(machinery whirring)", "(wind howling)". They were never said.
const SOUND_TAG = /\((?:[a-z]+\s?){1,4}\)/g

export async function transcribeSession(recordingsRoot, sessionId, transcribe) {
  if (!SAFE_ID.test(String(sessionId || ''))) return { ok: false, error: 'bad session id' }
  const dir = join(recordingsRoot, sessionId)
  const pcmPath = join(dir, 'audio.pcm')
  if (!existsSync(pcmPath)) return { ok: false, error: 'no recording', missing: true }

  let format = {}
  try {
    format = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  } catch {}
  const sampleRate = Number(format.sampleRate) || 16_000
  const channels = Number(format.channels) || 1

  const pcm = readFileSync(pcmPath)
  if (pcm.length === 0) return { ok: false, error: 'empty recording', missing: true }

  const out = await transcribe(pcm, { sampleRate, channels })
  if (!out?.ok) return { ok: false, error: String(out?.error || 'transcription failed') }
  return {
    ok: true,
    text: String(out.text || '').replace(SOUND_TAG, ' ').replace(/\s+/g, ' ').trim(),
    seconds: Math.round((pcm.length / (sampleRate * channels * 2)) * 10) / 10,
    source: 'full-recording',
  }
}
