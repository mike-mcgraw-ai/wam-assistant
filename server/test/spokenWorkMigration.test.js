import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpokenWork } from '../src/spokenWork.js'
import { applySpokenMigration, assessSpokenRetirement, backupSpokenMigration, writeSpokenMigrationManifest } from '../src/spokenWorkMigration.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wam-migration-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir)
  const sessionId = 'walk-1'
  writeFileSync(join(dataDir, 'coach.json'), JSON.stringify({ sessions: [{ id: sessionId, modeId: 'notes',
    startedAt: 1000, endedAt: 2000, segments: [{ id: 'seg-1', at: 1100, text: 'Call the vet' }] }] }))
  writeFileSync(join(dataDir, 'tasks.json'), JSON.stringify({ notes: { 'captured-notes': [
    { id: 'walk-1:note', by: 'listen', text: 'Call the vet', at: 2000 },
  ] }, customTasks: [{ id: 'task-1', clientId: 'promote:walk-1:note', title: 'Call the vet' }] }))
  writeFileSync(join(dataDir, 'runs.json'), JSON.stringify({ dayStarts: { today: { day: '2026-10-16',
    draftCommits: [{ id: 'draft-1', sourceLinks: [{ itemId: 'item-1', taskId: 'task-1', sessionIds: [sessionId] }] }],
  } } }))
  writeFileSync(join(dataDir, 'assistant.json'), JSON.stringify({ threads: [] }))
  const recordingDir = join(dataDir, 'recordings', sessionId)
  mkdirSync(recordingDir, { recursive: true })
  writeFileSync(join(recordingDir, 'manifest.json'), JSON.stringify({ sessionId, sampleRate: 16000,
    channels: 1, createdAt: 1000, expiresAt: 3000, kept: false }))
  writeFileSync(join(recordingDir, 'audio.pcm'), Buffer.alloc(32000))
  writeFileSync(join(recordingDir, 'transcript.jsonl'), JSON.stringify({ id: 'seg-1', at: 1100, text: 'Call the vet' }) + '\n')
  return { root, dataDir, manifestPath: join(root, 'manifest.json'), backupDir: join(root, 'backup'),
    clean: () => rmSync(root, { recursive: true, force: true }) }
}

test('dry run, verified backup and batches preserve exact links and manually kept audio', () => {
  const context = fixture()
  try {
    const { dataDir, manifestPath, backupDir } = context
    const before = ['coach.json', 'tasks.json', 'runs.json', 'assistant.json']
      .map(file => readFileSync(join(dataDir, file), 'utf8'))
    const manifest = writeSpokenMigrationManifest(dataDir, manifestPath, 4000)
    assert.equal(manifest.entries.length, 1)
    assert.equal(manifest.entries[0].destinationRefs.length, 2)
    assert.equal(manifest.entries[0].audio.state, 'expiring')
    assert.equal(manifest.retention, 'manual-purge-only')
    assert.deepEqual(before, ['coach.json', 'tasks.json', 'runs.json', 'assistant.json']
      .map(file => readFileSync(join(dataDir, file), 'utf8')))
    backupSpokenMigration(dataDir, manifestPath, backupDir)
    let result = applySpokenMigration({ dataDir, manifestPath, backupDir, approveHash: manifest.id, batchSize: 1 })
    let interim = new SpokenWork({ logPath: join(dataDir, 'spoken-work.jsonl') }).bySource('coach:walk-1')
    assert.equal(interim.audio.state, 'retention_error')
    assert.equal(interim.destinationRefs.length, 0)
    for (let index = 1; index < 5; index++) {
      result = applySpokenMigration({ dataDir, manifestPath, backupDir, approveHash: manifest.id, batchSize: 1 })
    }
    assert.equal(result.checkpoint.stage, 'complete')
    assert.deepEqual(result.coverage.legacyOnly, [])
    const store = new SpokenWork({ logPath: join(dataDir, 'spoken-work.jsonl'), indexPath: join(dataDir, 'spoken-work.json') })
    const card = store.bySource('coach:walk-1')
    assert.equal(card.audio.kept, true)
    assert.equal(card.reviewState, 'reviewed')
    assert.equal(store.bySource('task-note:captured-notes:walk-1:note').id, card.id)
    assert.equal(card.destinationRefs.find(ref => ref.kind === 'task').id, 'task-1')
    assert.deepEqual(card.destinationRefs.find(ref => ref.kind === 'start_day').taskIds, ['task-1'])
    assert.equal(card.destinationRefs.find(ref => ref.kind === 'start_day').committed, true)
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'recordings', 'walk-1', 'manifest.json'))).expiresAt, null)
    const eventCount = store.events.length
    const rerun = applySpokenMigration({ dataDir, manifestPath, backupDir, approveHash: manifest.id })
    assert.equal(rerun.processed, 0)
    assert.equal(new SpokenWork({ logPath: join(dataDir, 'spoken-work.jsonl') }).events.length, eventCount)
    assert.deepEqual(before, ['coach.json', 'tasks.json', 'runs.json', 'assistant.json']
      .map(file => readFileSync(join(dataDir, file), 'utf8')))
  } finally { context.clean() }
})

