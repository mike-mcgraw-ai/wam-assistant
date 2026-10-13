import test from 'node:test'
import assert from 'node:assert/strict'

import { remainingPlanSteps } from '../src/planRows.js'

test('a completed partial routine does not rebuild omitted or finished steps', () => {
  const plan = [
    { id: 'clear', label: 'Clear floors' },
    { id: 'run', label: 'Vacuum' },
    { id: 'empty', label: 'Empty canister' },
  ]
  const completedTail = {
    complete: true,
    startIndex: 1,
    items: [
      { id: 'run', done: true },
      { id: 'empty', done: true },
    ],
  }

  assert.deepEqual(remainingPlanSteps(plan, completedTail), [])
})

test('a partial routine keeps only its unfinished included steps', () => {
  const plan = [
    { id: 'clear', label: 'Clear floors' },
    { id: 'run', label: 'Vacuum' },
    { id: 'empty', label: 'Empty canister' },
  ]
  const activeTail = {
    complete: false,
    startIndex: 1,
    items: [
      { id: 'run', done: true },
      { id: 'empty', done: false },
    ],
  }

  assert.deepEqual(remainingPlanSteps(plan, activeTail), [{ id: 'empty', label: 'Empty canister' }])
})
