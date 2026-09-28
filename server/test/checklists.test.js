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

test('resetActiveTimers clears unfinished clocks but leaves finished work', () => {
  const checklists = new Checklists(
    {
      checklists: [
        {
          id: 'dishes',
          name: 'Dishes',
          space: 'life',
          kind: 'ondemand',
          items: [
            { id: 'load', label: 'Load', estimateMinutes: 7 },
            { id: 'wash', label: 'Wash', kind: 'wait', waitMinutes: 30 },
            { id: 'empty', label: 'Empty', estimateMinutes: 5 },
          ],
        },
      ],
    },
    { runsPath: null, logPath: null, summaryPath: null },
  )

  const started = checklists.start('dishes', 1_000)
  assert.equal(started.ok, true)
  const runId = started.run.runId
  assert.equal(checklists.beginStep(runId, 'load', 1_000).ok, true)
  assert.equal(checklists.check(runId, 'load', true, 2_000).ok, true)
  assert.equal(checklists.beginStep(runId, 'empty', 3_000).ok, true)

  const result = checklists.resetActiveTimers(4_000)

  assert.deepEqual(result, { ok: true, reset: 2 })
  const run = checklists.snapshot(4_000).active[0]
  assert.equal(run.items.find(item => item.id === 'load')?.done, true)
  assert.equal(run.items.find(item => item.id === 'load')?.durationMs, 1_000)
  assert.equal(run.items.find(item => item.id === 'wash')?.running, false)
  assert.equal(run.items.find(item => item.id === 'wash')?.endsAt, null)
  assert.equal(run.items.find(item => item.id === 'empty')?.running, false)
  assert.deepEqual(checklists.dueWaits(999_999), [])
})

test('beginStep on a checkbox-only list checks without starting a timer', () => {
  const checklists = new Checklists(
    {
      checklists: [
        {
          id: 'morning',
          name: 'Morning',
          space: 'life',
          kind: 'daily',
          timed: false,
          items: [
            { id: 'meds', label: 'Meds' },
            { id: 'teeth', label: 'Brush teeth' },
          ],
        },
      ],
    },
    { runsPath: null, logPath: null, summaryPath: null },
  )

  const run = checklists.snapshot(1_000).active[0]
  const result = checklists.beginStep(run.runId, 'meds', 2_000)

  assert.equal(result.ok, true)
  const item = checklists.snapshot(2_000).active[0].items.find(row => row.id === 'meds')
  assert.equal(item.done, true)
  assert.equal(item.running, false)
  assert.equal(item.startedAt, null)
})

test('checkbox-only legacy timings do not feed the read model or stats', () => {
  const checklists = new Checklists(
    {
      checklists: [
        {
          id: 'morning',
          name: 'Morning',
          space: 'life',
          kind: 'daily',
          timed: false,
          items: [{ id: 'meds', label: 'Meds' }],
        },
      ],
    },
    { runsPath: null, logPath: null, summaryPath: null },
  )

  const shapedRun = checklists.snapshot(1_000).active[0]
  const run = checklists.runs.get(shapedRun.runId)
  run.checked.meds = { at: 3_601_000, by: 'glasses' }
  run.timing.meds = {
    startedAt: 1_000,
    completedAt: 3_601_000,
    durationMs: 3_600_000,
    endsAt: null,
  }

  const item = checklists.snapshot(3_601_000).active[0].items[0]
  assert.equal(item.done, true)
  assert.equal(item.startedAt, null)
  assert.equal(item.durationMs, null)
  assert.equal(checklists.stats('morning').steps[0].samples, 0)
  assert.equal(checklists.stats('morning').plan[0].hasDuration, false)
})