test('migration links an existing human-edited card without replacing its correction', () => {
  const context = fixture()
  try {
    const { dataDir, manifestPath, backupDir } = context
    const store = new SpokenWork({ logPath: join(dataDir, 'spoken-work.jsonl'), indexPath: join(dataDir, 'spoken-work.json') })
    const source = store.ingest({ sourceKey: 'coach:walk-1', rawText: 'Call the bet' }).item
    assert.equal(store.update(source.id, { cleanedTranscript: 'Call the vet', title: 'Vet call' }, { revision: source.revision }).ok, true)
    const manifest = writeSpokenMigrationManifest(dataDir, manifestPath, 4000)
    backupSpokenMigration(dataDir, manifestPath, backupDir)
    applySpokenMigration({ dataDir, manifestPath, backupDir, approveHash: manifest.id })
    const restored = new SpokenWork({ logPath: join(dataDir, 'spoken-work.jsonl') })
    assert.equal(restored.all().length, 1)
    assert.equal(restored.bySource('coach:walk-1').title, 'Vet call')
    assert.equal(restored.bySource('coach:walk-1').cleanedTranscript, 'Call the vet')
    assert.equal(restored.bySource('coach:walk-1').destinationRefs.length, 2)
  } finally { context.clean() }
})

test('apply refuses missing backup, wrong approval, or changed legacy source', () => {
  const context = fixture()
  try {
    const { dataDir, manifestPath, backupDir } = context
    const manifest = writeSpokenMigrationManifest(dataDir, manifestPath, 4000)
    const options = { dataDir, manifestPath, backupDir, approveHash: manifest.id }
    assert.throws(() => applySpokenMigration(options), /backup-report/)
    backupSpokenMigration(dataDir, manifestPath, backupDir)
    assert.throws(() => applySpokenMigration({ ...options, approveHash: 'wrong' }), /approval required/)
    writeFileSync(join(dataDir, 'tasks.json'), JSON.stringify({ notes: {}, customTasks: [] }))
    assert.throws(() => applySpokenMigration(options), /legacy source changed/)
  } finally { context.clean() }
})

test('malformed source archives stop inventory instead of being silently skipped', () => {
  const context = fixture()
  try {
    writeFileSync(join(context.dataDir, 'recordings', 'walk-1', 'transcript.jsonl'), '{broken}\n')
    assert.throws(() => writeSpokenMigrationManifest(context.dataDir, context.manifestPath), /invalid source JSONL/)
  } finally { context.clean() }
})

test('retirement remains blocked until every no-loss gate is accepted', () => {
  assert.equal(assessSpokenRetirement({ coverage: { legacyOnly: ['coach:missing'] } }).ready, false)
  assert.equal(assessSpokenRetirement({ coverage: { legacyOnly: [] }, exceptionsReviewed: true,
    pathsValidated: true, migrationAccepted: true, retentionAccepted: true }).ready, true)
})
