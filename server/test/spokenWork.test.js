import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SpokenWork } from '../src/spokenWork.js'
import { legacySpokenInventory } from '../src/spokenWorkImport.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wam-spoken-work-'))
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) }
}

test('legacy preview joins one note, session, and recording without writing source files', () => {
  const { dir, clean } = fixture()
  try {
    const sessionId = 's-walk-1'
    writeFileSync(join(dir, 'coach.json'), JSON.stringify({ sessions: [{
      id: sessionId, modeId: 'notes', space: 'life', startedAt: 1_000, endedAt: 2_000,
      segments: [{ id: 'seg-1', clientId: 'chunk-1', at: 1_500, speaker: 'me', text: 'Clean the cap.' }],
    }] }))
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ notes: { 'captured-notes': [
      { id: `${sessionId}:note`, by: 'listen', text: 'Clean the cap', at: 2_000 },
      { id: 'old-plain', by: 'me', text: 'Finish laundry', at: 800 },
    ] }, customTasks: [] }))
    const recordingDir = join(dir, 'recordings', sessionId)
    mkdirSync(recordingDir, { recursive: true })
    writeFileSync(join(recordingDir, 'manifest.json'), JSON.stringify({ sessionId, createdAt: 1_000, endedAt: 2_000, sampleRate: 16_000, channels: 1 }))
    writeFileSync(join(recordingDir, 'audio.pcm'), Buffer.alloc(64_000))
    writeFileSync(join(recordingDir, 'transcript.jsonl'), JSON.stringify({ id: 'seg-1', clientId: 'chunk-1', at: 1_500, speaker: 'me', text: 'Clean the cap.' }) + '\n')
    const before = readFileSync(join(dir, 'tasks.json'), 'utf8')
    const first = legacySpokenInventory(dir, 3_000)
    const second = legacySpokenInventory(dir, 3_000)
    assert.equal(first.counts.capturedNotes, 2)
    assert.equal(first.counts.coachSessions, 1)
    assert.equal(first.items.length, 2)
    assert.deepEqual(first.items.map(item => item.id), second.items.map(item => item.id))
    assert.equal(first.items.find(item => item.sessionId === sessionId).reviewState, 'needs_clarification')
    assert.equal(first.items.find(item => item.sessionId === sessionId).audio.state, 'available')
    assert.equal(readFileSync(join(dir, 'tasks.json'), 'utf8'), before)
  } finally { clean() }
})

test('canonical source key and aliases survive retries and restart', () => {
  const { dir, clean } = fixture()
  try {
    const paths = { logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') }
    const store = new SpokenWork(paths)
    const input = { sourceKey: 'coach:s-1', sourceAliases: ['task-note:captured-notes:s-1:note'],
      sourceType: 'solo_notes', sessionId: 's-1', rawSegments: [{ id: 'seg-1', at: 1_000, text: 'Clean the wheel room.' }] }
    const first = store.ingest(input, { commandId: 'ingest-1' })
    assert.equal(first.ok, true)
    assert.equal(first.item.reviewState, 'needs_clarification')
    assert.equal(store.ingest(input, { commandId: 'ingest-1' }).item.id, first.item.id)
    const restored = new SpokenWork(paths)
    assert.equal(restored.bySource('task-note:captured-notes:s-1:note').id, first.item.id)
    assert.equal(restored.list().total, 1)
  } finally { clean() }
})
