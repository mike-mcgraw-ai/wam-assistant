import test from 'node:test'
import assert from 'node:assert/strict'

import { Tasks } from '../src/tasks.js'

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
