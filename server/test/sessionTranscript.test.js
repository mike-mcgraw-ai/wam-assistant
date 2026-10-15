import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { transcribeSession } from '../src/sessionTranscript.js'

test('the whole recording goes to the transcriber once, in its own format', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wam-session-transcript-'))
  try {
    mkdirSync(join(root, 's-1'))
    writeFileSync(join(root, 's-1', 'audio.pcm'), Buffer.alloc(32_000 * 3)) // 3 s, 16 kHz mono
    writeFileSync(join(root, 's-1', 'manifest.json'), JSON.stringify({ sampleRate: 16_000, channels: 1 }))

    const calls = []
    const out = await transcribeSession(root, 's-1', async (pcm, format) => {
      calls.push({ bytes: pcm.length, format })
      return { ok: true, text: '  Clean the counters  and the living room. (wind howling) ' }
    })

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { bytes: 96_000, format: { sampleRate: 16_000, channels: 1 } })
    assert.deepEqual(out, { ok: true, text: 'Clean the counters and the living room.', seconds: 3, source: 'full-recording' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('no recording, or a failed pass, is reported rather than guessed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wam-session-transcript-'))
  try {
    const never = async () => assert.fail('transcriber must not run without audio')
    assert.equal((await transcribeSession(root, 'absent', never)).missing, true)
    assert.equal((await transcribeSession(root, '../escape', never)).ok, false)

    mkdirSync(join(root, 's-2'))
    writeFileSync(join(root, 's-2', 'audio.pcm'), Buffer.alloc(32_000))
    const failed = await transcribeSession(root, 's-2', async () => ({ ok: false, error: 'whisper busy' }))
    assert.deepEqual(failed, { ok: false, error: 'whisper busy' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
