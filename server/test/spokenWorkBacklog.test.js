import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SpokenWork, spokenWorkProgress } from '../src/spokenWork.js'
import { ingestCoachCapture, reconcileRecentCaptures } from '../src/spokenWorkCapture.js'
import { legacySpokenInventory } from '../src/spokenWorkImport.js'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wam-spoken-backlog-'))
  const paths = { logPath: join(directory, 'spoken-work.jsonl'), indexPath: join(directory, 'spoken-work.json') }
  return { directory, paths, clean: () => rmSync(directory, { recursive: true, force: true }) }
}

test('ended capture is canonical before legacy note routing and note linkage is idempotent', () => {
  const context = fixture()
  try {
    const store = new SpokenWork(context.paths)
    const session = { id: 's-new-solo', modeId: 'notes', space: 'life', startedAt: 2_000, endedAt: 3_000,
      segments: [{ id: 'segment-1', at: 2_100, text: 'Sketch the next home idea.' }] }
    let kept = false
    const recordings = {
      transcript: () => [],
      summary: () => ({ available: true, kept, expiresAt: kept ? null : 9_000 }),
      setKeep: () => { kept = true; return { ok: true } },
    }
    const first = ingestCoachCapture({ store, recordings, session, fullText: 'Sketch the next home idea.' })
    assert.equal(first.ok, true)
    assert.equal(first.item.sourceKey, 'coach:s-new-solo')
    assert.equal(first.item.audio.kept, true)
    assert.equal(first.item.destinationRefs.length, 0)
    const linked = ingestCoachCapture({ store, recordings, session, fullText: 'Sketch the next home idea.',
      note: { kind: 'capture', summaryTarget: { kind: 'task', subjectId: 'captured-notes', noteId: 's-new-solo:note' } } })
    assert.equal(linked.ok, true)
    assert.equal(linked.item.sourceRefs.some(ref => ref.id === 'captured-notes:s-new-solo:note'), true)
    assert.equal(linked.item.destinationRefs.length, 0)
    const events = store.events.length
    ingestCoachCapture({ store, recordings, session, fullText: 'Sketch the next home idea.',
      note: { kind: 'capture', summaryTarget: { kind: 'task', subjectId: 'captured-notes', noteId: 's-new-solo:note' } } })
    assert.equal(store.events.length, events)
    assert.equal(new SpokenWork(context.paths).all().length, 1)
  } finally { context.clean() }
})

test('post-migration Solo Note recovery starts newest without changing 70 prior cards or source evidence', () => {
  const context = fixture()
  try {
    const store = new SpokenWork(context.paths)
    for (let index = 0; index < 70; index++) {
      store.ingest({ sourceKey: `coach:migrated-${index}`, sourceType: 'solo_notes', capturedAt: 1_000 + index,
        rawText: `Migrated source ${index}`, ingest: 'migration' }, { actor: 'migration' })
    }
    const sessionId = 's-glasses-mvc9gpry'
    const sourceText = 'Doctor and vet calls are already handled; review these notes later.'
    const coachPath = join(context.directory, 'coach.json')
    writeFileSync(coachPath, JSON.stringify({ sessions: [{ id: sessionId, modeId: 'notes', space: 'life',
      startedAt: 2_000, endedAt: 3_000, segments: [{ id: 'segment-1', at: 2_100, text: sourceText }] }] }))
    writeFileSync(join(context.directory, 'tasks.json'), JSON.stringify({ notes: { 'captured-notes': [
      { id: `${sessionId}:note`, by: 'listen', text: sourceText, at: 3_000 },
    ] }, customTasks: [] }))
    const recordingDirectory = join(context.directory, 'recordings', sessionId)
    mkdirSync(recordingDirectory, { recursive: true })
    const manifestPath = join(recordingDirectory, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({ sessionId, createdAt: 2_000, endedAt: 3_000,
      sampleRate: 16_000, channels: 1, kept: true, expiresAt: null }))
    writeFileSync(join(recordingDirectory, 'audio.pcm'), Buffer.alloc(64_000))
    writeFileSync(join(recordingDirectory, 'full-transcript.json'), JSON.stringify({ text: sourceText }))
    const coachBefore = readFileSync(coachPath)
    const manifestBefore = readFileSync(manifestPath)
    const inventory = legacySpokenInventory(context.directory, 4_000)
    assert.equal(inventory.items.length, 1)
    const recordings = { setKeep: () => { throw new Error('already kept') }, summary: () => null }
    const recovered = reconcileRecentCaptures({ store, inventory, recordings })
    assert.deepEqual(recovered, { imported: 1, failures: [] })
    const card = store.bySource(`coach:${sessionId}`)
    assert.equal(card.rawTranscript.text, sourceText)
    assert.equal(card.audio.state, 'available')
    assert.equal(card.audio.kept, true)
    assert.deepEqual(card.destinationRefs, [])
    assert.equal(store.list().items[0].id, card.id)
    assert.deepEqual(spokenWorkProgress(store.all()), { total: 71, needsReview: 71, reviewed: 0, ignored: 0, done: 0, other: 0 })
    assert.deepEqual(readFileSync(coachPath), coachBefore)
    assert.deepEqual(readFileSync(manifestPath), manifestBefore)
    const events = store.events.length
    assert.deepEqual(reconcileRecentCaptures({ store, inventory, recordings }), { imported: 0, failures: [] })
    assert.equal(store.events.length, events)
    const ignored = store.action(card.id, 'ignored', { revision: card.revision, commandId: 'ignore-synthetic-noise' })
    assert.equal(ignored.ok, true)
    const replayed = new SpokenWork(context.paths)
    assert.equal(replayed.bySource(`coach:${sessionId}`).rawTranscript.text, sourceText)
    assert.equal(replayed.bySource(`coach:${sessionId}`).audio.kept, true)
    assert.equal(replayed.list().items[0].sourceKey, 'coach:migrated-69')
    assert.equal(spokenWorkProgress(replayed.all()).ignored, 1)
    assert.equal(replayed.action(card.id, 'unreviewed', { revision: ignored.item.revision, commandId: 'restore-synthetic-noise' }).ok, true)
    assert.equal(replayed.list().items[0].id, card.id)
    assert.equal(replayed.all().length, 71)
  } finally { context.clean() }
})

