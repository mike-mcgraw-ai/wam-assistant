import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Recordings } from '../src/recordings.js'
import { Coach } from '../src/coach.js'
import { RETENTION_MODE } from '../src/retention.js'

const DAY = 86_400_000
const SECOND_OF_AUDIO = Buffer.alloc(32_000) // 16 kHz mono 16-bit

test('dev retention is the configured mode while Review Spoken Work is built', () => {
  assert.equal(RETENTION_MODE, 'dev')
})

test('a spoken recording outlives its expiry date; an empty or tiny one does not', () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'wam-retention-'))
  try {
    const recordings = new Recordings({ rootPath })
    const old = Date.now() - 30 * DAY

    recordings.addChunk('spoken', Buffer.concat(Array(5).fill(SECOND_OF_AUDIO)), { at: old })
    recordings.addTranscriptSegment('spoken', { text: 'Clean the cap', at: old })
    recordings.finalize('spoken', old)

    recordings.addChunk('silent', Buffer.concat(Array(5).fill(SECOND_OF_AUDIO)), { at: old })
    recordings.finalize('silent', old)

    recordings.addChunk('blip', SECOND_OF_AUDIO, { at: old })
    recordings.addTranscriptSegment('blip', { text: 'uh', at: old })
    recordings.finalize('blip', old)

    recordings.prune()
    assert.ok(existsSync(join(rootPath, 'spoken')), 'spoken recording kept')
    assert.ok(!existsSync(join(rootPath, 'silent')), 'no words: expires')
    assert.ok(!existsSync(join(rootPath, 'blip')), 'under the minimum length: expires')
    assert.equal(recordings.summary('spoken').expiresAt, null, 'a retained recording does not claim an expiry')
    assert.equal(recordings.summary('spoken').retained, true)
  } finally {
    rmSync(rootPath, { recursive: true, force: true })
  }
})

test('whole-recording words retain audio when short chunk transcripts missed them', () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'wam-full-retention-'))
  try {
    const recordings = new Recordings({ rootPath })
    const old = Date.now() - 30 * DAY
    recordings.addChunk('full-only', Buffer.concat(Array(5).fill(SECOND_OF_AUDIO)), { at: old })
    recordings.finalize('full-only', old)
    assert.equal(recordings.saveFullTranscript('full-only', 'Clean the counters and the living room.').ok, true)
    recordings.prune()
    assert.equal(recordings.fullTranscript('full-only'), 'Clean the counters and the living room.')
    assert.equal(recordings.summary('full-only').retained, true)
    assert.equal(recordings.summary('full-only').expiresAt, null)
  } finally {
    rmSync(rootPath, { recursive: true, force: true })
  }
})

test('an ended Listen session with words survives the 14-day cut; a wordless one does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wam-retention-coach-'))
  try {
    const storePath = join(dir, 'coach.json')
    const coach = new Coach({ storePath, logPath: join(dir, 'coach.jsonl') })
    const old = Date.now() - 30 * DAY

    const spoken = coach.startSession({ space: 'life', clientId: 'spoken', at: old }).session.id
    coach.addSegment(spoken, { text: 'Call the vet about Rex', speaker: 'me', at: old + 10_000 })
    coach.endSession(spoken, old + 60_000)

    const empty = coach.startSession({ space: 'life', clientId: 'empty', at: old }).session.id
    coach.endSession(empty, old + 60_000)

    // Any later write persists the store and applies the cut.
    coach.startSession({ space: 'ops', clientId: 'now' })

    const kept = JSON.parse(readFileSync(storePath, 'utf8')).sessions.map(s => s.id)
    assert.ok(kept.includes(spoken), 'spoken session kept')
    assert.ok(!kept.includes(empty), 'wordless session dropped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
