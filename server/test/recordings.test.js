import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Recordings } from '../src/recordings.js'

function temporaryRecordings(options = {}) {
  const rootPath = mkdtempSync(join(tmpdir(), 'wam-recordings-test-'))
  return {
    rootPath,
    recordings: new Recordings({ rootPath, ...options }),
    clean: () => rmSync(rootPath, { recursive: true, force: true }),
  }
}

test('recording chunks become one playable WAV and retries do not duplicate audio', () => {
  const fixture = temporaryRecordings()
  try {
    const first = Buffer.from([1, 2, 3, 4])
    const second = Buffer.from([5, 6, 7, 8])
    assert.equal(fixture.recordings.addChunk('session-1', first, { clientId: 'chunk-1', at: 1_000 }).ok, true)
    assert.equal(fixture.recordings.addChunk('session-1', first, { clientId: 'chunk-1', at: 1_100 }).duplicate, true)
    assert.equal(fixture.recordings.addChunk('session-1', second, { clientId: 'chunk-2', at: 2_000 }).ok, true)

    const wav = fixture.recordings.wav('session-1')
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF')
    assert.equal(wav.subarray(8, 12).toString(), 'WAVE')
    assert.deepEqual(wav.subarray(44), Buffer.concat([first, second]))
    assert.equal(fixture.recordings.get('session-1').chunkCount, 2)
    assert.equal(fixture.recordings.summary('session-1').chunkIds, undefined)
    assert.equal(fixture.recordings.addTranscriptSegment('session-1', {
      id: 'line-1', clientId: 'chunk-1', speaker: 'me', text: 'This is the exact STT output.', at: 1_500,
    }).ok, true)
    assert.deepEqual(fixture.recordings.transcript('session-1').map(segment => segment.text), [
      'This is the exact STT output.',
    ])
  } finally {
    fixture.clean()
  }
})

test('ordinary recordings expire while kept recordings survive pruning', () => {
  const fixture = temporaryRecordings({ retentionMs: 1_000 })
  try {
    fixture.recordings.addChunk('expires', Buffer.from([1, 2]), { at: 1_000 })
    fixture.recordings.addChunk('kept', Buffer.from([3, 4]), { at: 1_000 })
    fixture.recordings.finalize('expires', 2_000)
    fixture.recordings.finalize('kept', 2_000)
    fixture.recordings.setKeep('kept', true)

    assert.equal(fixture.recordings.prune(3_001), 1)
    assert.equal(fixture.recordings.get('expires'), null)
    assert.equal(fixture.recordings.get('kept').kept, true)
  } finally {
    fixture.clean()
  }
})