test('recovery waits for a canonical baseline rather than silently migrating old sources', () => {
  const context = fixture()
  try {
    const store = new SpokenWork(context.paths)
    const preview = { id: 'sw_preview', sourceKey: 'coach:legacy', sessionId: 'legacy', capturedAt: 1_000,
      endedAt: 2_000, sourceType: 'solo_notes', rawTranscript: { text: 'Old note' }, sourceRefs: [], destinationRefs: [] }
    assert.deepEqual(reconcileRecentCaptures({ store, inventory: { items: [preview] }, recordings: {} }), { imported: 0, failures: [] })
    assert.equal(store.all().length, 0)
  } finally { context.clean() }
})

test('recovery records a keep failure and retries without discarding the captured card', () => {
  const context = fixture()
  try {
    const store = new SpokenWork(context.paths)
    store.ingest({ sourceKey: 'coach:migrated', capturedAt: 1_000, rawText: 'Old source', ingest: 'migration' }, { actor: 'migration' })
    const preview = { id: 'sw_recent', sourceKey: 'coach:recent', sessionId: 'recent', capturedAt: 2_000,
      endedAt: 3_000, sourceType: 'solo_notes', sourceRefs: [{ store: 'coach', id: 'recent' }],
      rawTranscript: { text: 'Keep this source', segments: [], complete: true, source: 'coach' },
      audio: { sessionId: 'recent', state: 'available', kept: false, expiresAt: 9_000 }, destinationRefs: [] }
    let canKeep = false
    const recordings = { setKeep: () => ({ ok: canKeep }), summary: () => ({ available: true, kept: canKeep }) }
    const first = reconcileRecentCaptures({ store, inventory: { items: [preview] }, recordings })
    assert.equal(first.imported, 1)
    assert.equal(first.failures.length, 1)
    assert.equal(store.bySource('coach:recent').audio.state, 'retention_error')
    assert.equal(store.bySource('coach:recent').rawTranscript.text, 'Keep this source')
    canKeep = true
    const second = reconcileRecentCaptures({ store, inventory: { items: [{ ...preview, audio: { sessionId: 'recent', state: 'available', kept: false, expiresAt: 9_000 } }] }, recordings })
    assert.deepEqual(second, { imported: 0, failures: [] })
    assert.equal(store.bySource('coach:recent').audio.state, 'available')
    assert.equal(store.bySource('coach:recent').audio.kept, true)
    assert.equal(store.all().length, 2)
  } finally { context.clean() }
})
