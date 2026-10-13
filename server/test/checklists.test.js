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

test('Start Day matches spoken aliases, starts those chores, and records what was committed', () => {
  const checklists = new Checklists(
    {
      resetHour: 5,
      dayStartHour: 6,
      checklists: [
        { id: 'laundry', name: 'Laundry', aliases: ['wash clothes'], space: 'life', kind: 'ondemand', items: [] },
        { id: 'dishes', name: 'Dishes', aliases: ['dishwasher'], space: 'life', kind: 'ondemand', items: [] },
        { id: 'vacuum', name: 'Vacuum', aliases: ['floors'], space: 'life', kind: 'ondemand', items: [] },
      ],
    },
    { runsPath: null, logPath: null, summaryPath: null },
  )
  const at = Date.UTC(2026, 9, 11, 14)

  const result = checklists.startDay('Today I need to wash clothes, load the dishwasher, and clean the floors.', 'life', at)

  assert.equal(result.ok, true)
  assert.deepEqual(result.checklistIds, ['laundry', 'dishes', 'vacuum'])
  assert.equal(result.runIds.length, 3)
  assert.deepEqual(result.unmatched, [])
  assert.deepEqual(
    checklists.snapshot(at).active.map(run => run.checklistId).sort(),
    ['dishes', 'laundry', 'vacuum'],
  )
  assert.deepEqual(checklists.dayStatus('life', at), {
    day: result.day,
    startHour: 6,
    started: true,
    skipped: false,
    skippedAt: null,
    startedAt: at,
    checklistIds: ['laundry', 'dishes', 'vacuum'],
    transcript: 'Today I need to wash clothes, load the dishwasher, and clean the floors.',
  })
  assert.deepEqual(checklists.commitments(), [{ day: result.day, space: 'life', runIds: result.runIds, taskIds: [] }])
})

test('Start Day with no saved list named still starts the day and hands back the clauses as tasks', () => {
  const checklists = new Checklists(
    {
      checklists: [
        { id: 'laundry', name: 'Laundry', aliases: ['wash clothes'], space: 'life', kind: 'ondemand', items: [] },
      ],
    },
    { runsPath: null, logPath: null, summaryPath: null },
  )

  const result = checklists.startDay('I should answer some email.', 'life', 1_000)

  assert.equal(result.ok, true)
  assert.deepEqual(result.unmatched, ['Answer some email'])
  assert.equal(checklists.dayStatus('life', 1_000).started, true)
  assert.deepEqual(checklists.snapshot(1_000).active, [])
})

test('Start Day from a named step commits only that step onward', () => {
  const checklists = new Checklists(
    {
      checklists: [{
        id: 'laundry', name: 'Laundry', space: 'life', kind: 'ondemand',
        items: [{ id: 'load', label: 'Load washer' }, { id: 'hang', label: 'Hang' }, { id: 'fold', label: 'Fold' }],
      }],
    },
    { runsPath: null, logPath: null, summaryPath: null },
  )
  const result = checklists.startDay('laundry from hang', 'life', 1_000)
  assert.equal(result.matched[0].fromStep, 'Hang')
  const run = checklists.runs.get(result.runIds[0])
  assert.equal(run.startIndex, 1)
})

test('a walk later in the day adds to the commitments instead of replacing them', () => {
  const checklists = new Checklists(
    {
      checklists: [
        { id: 'laundry', name: 'Laundry', space: 'life', kind: 'ondemand', items: [] },
        { id: 'dishes', name: 'Dishes', space: 'life', kind: 'ondemand', items: [] },
      ],
    },
    { runsPath: null, logPath: null, summaryPath: null },
  )
  const morning = checklists.startDay('laundry', 'life', 1_000)
  checklists.commitTasks('life', ['call-dentist'], 2_000)
  const midday = checklists.startDay('dishes', 'life', 3_000)
  assert.equal(midday.runIds.length, 2)
  assert.ok(midday.runIds.includes(morning.runIds[0]))
  assert.deepEqual(checklists.commitments()[0].taskIds, ['call-dentist'])
  assert.equal(checklists.dayStatus('life', 3_000).startedAt, 1_000)
})

test('overnight: a committed list stays on the list, an uncommitted one closes', () => {
  const checklists = new Checklists(
    {
      resetHour: 5,
      summaryHour: 6,
      timezone: 'UTC',
      checklists: [
        { id: 'laundry', name: 'Laundry', space: 'life', kind: 'ondemand', items: [{ id: 'a', label: 'A' }] },
        { id: 'dishes', name: 'Dishes', space: 'life', kind: 'ondemand', items: [{ id: 'b', label: 'B' }] },
      ],
    },
    { runsPath: null, logPath: null, summaryPath: null },
  )
  const day1 = Date.UTC(2026, 9, 12, 14)
  checklists.startDay('laundry', 'life', day1)
  checklists.start('dishes', day1) // started by hand, never committed
  checklists.maybeRollup(Date.UTC(2026, 9, 13, 7))
  const open = checklists.snapshot(Date.UTC(2026, 9, 13, 7)).active.map(r => r.checklistId)
  assert.deepEqual(open, ['laundry'])
})

test('skip for now is remembered and is not a start', () => {
  const checklists = new Checklists(
    { checklists: [] },
    { runsPath: null, logPath: null, summaryPath: null },
  )
  checklists.skipDay('life', 1_000)
  const status = checklists.dayStatus('life', 1_000)
  assert.equal(status.skipped, true)
  assert.equal(status.started, false)
})
