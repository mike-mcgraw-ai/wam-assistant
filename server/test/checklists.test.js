import test from 'node:test'
import assert from 'node:assert/strict'

import { Checklists } from '../src/checklists.js'

test('a Listen note on a chore can be upgraded to an AI summary', () => {
  const checklists = new Checklists(
    {
      checklists: [{ id: 'dishes', name: 'Dishes', space: 'life', kind: 'on-demand', items: [] }],
    },
    { runsPath: null, logPath: null, summaryPath: null },
  )
  checklists.addNote('dishes', 'Raw transcript.', 'listen', 'session:note', 1)

  const result = checklists.updateNote(
    'dishes',
    'session:note',
    'Thread: Empty the dishwasher first',
    'listen-ai',
    2,
  )

  assert.equal(result.ok, true)
  assert.deepEqual(checklists.notes('dishes')[0], {
    id: 'session:note',
    text: 'Thread: Empty the dishwasher first',
    by: 'listen-ai',
    at: 1,
  })
})
