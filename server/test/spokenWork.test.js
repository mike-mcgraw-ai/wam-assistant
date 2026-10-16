import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SpokenWork } from '../src/spokenWork.js'
import { compareSpokenCoverage, legacySpokenInventory } from '../src/spokenWorkImport.js'
import { applySpokenModelResult, scheduleSpokenExtraction } from '../src/spokenWorkExtraction.js'
import { linkExistingSpokenTask, materializeSpokenWork, previewSpokenTaskUpdate, promoteSpokenResource, promoteSpokenTask, updateSpokenTask } from '../src/spokenWorkReview.js'
import { Tasks } from '../src/tasks.js'
import { Checklists } from '../src/checklists.js'

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

test('conflicting source aliases and command IDs never join separate cards', () => {
  const { dir, clean } = fixture()
  try {
    const store = new SpokenWork({ logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') })
    const first = store.ingest({ sourceKey: 'coach:first', rawText: 'Replace the hallway bulb' }, { commandId: 'first-command' }).item
    const second = store.ingest({ sourceKey: 'coach:second', rawText: 'Sketch an energy dashboard' }).item
    assert.equal(store.ingest({ sourceKey: 'coach:second', sourceAliases: ['coach:first'] }).code, 409)
    assert.equal(store.ingest({ sourceKey: 'coach:second' }, { commandId: 'first-command' }).code, 409)
    assert.equal(store.bySource('coach:first').id, first.id)
    assert.equal(store.bySource('coach:second').id, second.id)
    assert.equal(store.all().length, 2)
  } finally { clean() }
})

test('legacy preview uses archived whole-recording words and keeps chunk evidence', () => {
  const { dir, clean } = fixture()
  try {
    const recordingDir = join(dir, 'recordings', 's-full')
    mkdirSync(recordingDir, { recursive: true })
    writeFileSync(join(recordingDir, 'manifest.json'), JSON.stringify({ sessionId: 's-full', createdAt: 1_000, endedAt: 2_000, sampleRate: 16_000, channels: 1 }))
    writeFileSync(join(recordingDir, 'audio.pcm'), Buffer.alloc(160_000))
    writeFileSync(join(recordingDir, 'transcript.jsonl'), JSON.stringify({ id: 'chunk-1', at: 1_200, speaker: 'me', text: 'Clean the cap.' }) + '\n')
    writeFileSync(join(recordingDir, 'full-transcript.json'), JSON.stringify({ text: 'Clean the counters.' }))
    const item = legacySpokenInventory(dir, 3_000).items[0]
    assert.equal(item.rawTranscript.text, 'Clean the counters.')
    assert.equal(item.rawTranscript.segments[0].text, 'Clean the cap.')
    assert.equal(item.rawTranscript.source, 'full-recording')
    assert.equal(item.title, 'Clean the counters.')
    assert.equal(item.summary, 'Clean the counters.')
    assert.equal(item.clarificationQuestions.length, 0)
    assert.equal(item.audio.state, 'available')
  } finally { clean() }
})

test('review imports only on edit, preserving source words and corrections across restart', () => {
  const { dir, clean } = fixture()
  try {
    const paths = { logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') }
    const preview = { id: 'sw_preview-1', sourceKey: 'coach:s-1', sourceAliases: [], sourceType: 'solo_notes',
      sourceRefs: [{ store: 'coach', id: 's-1' }], sessionId: 's-1', modeId: 'notes', space: 'life',
      capturedAt: 1_000, endedAt: 2_000, revision: 1, title: 'Clean the counters', summary: 'Clean the counters',
      classification: 'unknown', reviewState: 'needs_clarification', clarificationQuestions: ['Which counters?'],
      rawTranscript: { text: 'Clean the cap', segments: [{ id: 'chunk-1', at: 1_100, text: 'Clean the cap' }], complete: false, source: 'coach' },
      cleanedTranscript: 'Clean the cap', audio: { sessionId: 's-1', state: 'missing', kept: false, expiresAt: null }, destinationRefs: [] }
    const store = new SpokenWork(paths)
    assert.equal(store.all().length, 0)
    const imported = materializeSpokenWork(store, preview)
    assert.equal(imported.item.id, preview.id)
    assert.equal(imported.item.reviewState, 'needs_clarification')
    const edited = store.update(preview.id, { cleanedTranscript: 'Clean the counters', title: 'Clean the counters' }, { revision: 1, commandId: 'correct-1' })
    assert.equal(edited.ok, true)
    assert.equal(edited.item.rawTranscript.text, 'Clean the cap')
    assert.equal(store.update(preview.id, { title: 'Wrong' }, { revision: 1, commandId: 'correct-2' }).code, 409)
    const restored = new SpokenWork(paths)
    assert.equal(restored.get(preview.id).cleanedTranscript, 'Clean the counters')
    assert.equal(restored.get(preview.id).rawTranscript.text, 'Clean the cap')
    assert.equal(restored.history(preview.id).length, 2)
  } finally { clean() }
})

test('task promotion retry after a partial failure creates one Home task', () => {
  const { dir, clean } = fixture()
  try {
    const paths = { logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') }
    let store = new SpokenWork(paths)
    let tasks = new Tasks({ tasks: [] }, { storePath: join(dir, 'tasks.json'), logPath: join(dir, 'tasks.jsonl') })
    let checklists = new Checklists({ checklists: [], timezone: 'America/New_York' }, {
      runsPath: join(dir, 'runs.json'), logPath: join(dir, 'runs.jsonl'), summaryPath: join(dir, 'summaries'),
    })
    const ingested = store.ingest({ sourceKey: 'coach:s-2', sourceType: 'solo_notes', rawText: 'Call the vet',
      rawSegments: [{ id: 'chunk-1', at: 1_000, text: 'Call the bet' }], transcriptSource: 'full-recording' })
    assert.equal(ingested.item.rawTranscript.text, 'Call the vet')
    let fail = true
    const interruptible = { commitTasks(...args) { if (fail) return { ok: false, error: 'interrupted' }; return checklists.commitTasks(...args) } }
    const first = promoteSpokenTask({ store, tasks, checklists: interruptible, itemId: ingested.item.id, revision: 1, commandId: 'promote-1' })
    assert.equal(first.ok, false)
    assert.equal(tasks.customTasks.length, 1)
    store = new SpokenWork(paths)
    tasks = new Tasks({ tasks: [] }, { storePath: join(dir, 'tasks.json'), logPath: join(dir, 'tasks.jsonl') })
    checklists = new Checklists({ checklists: [], timezone: 'America/New_York' }, {
      runsPath: join(dir, 'runs.json'), logPath: join(dir, 'runs.jsonl'), summaryPath: join(dir, 'summaries'),
    })
    fail = false
    const retried = promoteSpokenTask({ store, tasks, checklists: interruptible, itemId: ingested.item.id, revision: 1, commandId: 'promote-1' })
    assert.equal(retried.ok, true)
    assert.equal(tasks.customTasks.length, 1)
    assert.equal(tasks.notes_.get(retried.taskId).length, 1)
    assert.equal(store.get(ingested.item.id).destinationRefs.length, 1)
    assert.equal(promoteSpokenTask({ store, tasks, checklists, itemId: ingested.item.id, revision: 1, commandId: 'promote-1' }).duplicate, true)
  } finally { clean() }
})

test('an imported promotion stays linked and never creates another Home task', () => {
  const { dir, clean } = fixture()
  try {
    const store = new SpokenWork({ logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') })
    const imported = materializeSpokenWork(store, {
      id: 'sw_existing', sourceKey: 'coach:s-old', sourceAliases: [], sourceType: 'solo_notes',
      sourceRefs: [{ store: 'coach', id: 's-old' }], rawTranscript: { text: 'Finish laundry', segments: [], complete: true, source: 'coach' },
      title: 'Finish laundry', summary: 'Finish laundry', reviewState: 'reviewed', classification: 'task',
      destinationRefs: [{ kind: 'task', id: 'finish-laundry', createdAt: null, syncRevision: 1 }],
    })
    const tasks = new Tasks({ tasks: [] }, { storePath: null, logPath: null })
    const result = promoteSpokenTask({ store, tasks, checklists: { commitTasks: () => assert.fail('must not commit again') },
      itemId: imported.item.id, revision: 1, commandId: 'duplicate-promotion' })
    assert.equal(result.duplicate, true)
    assert.equal(result.taskId, 'finish-laundry')
    assert.equal(tasks.customTasks.length, 0)
  } finally { clean() }
})

test('explicitly linking an existing Home task adds source context but no duplicate task', () => {
  const { dir, clean } = fixture()
  try {
    const paths = { logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') }
    let store = new SpokenWork(paths)
    let tasks = new Tasks({ tasks: [] }, { storePath: join(dir, 'tasks.json'), logPath: join(dir, 'tasks.jsonl') })
    const existing = tasks.addTask({ label: 'Call the vet', space: 'life', clientId: 'existing-vet' }).task
    const item = store.ingest({ sourceKey: 'coach:s-vet', rawText: 'Call the vet about the appointment' }).item
    const linked = linkExistingSpokenTask({ store, tasks, itemId: item.id, taskId: existing.id, revision: 1, commandId: 'link-vet' })
    assert.equal(linked.ok, true)
    assert.equal(tasks.customTasks.length, 1)
    assert.match(tasks.notes_.get(existing.id)[0].text, /Review source: \/review\?item=/)
    store = new SpokenWork(paths)
    tasks = new Tasks({ tasks: [] }, { storePath: join(dir, 'tasks.json'), logPath: join(dir, 'tasks.jsonl') })
    assert.equal(linkExistingSpokenTask({ store, tasks, itemId: item.id, taskId: existing.id, revision: 1, commandId: 'link-vet' }).duplicate, true)
    assert.equal(tasks.customTasks.length, 1)
    assert.equal(tasks.notes_.get(existing.id).length, 1)
  } finally { clean() }
})

test('split saves parent and children as one replayable event without duplicating chunks', () => {
  const { dir, clean } = fixture()
  try {
    const paths = { logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') }
    const store = new SpokenWork(paths)
    const original = store.ingest({ sourceKey: 'coach:s-mixed', sourceType: 'solo_notes', rawText: 'Call the vet. Clean the counters.',
      transcriptSource: 'full-recording', rawSegments: [
        { id: 'vet', at: 1_000, text: 'Call the bet.' },
        { id: 'counter', at: 2_000, text: 'Clean the cap.' },
      ] }).item
    const parts = [{ segmentIds: ['vet'], title: 'Call the vet', cleanedTranscript: 'Call the vet' },
      { segmentIds: ['counter'], title: 'Clean the counters', cleanedTranscript: 'Clean the counters' }]
    assert.equal(store.split(original.id, [{ segmentIds: ['vet'] }, { segmentIds: ['vet'] }], { revision: 1, commandId: 'bad-split' }).code, 400)
    assert.equal(store.get(original.id).reviewState, 'unreviewed')
    const split = store.split(original.id, parts, { revision: 1, commandId: 'split-1' })
    assert.equal(split.ok, true)
    assert.equal(split.children.length, 2)
    assert.equal(split.children[0].reviewState, 'needs_clarification')
    assert.equal(split.children[0].rawTranscript.text, 'Call the bet.')
    assert.equal(split.children[0].cleanedTranscript, 'Call the vet')
    assert.equal(readFileSync(paths.logPath, 'utf8').trim().split('\n').length, 2)
    assert.deepEqual(store.split(original.id, parts, { revision: 1, commandId: 'split-1' }).children.map(row => row.id), split.children.map(row => row.id))
    const replayed = new SpokenWork(paths)
    assert.deepEqual(replayed.get(original.id).childIds, split.children.map(row => row.id))
    assert.equal(replayed.history(split.children[0].id).at(-1).type, 'split')
    assert.equal(replayed.all().length, 3)
  } finally { clean() }
})

test('merge is one replayable event and later source updates do not replace the target transcript', () => {
  const { dir, clean } = fixture()
  try {
    const paths = { logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') }
    const store = new SpokenWork(paths)
    const target = store.ingest({ sourceKey: 'coach:s-target', rawText: 'Call the vet', sourceRefs: [{ store: 'coach', id: 's-target' }] }).item
    const source = store.ingest({ sourceKey: 'coach:s-source', rawText: 'Ask about the dog', sourceRefs: [{ store: 'coach', id: 's-source' }] }).item
    assert.equal(store.merge(target.id, source.id, { revision: 1, sourceRevision: 2, commandId: 'stale-merge' }).code, 409)
    const merged = store.merge(target.id, source.id, { revision: 1, sourceRevision: 1, commandId: 'merge-1' })
    assert.equal(merged.ok, true)
    assert.equal(store.get(source.id).mergedInto, target.id)
    assert.equal(store.bySource(source.sourceKey).id, source.id)
    assert.equal(store.get(target.id).sourceRefs.length, 2)
    assert.deepEqual(store.get(target.id).mergedSourceIds, [source.id])
    assert.deepEqual(store.get(target.id).mergedSourceKeys, [source.sourceKey])
    assert.equal(readFileSync(paths.logPath, 'utf8').trim().split('\n').length, 3)
    const replayed = new SpokenWork(paths)
    assert.equal(replayed.get(source.id).reviewState, 'merged')
    assert.equal(replayed.get(target.id).rawTranscript.text, 'Call the vet')
    assert.equal(replayed.merge(target.id, source.id, { revision: 1, sourceRevision: 1, commandId: 'merge-1' }).duplicate, true)
    replayed.ingest({ sourceKey: source.sourceKey, rawText: 'Ask about the dog again' })
    assert.equal(replayed.get(source.id).reviewState, 'merged')
    assert.equal(replayed.get(target.id).rawTranscript.text, 'Call the vet')
  } finally { clean() }
})

test('a partial journal tail does not consume the next complete event', () => {
  const { dir, clean } = fixture()
  try {
    const paths = { logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') }
    writeFileSync(paths.logPath, '{"id":"interrupted"')
    const store = new SpokenWork(paths)
    const item = store.ingest({ sourceKey: 'coach:s-after-crash', rawText: 'Replace the hallway bulb' }).item
    const replayed = new SpokenWork(paths)
    assert.equal(replayed.bySource('coach:s-after-crash').id, item.id)
    assert.equal(replayed.all().length, 1)
  } finally { clean() }
})

test('read-only coverage compares exact source keys and excludes split children', () => {
  const inventory = { items: [{ sourceKey: 'coach:one' }, { sourceKey: 'coach:two' }] }
  const coverage = compareSpokenCoverage(inventory, [
    { sourceKey: 'coach:one', parentId: null },
    { sourceKey: 'coach:three', parentId: null },
    { sourceKey: 'coach:one:part:1', parentId: 'sw_parent' },
  ])
  assert.deepEqual(coverage, { legacyCards: 2, canonicalCards: 2, derivedCards: 1,
    matchedSources: 1, legacyOnly: ['coach:two'], canonicalOnly: ['coach:three'] })
})

test('project and idea promotions persist source-backed resources without creating tasks', () => {
  const { dir, clean } = fixture()
  try {
    const paths = { logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') }
    const store = new SpokenWork(paths)
    const source = store.ingest({ sourceKey: 'coach:plan', rawText: 'Sketch an energy dashboard',
      sourceRefs: [{ store: 'coach', id: 'plan' }] }).item
    const edited = store.update(source.id, { title: 'Energy dashboard', summary: 'Track energy use',
      candidates: [{ id: 'step-1', kind: 'task', title: 'List available sensors', detail: 'Check the meter' }],
      clarificationQuestions: ['Which data source?'] }, { revision: source.revision, commandId: 'edit-plan' }).item
    const project = promoteSpokenResource({ store, itemId: source.id, kind: 'project', revision: edited.revision, commandId: 'project-1' })
    assert.equal(project.ok, true)
    assert.equal(project.resource.steps.length, 1)
    assert.deepEqual(project.resource.openQuestions, ['Which data source?'])
    assert.equal(project.resource.sourceRefs[0].id, 'plan')
    assert.equal(promoteSpokenResource({ store, itemId: source.id, kind: 'project', revision: edited.revision, commandId: 'project-1' }).duplicate, true)
    const idea = promoteSpokenResource({ store, itemId: source.id, kind: 'idea', revision: project.item.revision, commandId: 'idea-1' })
    assert.equal(idea.resource.possibleNextStep.id, 'step-1')
    const replayed = new SpokenWork(paths)
    assert.equal(replayed.allResources().length, 2)
    assert.equal(replayed.resource('project:' + source.id).reviewUrl, `/review?item=${source.id}`)
    assert.equal(replayed.get(source.id).destinationRefs.length, 2)
    const plan = store.ingest({ sourceKey: 'coach:plan-voice', rawText: 'Plan the dashboard',
      sourceRefs: [{ store: 'tasks', id: 'build-plan-task' }] }).item
    const projectFromPlan = store.promoteResource(plan.id, 'project', { revision: plan.revision, commandId: 'project-plan' })
    assert.deepEqual(projectFromPlan.resource.relatedTaskIds, ['build-plan-task'])
    assert.deepEqual(projectFromPlan.resource.steps, [])
  } finally { clean() }
})

test('memory promotion verifies kept audio and never invents missing audio', () => {
  const { dir, clean } = fixture()
  try {
    const store = new SpokenWork({ logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') })
    const spoken = store.ingest({ sourceKey: 'coach:moment', rawText: 'A small good moment',
      audio: { sessionId: 'moment', state: 'available', kept: false } }).item
    const failed = promoteSpokenResource({ store, recordings: { setKeep: () => ({ ok: false }), summary: () => ({ available: true, kept: false }) },
      itemId: spoken.id, kind: 'memory', revision: spoken.revision, commandId: 'memory-fail' })
    assert.equal(failed.code, 409)
    assert.equal(store.allResources().length, 0)
    const saved = promoteSpokenResource({ store, recordings: { setKeep: () => ({ ok: true }),
      summary: () => ({ available: true, kept: true }) },
    itemId: spoken.id, kind: 'memory', revision: spoken.revision, commandId: 'memory-save' })
    assert.equal(saved.ok, true)
    assert.equal(saved.item.audio.kept, true)
    assert.equal(saved.resource.audioSessionId, 'moment')
    const expired = store.ingest({ sourceKey: 'coach:expired-moment', rawText: 'A remembered walk',
      audio: { sessionId: 'expired-moment', state: 'available', kept: false } }).item
    const expiredMemory = promoteSpokenResource({ store, recordings: { summary: () => null }, itemId: expired.id,
      kind: 'memory', revision: expired.revision, commandId: 'memory-expired' })
    assert.equal(expiredMemory.resource.audioState, 'expired')
    assert.equal(expiredMemory.resource.audioSessionId, null)
    const textOnly = store.ingest({ sourceKey: 'legacy-note:moment', rawText: 'A remembered walk' }).item
    const transcriptMemory = promoteSpokenResource({ store, itemId: textOnly.id, kind: 'memory',
      revision: textOnly.revision, commandId: 'memory-text' })
    assert.equal(transcriptMemory.resource.audioSessionId, null)
    assert.equal(transcriptMemory.resource.audioState, 'missing')
  } finally { clean() }
})

test('only approved rules bypass the model and never promote work', () => {
  const { dir, clean } = fixture()
  try {
    const store = new SpokenWork({ logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') })
    const item = store.ingest({ sourceKey: 'coach:rule', rawText: 'Replace the hallway bulb' }).item
    const rulesPath = join(dir, 'rules.json')
    writeFileSync(rulesPath, JSON.stringify({ rules: [
      { id: 'unapproved', approved: false, pattern: 'hallway', classification: 'idea', title: 'Wrong' },
      { id: 'bulb', approved: true, pattern: 'Replace the (hallway bulb)', classification: 'task',
        destination: 'task', title: 'Replace the $1' },
    ] }))
    const jobs = { create: () => { throw new Error('approved rule must avoid model job') } }
    const result = scheduleSpokenExtraction({ store, jobs, itemId: item.id, rulesPath })
    assert.equal(result.ok, true)
    assert.equal(result.item.title, 'Replace the hallway bulb')
    assert.equal(result.item.classification, 'task')
    assert.equal(result.item.suggestedDestination, 'task')
    assert.equal(result.item.destinationRefs.length, 0)
    assert.equal(result.item.provenance.extractor, 'approved-rule')
    const changed = store.ingest({ sourceKey: 'coach:rule', rawText: 'Sketch an energy dashboard' })
    assert.equal(changed.item.extraction.state, 'stale')
    const fallbackJobs = { create: input => ({ ok: true, job: { id: 'fallback-job', status: 'queued', input: input.input } }) }
    const queued = scheduleSpokenExtraction({ store, jobs: fallbackJobs, itemId: item.id, rulesPath })
    assert.equal(queued.item.extraction.jobId, 'fallback-job')
    const fallback = applySpokenModelResult(store, { id: 'fallback-job', capability: 'spoken.extract', input: {
      itemId: item.id, transcriptRevision: 2, rawText: 'Sketch an energy dashboard', cleanedTranscript: 'Sketch an energy dashboard', segments: [],
    } }, { classification: 'idea', confidence: { score: 0.8, reasons: ['new intent'] } })
    assert.equal(fallback.ok, true)
    assert.equal(fallback.item.classification, 'idea')
  } finally { clean() }
})

test('model proposal preserves human edits and rejects a stale transcript', () => {
  const { dir, clean } = fixture()
  try {
    const store = new SpokenWork({ logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') })
    const item = store.ingest({ sourceKey: 'coach:model', rawText: 'Sketch an energy dashboard' }).item
    const jobs = { create: input => ({ ok: true, job: { id: 'model-job', status: 'queued', input } }) }
    const queued = scheduleSpokenExtraction({ store, jobs, itemId: item.id, rulesPath: join(dir, 'missing.json') })
    assert.equal(queued.item.extraction.state, 'processing')
    const edited = store.update(item.id, { title: 'My energy display' },
      { revision: queued.item.revision, commandId: 'human-title' })
    const job = { id: 'model-job', capability: 'spoken.extract', input: { itemId: item.id, transcriptRevision: 1,
      rawText: 'Sketch an energy dashboard', cleanedTranscript: 'Sketch an energy dashboard', segments: [] } }
    store.markExtraction(item.id, 'processing', { jobId: 'newer-model-job' })
    assert.equal(applySpokenModelResult(store, job, { title: 'Old model title' }).error, 'proposal request was superseded')
    const newerJob = { ...job, id: 'newer-model-job' }
    const applied = applySpokenModelResult(store, newerJob, { title: 'Model title', classification: 'idea',
      candidates: [{ kind: 'task', title: 'Unsupported', evidenceText: 'not said' },
        { kind: 'idea', title: 'Energy dashboard', evidenceText: 'energy dashboard' }],
      clarificationQuestions: [], confidence: { score: 0.8, reasons: ['spoken request'] } })
    assert.equal(applied.ok, true)
    assert.equal(applied.item.title, 'My energy display')
    assert.equal(applied.item.classification, 'idea')
    assert.deepEqual(applied.item.candidates.map(candidate => candidate.title), ['Energy dashboard'])
    assert.equal(applied.item.destinationRefs.length, 0)
    const corrected = store.update(item.id, { cleanedTranscript: 'Sketch a household energy dashboard' },
      { revision: applied.item.revision, commandId: 'human-transcript' })
    assert.equal(corrected.item.extraction.state, 'stale')
    assert.equal(applySpokenModelResult(store, newerJob, { title: 'Old interpretation' }).code, 409)
    const updated = store.ingest({ sourceKey: 'coach:model', rawText: 'Sketch a home energy dashboard' })
    assert.equal(updated.item.extraction.state, 'stale')
    assert.equal(applySpokenModelResult(store, newerJob, { title: 'Old title' }).code, 409)
    assert.equal(store.get(item.id).title, 'My energy display')
  } finally { clean() }
})

test('Start Day keeps each source session linked to reused draft items and confirmed tasks', () => {
  const { dir, clean } = fixture()
  try {
    const checklists = new Checklists({ checklists: [] }, { runsPath: join(dir, 'runs.json'), logPath: join(dir, 'runs.jsonl') })
    const firstDraft = checklists.draftDay('Replace the hallway bulb', 'life', 'walk-one', 1_000)
    const secondDraft = checklists.draftDay('Replace the hallway bulb', 'life', 'walk-two', 2_000)
    const itemId = firstDraft.sourceItemIds[0]
    assert.deepEqual(secondDraft.sourceItemIds, [itemId])
    assert.deepEqual(secondDraft.draft.items[0].sourceSessionIds, ['walk-one', 'walk-two'])
    const paths = { logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') }
    const store = new SpokenWork(paths)
    const first = store.ingest({ sourceKey: 'coach:walk-one', rawText: 'Replace the hallway bulb',
      destinationRefs: [{ kind: 'start_day', id: firstDraft.draft.id, itemIds: [itemId] }] }).item
    const second = store.ingest({ sourceKey: 'coach:walk-two', rawText: 'Replace the hallway bulb',
      destinationRefs: [{ kind: 'start_day', id: firstDraft.draft.id, itemIds: [itemId] }] }).item
    store.ingest({ sourceKey: 'coach:walk-one', destinationRefs: [{ kind: 'start_day', id: firstDraft.draft.id,
      itemIds: [itemId, 'later-detail'] }] })
    assert.deepEqual(store.get(first.id).destinationRefs[0].itemIds, [itemId, 'later-detail'])
    const sourceLinks = [{ itemId, sessionIds: ['walk-one', 'walk-two'], taskId: 'task-hallway' }]
    const committed = checklists.commitDayDraft('life', 3_000, ['task-hallway'], sourceLinks)
    assert.equal(committed.ok, true)
    assert.deepEqual(committed.sourceLinks, sourceLinks)
    const restoredChecklists = new Checklists({ checklists: [] }, { runsPath: join(dir, 'runs.json'), logPath: join(dir, 'runs.jsonl') })
    assert.deepEqual([...restoredChecklists.dayStarts.values()][0].draftCommits[0].sourceLinks, sourceLinks)
    assert.equal(store.linkStartDayCommit(committed.draftId, sourceLinks).linked, 2)
    assert.equal(store.linkStartDayCommit(committed.draftId, sourceLinks).linked, 0)
    const replayed = new SpokenWork(paths)
    for (const id of [first.id, second.id]) {
      assert.deepEqual(replayed.get(id).destinationRefs[0].taskIds, ['task-hallway'])
      assert.equal(replayed.get(id).destinationRefs[0].committed, true)
    }
  } finally { clean() }
})

test('linked destination updates require a preview and a separate confirmed command', () => {
  const { dir, clean } = fixture()
  try {
    const paths = { logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') }
    const store = new SpokenWork(paths)
    const item = store.ingest({ sourceKey: 'coach:idea-update', rawText: 'Sketch an energy dashboard' }).item
    const promoted = store.promoteResource(item.id, 'idea', { revision: item.revision, commandId: 'save-idea' })
    const edited = store.update(item.id, { title: 'Home energy dashboard', summary: 'Compare weekly use' },
      { revision: promoted.item.revision, commandId: 'edit-idea' })
    const preview = store.previewResourceUpdate(item.id, 'idea')
    assert.equal(preview.changes.title.after, 'Home energy dashboard')
    assert.equal(preview.resource.title, 'Sketch an energy dashboard')
    assert.equal(store.updateResource(item.id, 'idea', { revision: promoted.item.revision, commandId: 'stale-update' }).code, 409)
    const synced = store.updateResource(item.id, 'idea', { revision: edited.item.revision, commandId: 'update-idea' })
    assert.equal(synced.resource.title, 'Home energy dashboard')
    assert.equal(synced.item.destinationRefs[0].syncRevision, synced.item.revision)
    assert.equal(store.updateResource(item.id, 'idea', { revision: edited.item.revision, commandId: 'update-idea' }).duplicate, true)
    assert.equal(new SpokenWork(paths).resource(`idea:${item.id}`).rationale, 'Compare weekly use')
  } finally { clean() }
})

test('task update preview adds one source note and does not rename an existing task', () => {
  const { dir, clean } = fixture()
  try {
    const store = new SpokenWork({ logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') })
    const tasks = new Tasks({ tasks: [] }, { storePath: join(dir, 'tasks.json'), logPath: join(dir, 'tasks.jsonl') })
    const task = tasks.addTask({ label: 'Call the vet', space: 'life', clientId: 'vet-update' }).task
    const item = store.ingest({ sourceKey: 'coach:vet-update', rawText: 'Call about the dog' }).item
    const linked = linkExistingSpokenTask({ store, tasks, itemId: item.id, taskId: task.id, revision: 1, commandId: 'link-update' })
    const edited = store.update(item.id, { cleanedTranscript: 'Call the vet about the dog' },
      { revision: linked.item.revision, commandId: 'correct-update' })
    const preview = previewSpokenTaskUpdate({ store, tasks, itemId: item.id })
    assert.match(preview.proposedNote, /dog/)
    assert.equal(tasks.taskDefs().find(row => row.id === task.id).label, 'Call the vet')
    const synced = updateSpokenTask({ store, tasks, itemId: item.id, revision: edited.item.revision, commandId: 'sync-task' })
    assert.equal(synced.ok, true)
    assert.equal(updateSpokenTask({ store, tasks, itemId: item.id, revision: edited.item.revision, commandId: 'sync-task' }).duplicate, true)
    assert.equal(tasks.notes_.get(task.id).length, 2)
  } finally { clean() }
})

test('voice amendment applies atomically once and preserves original evidence after replay', () => {
  const { dir, clean } = fixture()
  try {
    const paths = { logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') }
    const store = new SpokenWork(paths)
    const parent = store.ingest({ sourceKey: 'coach:original', rawText: 'Clean the cap', complete: true }).item
    const amendment = store.ingest({ sourceKey: 'coach:amendment', sourceType: 'amendment',
      rawText: 'Clean the kitchen', complete: true, parentId: parent.id,
      amendmentKind: 'correction', amendmentBaseRevision: parent.revision,
      amendmentOriginal: parent.cleanedTranscript,
      sourceRefs: [{ store: 'coach', id: 'amendment' }] }).item
    assert.equal(store.get(parent.id).cleanedTranscript, 'Clean the cap')
    const applied = store.applyAmendment(amendment.id, { revision: amendment.revision, commandId: 'apply-once' })
    assert.equal(applied.ok, true)
    assert.equal(store.applyAmendment(amendment.id, { revision: amendment.revision, commandId: 'apply-once' }).duplicate, true)
    assert.equal(store.get(parent.id).rawTranscript.text, 'Clean the cap')
    assert.equal(store.get(parent.id).cleanedTranscript, 'Clean the kitchen')
    assert.equal(store.get(parent.id).title, 'Clean the kitchen')
    assert.equal(store.get(parent.id).reviewState, 'unreviewed')
    assert.equal(store.get(amendment.id).reviewState, 'reviewed')
    const detail = store.ingest({ sourceKey: 'coach:detail', sourceType: 'amendment',
      rawText: 'And the', complete: false, parentId: parent.id, amendmentKind: 'detail',
      amendmentBaseRevision: store.get(parent.id).revision, amendmentOriginal: 'Clean the kitchen' }).item
    assert.equal(store.applyAmendment(detail.id, { revision: detail.revision, commandId: 'premature' }).code, 409)
    const reviewedDetail = store.update(detail.id, { cleanedTranscript: 'Also wipe the counter' },
      { revision: detail.revision, commandId: 'phone-corrected' }).item
    assert.equal(store.applyAmendment(detail.id, { revision: reviewedDetail.revision, commandId: 'apply-detail' }).ok, true)
    assert.equal(store.get(parent.id).cleanedTranscript, 'Clean the kitchen\nAlso wipe the counter')
    const replayed = new SpokenWork(paths)
    assert.equal(replayed.get(parent.id).cleanedTranscript, 'Clean the kitchen\nAlso wipe the counter')
    assert.equal(replayed.get(parent.id).childIds[0], amendment.id)
    assert.equal(replayed.history(parent.id).at(-1).type, 'amendment_applied')
  } finally { clean() }
})

test('uncertain or stale voice amendments never overwrite corrected words', () => {
  const { dir, clean } = fixture()
  try {
    const store = new SpokenWork({ logPath: join(dir, 'spoken-work.jsonl'), indexPath: join(dir, 'spoken-work.json') })
    const parent = store.ingest({ sourceKey: 'coach:base', rawText: 'Clean the cap', complete: true }).item
    const uncertain = store.ingest({ sourceKey: 'coach:uncertain-amend', sourceType: 'amendment',
      rawText: 'Clean the wheel room', complete: true, parentId: parent.id,
      amendmentKind: 'correction', amendmentBaseRevision: parent.revision }).item
    assert.equal(store.applyAmendment(uncertain.id, { revision: 1, commandId: 'unsafe' }).code, 409)
    const edited = store.update(parent.id, { cleanedTranscript: 'Clean the kitchen' }, { revision: 1, commandId: 'edit-base' })
    const clear = store.ingest({ sourceKey: 'coach:clear-amend', sourceType: 'amendment',
      rawText: 'Clean the hallway', complete: true, parentId: parent.id,
      amendmentKind: 'detail', amendmentBaseRevision: parent.revision }).item
    assert.equal(store.applyAmendment(clear.id, { revision: 1, commandId: 'stale' }).code, 409)
    assert.equal(store.get(parent.id).revision, edited.item.revision)
    assert.equal(store.get(parent.id).cleanedTranscript, 'Clean the kitchen')
  } finally { clean() }
})
