import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Tasks, linkedCompletionEvidence } from '../src/tasks.js'

test('a Listen note can be upgraded from raw speech to an AI summary', () => {
  const tasks = new Tasks(
    { tasks: [{ id: 'captured-notes', label: 'Captured notes', space: 'life' }] },
    { storePath: null, logPath: null },
  )
  tasks.addNote('captured-notes', 'Uh oh. Raw transcript pieces.', 'listen', 'session:note', 1)

  const result = tasks.updateNote(
    'captured-notes',
    'session:note',
    'Thread: Make Later relevant\nHold: Learn ice-machine frequency',
    'listen-ai',
    2,
  )

  assert.equal(result.ok, true)
  assert.deepEqual(tasks.notes('captured-notes')[0], {
    id: 'session:note',
    text: 'Thread: Make Later relevant\nHold: Learn ice-machine frequency',
    by: 'listen-ai',
    at: 1,
  })
})

test('a structured Solo Note summary is not cut at the old 400-character limit', () => {
  const tasks = new Tasks(
    { tasks: [{ id: 'captured-notes', label: 'Captured notes', space: 'life' }] },
    { storePath: null, logPath: null },
  )
  tasks.addNote('captured-notes', 'Raw transcript.', 'listen', 'long:note', 1)
  const summary = `Solo Note title\nRoadmap: ${'topic '.repeat(70)}\n${'Supported detail. '.repeat(30)}`

  const result = tasks.updateNote('captured-notes', 'long:note', summary, 'listen-ai', 2)

  assert.equal(result.ok, true)
  assert.ok(tasks.notes('captured-notes')[0].text.length > 400)
  assert.equal(tasks.notes('captured-notes')[0].text, summary.trim())
})

test('matchOpenTask finds a task a spoken clause names, and never guesses', async () => {
  const { matchOpenTask } = await import('../src/tasks.js')
  const open = [{ id: 'd', label: 'Call the dentist' }, { id: 'c', label: 'Car' }]
  assert.equal(matchOpenTask('call the dentist', open)?.id, 'd')
  assert.equal(matchOpenTask('Call the dentist about the crown', open)?.id, 'd')
  assert.equal(matchOpenTask('call dentist', open), null)
  assert.equal(matchOpenTask('wash the car today', open), null) // one-word labels need an exact match
  assert.equal(matchOpenTask('car', open)?.id, 'c')
})

test('doctor and vet completion dates need a linked note and reviewed confirmation', () => {
  const tasks = new Tasks({ tasks: [
    { id: 'doctor', label: 'Text my doctor', space: 'life' },
    { id: 'vet', label: 'Call the vet', space: 'life' },
  ] }, { storePath: null, logPath: null })
  const now = Date.UTC(2026, 9, 17, 16)
  const dayKeyOf = timestamp => new Date(timestamp).toISOString().slice(0, 10)
  tasks.addNote('vet', 'I called the vet on October 15.', 'listen', 'vet-voice', now)
  assert.equal(tasks.previewCompletionDate('vet', '2026-10-15', 'vet-voice', dayKeyOf, now).ok, false)
  tasks.complete('doctor', true, now)
  tasks.complete('vet', true, now)
  assert.equal(tasks.done.get('vet').completedOn, undefined)
  assert.equal(tasks.previewCompletionDate('vet', '2026-10-15', 'missing', dayKeyOf, now).ok, false)
  assert.equal(tasks.previewCompletionDate('vet', '2026-10-18', 'vet-voice', dayKeyOf, now).ok, false)
  assert.equal(tasks.previewCompletionDate('vet', '2026-02-30', 'vet-voice', dayKeyOf, now).ok, false)
  const preview = tasks.previewCompletionDate('vet', '2026-10-15', 'vet-voice', dayKeyOf, now)
  assert.equal(preview.ok, true)
  assert.equal(preview.note.text, 'I called the vet on October 15.')
  assert.equal(tasks.correctCompletionDate('vet', '2026-10-15', 'vet-voice', 'wrong-key', dayKeyOf, now).ok, false)
  assert.equal(tasks.correctCompletionDate('vet', '2026-10-15', 'vet-voice', preview.reviewKey, dayKeyOf, now).ok, true)
  assert.equal(tasks.done.get('vet').completedOn, '2026-10-15')
  assert.equal(tasks.done.get('doctor').completedOn, undefined)
  assert.equal(tasks.done.get('vet').doneAt, now)
  tasks.complete('vet', true, now + 1000)
  assert.equal(tasks.done.get('vet').completedOn, '2026-10-15')
  tasks.complete('vet', false, now + 2000)
  assert.equal(tasks.done.has('vet'), false)
})

test('reviewed Solo Note evidence can correct a persisted completion, but stale words cannot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-completion-'))
  const storePath = join(directory, 'tasks.json')
  const config = { tasks: [{ id: 'vet', label: 'Call the vet', space: 'life' }] }
  const now = Date.UTC(2026, 9, 17, 16)
  const dayKeyOf = timestamp => new Date(timestamp).toISOString().slice(0, 10)
  try {
    const tasks = new Tasks(config, { storePath, logPath: null })
    tasks.complete('vet', true, now)
    const evidence = { id: 'spoken:solo-vet', text: 'I called the vet on October 15.', by: 'spoken-review' }
    const preview = tasks.previewCompletionDate('vet', '2026-10-15', evidence.id, dayKeyOf, now, evidence)
    assert.equal(preview.ok, true)
    assert.equal(tasks.correctCompletionDate('vet', '2026-10-15', evidence.id, preview.reviewKey, dayKeyOf, now,
      { ...evidence, text: 'Different reviewed words' }).ok, false)
    assert.equal(tasks.correctCompletionDate('vet', '2026-10-15', evidence.id, preview.reviewKey, dayKeyOf, now, evidence).ok, true)
    const restored = new Tasks(config, { storePath, logPath: null })
    assert.equal(restored.done.get('vet').completedOn, '2026-10-15')
    assert.equal(restored.completed()[0].doneAt, now)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('only reviewed voice cards linked to the task are date evidence', () => {
  const cards = [
    { id: 'pending', reviewState: 'unreviewed', cleanedTranscript: 'Vet done yesterday', destinationRefs: [{ kind: 'task', id: 'vet' }] },
    { id: 'other', reviewState: 'reviewed', cleanedTranscript: 'Doctor done yesterday', destinationRefs: [{ kind: 'task', id: 'doctor' }] },
    { id: 'linked', reviewState: 'reviewed', cleanedTranscript: 'Vet done October 15', destinationRefs: [{ kind: 'task', id: 'vet' }] },
  ]
  assert.deepEqual(linkedCompletionEvidence(cards, 'vet'), [
    { id: 'spoken:linked', text: 'Vet done October 15', by: 'spoken-review' },
  ])
})
