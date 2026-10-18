import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Checklists } from '../src/checklists.js'

test('a dated item pause hides current work without erasing the prior day', () => {
  const checklists = new Checklists(
    {
      timezone: 'America/New_York',
      resetHour: 5,
      checklists: [{
        id: 'morning', name: 'Morning', space: 'life', kind: 'daily', timed: false,
        items: [
          { id: 'stretch', label: 'Stretch', pausedFrom: '2026-10-18' },
          { id: 'teeth', label: 'Brush teeth' },
        ],
      }],
    },
    { runsPath: null, logPath: null, summaryPath: null },
  )

  const saturday = checklists.snapshot(Date.parse('2026-10-17T12:00:00-04:00')).active
    .find(run => run.day === '2026-10-17')
  const sunday = checklists.snapshot(Date.parse('2026-10-18T12:00:00-04:00')).active
    .find(run => run.day === '2026-10-18')

  assert.deepEqual(saturday.items.map(item => item.id), ['stretch', 'teeth'])
  assert.deepEqual(sunday.items.map(item => item.id), ['teeth'])
  assert.equal(sunday.total, 1)
})

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
            { id: 'stretch', label: 'Stretch' },
            { id: 'teeth', label: 'Brush teeth' },
          ],
        },
      ],
    },
    { runsPath: null, logPath: null, summaryPath: null },
  )

  const run = checklists.snapshot(1_000).active[0]
  const result = checklists.beginStep(run.runId, 'stretch', 2_000)

  assert.equal(result.ok, true)
  const item = checklists.snapshot(2_000).active[0].items.find(row => row.id === 'stretch')
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
          items: [{ id: 'stretch', label: 'Stretch' }],
        },
      ],
    },
    { runsPath: null, logPath: null, summaryPath: null },
  )

  const shapedRun = checklists.snapshot(1_000).active[0]
  const run = checklists.runs.get(shapedRun.runId)
  run.checked.stretch = { at: 3_601_000, by: 'glasses' }
  run.timing.stretch = {
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
    runIds: result.runIds,
    taskIds: [],
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

test('Start Day ignores fragments without guessing a correction', () => {
  const checklists = new Checklists(
    { checklists: [] },
    { runsPath: null, logPath: null, summaryPath: null },
  )

  const result = checklists.startDay(
    'my doctor called the vet. text my doctor and call the bet. V-E-T VET veterinarian.',
    'life',
    1_000,
  )

  assert.equal(result.ok, true)
  assert.deepEqual(result.unmatched, ['Text my doctor', 'Call the bet'])
})

test('unclear spoken fragments remain visible in the proposal but do not commit by default', () => {
  const checklists = new Checklists({ checklists: [] }, { runsPath: null, logPath: null, summaryPath: null })
  const result = checklists.draftDay('Doctor appointment. Text my doctor.', 'life', 'first', 1000)
  assert.deepEqual(result.draft.items.map(item => [item.label, item.include]), [
    ['Text my doctor', true], ['Doctor appointment', false],
  ])
  assert.deepEqual(checklists.commitDayDraft('life', 2000).tasks.map(item => item.label), ['Text my doctor'])
})

test('spoken errands become Start Day tasks without an action word (Mike, 2026-10-17)', () => {
  const checklists = new Checklists({ checklists: [] }, { runsPath: null, logPath: null, summaryPath: null })
  // The exact walk that lost the milk: a quantity and a store, no verb.
  const milk = checklists.draftDay('Two gallons of milk from the store.', 'life', 'milk', 1000)
  assert.deepEqual(milk.draft.items.map(item => [item.label, item.include]), [
    ['Get two gallons of milk from the store', true],
  ])
  assert.deepEqual(checklists.commitDayDraft('life', 2000).tasks.map(item => item.label), ['Get two gallons of milk from the store'])

  const variants = new Checklists({ checklists: [] }, { runsPath: null, logPath: null, summaryPath: null })
  const more = variants.draftDay('2 dozen eggs. A loaf of bread at the market. Get bananas. Grab coffee filters.', 'life', 'more', 1000)
  assert.deepEqual(more.draft.items.map(item => [item.label, item.include]), [
    ['Get 2 dozen eggs', true],
    ['Get a loaf of bread at the market', true],
    ['Get bananas', true],
    ['Grab coffee filters', true],
  ])
})

test('a spoken shopping list stays one errand; real actions still split', () => {
  const checklists = new Checklists({ checklists: [] }, { runsPath: null, logPath: null, summaryPath: null })
  const result = checklists.draftDay('Milk and eggs from the store. Text my doctor and get bread from the store.', 'life', 'list', 1000)
  assert.deepEqual(result.draft.items.map(item => [item.label, item.include]), [
    ['Get milk and eggs from the store', true],
    ['Text my doctor', true],
    ['Get bread from the store', true],
  ])
})

test('the errand rule does not turn every noun phrase into a task', () => {
  const checklists = new Checklists({ checklists: [] }, { runsPath: null, logPath: null, summaryPath: null })
  const result = checklists.draftDay('Doctor appointment. Two of them were broken. Back from the store already.', 'life', 'plain', 1000)
  assert.deepEqual(result.draft.items.map(item => [item.label, item.include]), [
    ['Doctor appointment', false],
    ['Two of them were broken', false],
    ['Back from the store already', false],
  ])
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
  const status = checklists.dayStatus('life', 3_000)
  assert.equal(status.startedAt, 1_000)
  assert.deepEqual(status.taskIds, ['call-dentist'])
})

test('reviewed Start Day tasks can replace stale commitments', () => {
  const checklists = new Checklists(
    { checklists: [] },
    { runsPath: null, logPath: null, summaryPath: null },
  )
  checklists.startDay('Call the bet', 'life', 1_000)
  checklists.commitTasks('life', ['call-the-bet', 'correction-fragment'], 2_000)

  const result = checklists.setCommittedTasks('life', ['call-the-vet'], 3_000)

  assert.deepEqual(result, { ok: true, taskIds: ['call-the-vet'] })
  assert.deepEqual(checklists.dayStatus('life', 3_000).taskIds, ['call-the-vet'])
})

test('Start Day draft changes nothing until reviewed, then commits only kept rows', () => {
  const checklists = new Checklists(
    {
      checklists: [{
        id: 'laundry', name: 'Laundry', space: 'life', kind: 'ondemand',
        items: [{ id: 'load', label: 'Load washer' }],
      }],
    },
    { runsPath: null, logPath: null, summaryPath: null },
  )

  const staged = checklists.draftDay('Do laundry and call the vet.', 'life', 'session-1', 1_000)
  assert.equal(staged.ok, true)
  assert.equal(checklists.dayStatus('life', 1_000).started, false)
  assert.deepEqual(checklists.snapshot(1_000).active, [])
  assert.deepEqual(staged.draft.items.map(item => item.label), ['Laundry', 'Call the vet'])

  checklists.setDayDraftItem('life', 'checklist:laundry', false, 2_000)
  const prepared = checklists.prepareDayDraft('life', 3_000)
  assert.deepEqual(prepared.tasks.map(item => item.label), ['Call the vet'])
  assert.ok(checklists.dayStatus('life', 3_000).draft)
  const committed = checklists.commitDayDraft('life', 3_000, ['vet-task'])
  assert.equal(committed.ok, true)
  assert.deepEqual(committed.checklistIds, [])
  assert.deepEqual(committed.tasks.map(item => item.label), ['Call the vet'])
  assert.deepEqual(committed.taskIds, ['vet-task'])
  assert.equal(checklists.dayStatus('life', 3_000).draft, undefined)
})

test('Start Day draft recognizes apply and trims spoken task-building instructions', () => {
  const checklists = new Checklists(
    { checklists: [] },
    { runsPath: null, logPath: null, summaryPath: null },
  )
  const result = checklists.draftDay(
    'Apply for three jobs make make that a task when I go into it it has three separate jobs.',
    'life',
    'session-2',
    1_000,
  )
  assert.deepEqual(result.draft.items.map(item => item.label), ['Apply for three jobs'])
})

test('later Start Day recordings merge into review instead of replacing it', () => {
  const checklists = new Checklists(
    {
      checklists: [{ id: 'dishes', name: 'Dishes', space: 'life', kind: 'ondemand', items: [] }],
    },
    { runsPath: null, logPath: null, summaryPath: null },
  )
  checklists.draftDay('Call the vet.', 'life', 'first', 1_000)
  const later = checklists.draftDay('Dishes and call the vet.', 'life', 'second', 2_000)

  assert.equal(later.draft.id, 'first')
  assert.deepEqual(later.draft.items.map(item => item.label), ['Call the vet', 'Dishes'])
  assert.match(later.draft.transcript, /Call the vet\.\nDishes and call the vet\./)
  assert.equal(checklists.dayStatus('life', 2_000).started, false)
})

test('October draft survives restart, keeps later work, and supports explicit row correction', () => {
  const directory = mkdtempSync(join(tmpdir(), 'day-draft-'))
  const runsPath = join(directory, 'runs.json')
  const config = {
    timezone: 'UTC', resetHour: 0,
    checklists: [{ id: 'dishes', name: 'Dishes', space: 'life', kind: 'ondemand', items: [{ id: 'load', label: 'Load dishwasher' }] }],
  }
  const firstDay = Date.UTC(2026, 9, 14, 12)
  try {
    let checklists = new Checklists(config, { runsPath, logPath: null, summaryPath: null })
    checklists.draftDay('Text my doctor and call the bet. V-E-T VET veterinarian.', 'life', 'doctor', firstDay)
    checklists = new Checklists(config, { runsPath, logPath: null, summaryPath: null })
    const later = checklists.draftDay('Dishes and apply for three jobs and clean the cap and clean the wheel room.', 'life', 'later', firstDay + 1000)
    assert.deepEqual(later.draft.items.map(item => item.label), [
      'Text my doctor', 'Call the bet', 'V-E-T VET veterinarian', 'Dishes', 'Apply for three jobs', 'Clean the cap', 'Clean the wheel room',
    ])
    assert.equal(later.draft.items[2].include, false)
    const vet = later.draft.items.find(item => item.label === 'Call the bet')
    assert.equal(checklists.reviseDayDraftItem('life', vet.id, { label: 'Call the vet', note: 'Vet appointment' }, firstDay + 2000).ok, true)
    const kitchen = later.draft.items.find(item => item.label === 'Clean the cap')
    const living = later.draft.items.find(item => item.label === 'Clean the wheel room')
    checklists.reviseDayDraftItem('life', kitchen.id, { label: 'Clean the kitchen' }, firstDay + 2000)
    checklists.reviseDayDraftItem('life', living.id, { label: 'Clean the living room' }, firstDay + 2000)
    const committed = checklists.commitDayDraft('life', firstDay + 3000)
    assert.deepEqual(committed.tasks.map(item => item.label), [
      'Text my doctor', 'Call the vet', 'Apply for three jobs', 'Clean the kitchen', 'Clean the living room',
    ])
    assert.equal(committed.tasks.find(item => item.label === 'Call the vet').note, 'Vet appointment')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('repeat aliases and one-off names do not double a preset unless deliberately kept', () => {
  const checklists = new Checklists({
    checklists: [{ id: 'vacuum', name: 'Vacuum', aliases: ['floors'], space: 'life', kind: 'ondemand', items: [{ id: 'clear', label: 'Clear floors' }] }],
  }, { runsPath: null, logPath: null, summaryPath: null })
  const result = checklists.draftDay('Vacuum and clean floors and vacuum.', 'life', 'first', 1000)
  assert.deepEqual(result.draft.items.map(item => item.label), ['Vacuum'])
  const later = checklists.draftDay('Vacuum the living room.', 'life', 'second', 2000)
  assert.deepEqual(later.draft.items.map(item => item.label), ['Vacuum'])
  const conflicted = checklists.draftDay('Vacuum.', 'life', 'third', 3000, ['Vacuum living room'])
  assert.equal(conflicted.draft.items[0].include, false)
  assert.equal(conflicted.draft.items[0].conflict, 'Vacuum living room')
  assert.deepEqual(checklists.commitDayDraft('life', 4000).checklistIds, [])
  checklists.draftDay('Vacuum.', 'life', 'fourth', 5000, ['Vacuum living room'])
  checklists.setDayDraftItem('life', 'checklist:vacuum', true, 6000)
  assert.deepEqual(checklists.commitDayDraft('life', 7000).checklistIds, ['vacuum'])
})

test('minor article differences in repeated task labels merge before commit', () => {
  const checklists = new Checklists({ checklists: [] }, { runsPath: null, logPath: null, summaryPath: null })
  checklists.draftDay('Clean kitchen.', 'life', 'first', 1000)
  const later = checklists.draftDay('Clean the kitchen.', 'life', 'second', 2000)
  assert.deepEqual(later.draft.items.map(item => item.label), ['Clean kitchen'])
  assert.deepEqual(checklists.commitDayDraft('life', 3000).tasks.map(item => item.label), ['Clean kitchen'])
})

test('reparse one row preserves other draft work and exposes its source', () => {
  const checklists = new Checklists({ checklists: [] }, { runsPath: null, logPath: null, summaryPath: null })
  const result = checklists.draftDay('Clean the cap and apply for three jobs.', 'life', 'first', 1000)
  const row = result.draft.items[0]
  assert.match(row.source, /Clean the cap/)
  checklists.reviseDayDraftItem('life', row.id, { label: 'Clean the kitchen' }, 2000)
  const reparsed = checklists.reparseDayDraftItem('life', row.id, 3000)
  assert.equal(reparsed.draft.items[0].label, 'Clean the cap')
  assert.equal(reparsed.draft.items[1].label, 'Apply for three jobs')
})

test('a spoken label correction can turn a one-off into a named preset step', () => {
  const checklists = new Checklists({ checklists: [{
    id: 'laundry', name: 'Laundry', space: 'life', kind: 'ondemand',
    items: [{ id: 'load', label: 'Load washer' }, { id: 'hang', label: 'Hang' }],
  }] }, { runsPath: null, logPath: null, summaryPath: null })
  const drafted = checklists.draftDay('Clean the wheel room.', 'life', 'first', 1000)
  const row = drafted.draft.items[0]
  const revised = checklists.reviseDayDraftItem('life', row.id, { label: 'Laundry from hang' }, 2000)
  assert.equal(revised.draft.items[0].kind, 'checklist')
  assert.equal(revised.draft.items[0].fromStep, 'Hang')
  assert.deepEqual(checklists.commitDayDraft('life', 3000).checklistIds, ['laundry'])
})

test('rebuild and next-day draft keep unresolved task identities', () => {
  const checklists = new Checklists({ timezone: 'UTC', resetHour: 0, checklists: [
    { id: 'dishes', name: 'Dishes', space: 'life', kind: 'ondemand', items: [{ id: 'load', label: 'Load dishwasher' }] },
  ] }, { runsPath: null, logPath: null, summaryPath: null })
  const firstDay = Date.UTC(2026, 9, 14, 12)
  checklists.draftDay('Text my doctor and call the vet.', 'life', 'first', firstDay)
  checklists.commitDayDraft('life', firstDay + 1000)
  checklists.commitTasks('life', ['doctor', 'vet'], firstDay + 2000)
  checklists.draftDay('Clean the kitchen.', 'life', 'second', firstDay + 3000)
  checklists.discardDayDraft('life', firstDay + 4000)
  assert.deepEqual(checklists.committedTaskIds('life'), ['doctor', 'vet'])
  const nextDay = firstDay + 86400_000
  checklists.draftDay('Dishes.', 'life', 'third', nextDay)
  assert.deepEqual(checklists.committedTaskIds('life'), ['doctor', 'vet'])
  assert.deepEqual(checklists.dayStatus('life', nextDay).draft.items.map(item => item.label), ['Dishes'])
})

test('a removed preset cannot silently disappear during confirmation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'day-draft-missing-'))
  const runsPath = join(directory, 'runs.json')
  try {
    const withPreset = new Checklists({ checklists: [
      { id: 'dishes', name: 'Dishes', space: 'life', kind: 'ondemand', items: [{ id: 'load', label: 'Load' }] },
    ] }, { runsPath, logPath: null, summaryPath: null })
    withPreset.draftDay('Dishes.', 'life', 'first', 1000)
    const withoutPreset = new Checklists({ checklists: [] }, { runsPath, logPath: null, summaryPath: null })
    assert.match(withoutPreset.prepareDayDraft('life', 2000).error, /no longer exists/)
    assert.equal(withoutPreset.dayStatus('life', 2000).draft.items[0].label, 'Dishes')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('committed task ids carry across days without duplicating identities', () => {
  const checklists = new Checklists(
    { timezone: 'UTC', resetHour: 0, checklists: [] },
    { runsPath: null, logPath: null, summaryPath: null },
  )
  checklists.startDay('Call the vet', 'life', Date.UTC(2026, 9, 13, 12))
  checklists.commitTasks('life', ['call-the-vet'], Date.UTC(2026, 9, 13, 12))
  checklists.startDay('Text my doctor', 'life', Date.UTC(2026, 9, 14, 12))
  checklists.commitTasks('life', ['call-the-vet', 'text-my-doctor'], Date.UTC(2026, 9, 14, 12))
  assert.deepEqual(checklists.committedTaskIds('life'), ['call-the-vet', 'text-my-doctor'])
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

test('cancelRun takes back an untouched run but never one with progress', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wam-cancel-'))
  try {
    const checklists = new Checklists(
      { checklists: [{ id: 'vacuum', name: 'Vacuum', space: 'life', kind: 'ondemand',
        items: [{ id: 'clear', label: 'Clear floors' }, { id: 'run', label: 'Vacuum' }] }] },
      { runsPath: join(dir, 'runs.json'), logPath: join(dir, 'log.jsonl'), summaryPath: join(dir, 'summaries') },
    )
    const first = checklists.start('vacuum').run
    assert.equal(checklists.cancelRun(first.runId).ok, true)
    assert.equal(checklists.snapshot().active.length, 0)

    const second = checklists.start('vacuum').run
    checklists.check(second.runId, 'clear', true)
    assert.equal(checklists.cancelRun(second.runId).ok, false)
    assert.equal(checklists.snapshot().active.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('starting a routine whose every step is ticked starts a fresh run', () => {
  const checklists = new Checklists(
    { checklists: [{ id: 'vacuum', name: 'Vacuum', space: 'life', kind: 'ondemand',
      items: [{ id: 'clear', label: 'Clear floors' }, { id: 'run', label: 'Vacuum' }] }] },
    { runsPath: null, logPath: null, summaryPath: null },
  )
  const first = checklists.start('vacuum').run
  checklists.check(first.runId, 'clear', true)
  assert.equal(checklists.start('vacuum').existing, true)
  checklists.check(first.runId, 'run', true)
  const again = checklists.start('vacuum')
  assert.equal(again.existing, undefined)
  assert.notEqual(again.run.runId, first.runId)
})
