import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addDays, computeGame, GameAnnouncer, levelFor, weekday } from '../src/game.js'

const templates = new Map([
  ['morning', { id: 'morning', kind: 'daily', items: [{ id: 'stretch' }, { id: 'teeth' }] }],
  ['rounds', { id: 'rounds', kind: 'daily', items: [{ id: 'boiler' }] }],
  ['dishes', { id: 'dishes', kind: 'ondemand', items: [{ id: 'load' }, { id: 'run' }] }],
])
const config = {
  startDay: '2026-10-12', // a Monday
  levels: { base: 100, growth: 50 },
  defaults: { stepXP: 10, completeBonus: 25, missPenalty: 0, penaltyDays: [] },
  checklists: {
    morning: { stepXP: 10, completeBonus: 30, missPenalty: 10, penaltyDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
    rounds: { stepXP: 5, completeBonus: 20, missPenalty: 5, penaltyDays: ['mon', 'tue', 'wed', 'thu', 'fri'] },
  },
  streak: { milestones: [2, 3] },
  pings: { levelUp: true, streakMilestone: true },
}
const run = (checklistId, day, items) => ({
  runId: `${checklistId}-${day}`,
  checklistId,
  day,
  checked: Object.fromEntries(items.map(id => [id, { at: 0 }])),
})
const full = day => [run('morning', day, ['stretch', 'teeth']), run('rounds', day, ['boiler'])]

test('calendar helpers work on day keys', () => {
  assert.equal(weekday('2026-10-12'), 'mon')
  assert.equal(weekday('2026-10-18'), 'sun')
  assert.equal(addDays('2026-10-31', 1), '2026-11-01')
})

test('level curve: 100, then each level costs 50 more', () => {
  assert.equal(levelFor(0).level, 1)
  assert.equal(levelFor(99).level, 1)
  assert.equal(levelFor(100).level, 2)
  assert.equal(levelFor(250).level, 3)
  assert.deepEqual(levelFor(260), { level: 3, floor: 250, size: 200, into: 10, toNext: 190 })
})

test('steps earn XP, a complete list earns its bonus', () => {
  const g = computeGame({
    runs: [run('dishes', '2026-10-10', ['load', 'run']), run('morning', '2026-10-10', ['stretch'])],
    templates, config, today: '2026-10-10',
  })
  // dishes: 2x10 + 25 bonus; morning: 1x10, incomplete so no bonus
  assert.equal(g.xp, 55)
  assert.equal(g.todayEarned, 55)
})

test('items no longer on the list do not earn', () => {
  const g = computeGame({ runs: [run('dishes', '2026-10-10', ['gone'])], templates, config, today: '2026-10-10' })
  assert.equal(g.xp, 0)
})

test('a dated item pause preserves old XP and stops future misses', () => {
  const pausedTemplates = new Map([[
    'morning',
    { id: 'morning', kind: 'daily', items: [{ id: 'stretch', pausedFrom: '2026-10-18' }, { id: 'teeth' }] },
  ]])
  const pausedConfig = {
    ...config,
    startDay: '2026-10-17',
    checklists: { morning: config.checklists.morning },
  }
  const g = computeGame({
    runs: [
      run('morning', '2026-10-17', ['stretch', 'teeth']),
      run('morning', '2026-10-18', ['teeth']),
    ],
    templates: pausedTemplates,
    config: pausedConfig,
    today: '2026-10-19',
  })

  assert.equal(g.xp, 90) // Saturday 2 steps + bonus; Sunday teeth + bonus.
  assert.equal(g.streak, 2)
  assert.equal(g.days.flatMap(day => day.entries).some(entry => entry.kind === 'miss'), false)
})

test('penalties: only finished days, only from startDay, only on due weekdays', () => {
  const g = computeGame({
    runs: [...full('2026-10-09'), ...full('2026-10-10'), ...full('2026-10-11')], // before startDay
    templates, config, today: '2026-10-14', // Mon 12 and Tue 13 finished and empty; Wed 14 in progress
  })
  const byDay = Object.fromEntries(g.days.map(d => [d.day, d.penalty]))
  assert.equal(byDay['2026-10-12'], -25) // 2 morning x10 + 1 rounds x5
  assert.equal(byDay['2026-10-13'], -25)
  assert.equal(byDay['2026-10-14'], undefined) // today: never penalised yet
  assert.equal(byDay['2026-10-11'], 0) // before startDay
})

test('weekend: rounds not due, so not penalised', () => {
  const sat = { ...config, startDay: '2026-10-17' }
  const g = computeGame({ runs: [], templates, config: sat, today: '2026-10-18' })
  const day = g.days.find(d => d.day === '2026-10-17')
  assert.equal(day.penalty, -20) // morning only
})

test('total is floored at zero rather than going into debt', () => {
  const g = computeGame({ runs: [], templates, config, today: '2026-10-20' })
  assert.equal(g.xp, 0)
  assert.equal(g.level, 1)
  // and earning afterwards moves it up from zero at once
  const h = computeGame({ runs: full('2026-10-20'), templates, config, today: '2026-10-20' })
  assert.equal(h.todayEarned, 10 * 2 + 30 + 5 + 20)
  assert.equal(h.xp, 75)
})

test('streak counts complete days; a weekend with only morning due still needs morning', () => {
  const runs = [...full('2026-10-12'), ...full('2026-10-13'), ...full('2026-10-14')]
  const g = computeGame({ runs, templates, config, today: '2026-10-15' }) // 15 not complete yet
  assert.equal(g.streak, 3)
  const done = computeGame({ runs: [...runs, ...full('2026-10-15')], templates, config, today: '2026-10-15' })
  assert.equal(done.streak, 4) // today counts once complete
  const broken = computeGame({ runs: [...full('2026-10-12'), ...full('2026-10-14')], templates, config, today: '2026-10-15' })
  assert.equal(broken.streak, 1)
  assert.equal(broken.bestStreak, 1)
})

test('announcer: silent first run, pings level-ups and milestones once, never a loss', async () => {
  const sent = []
  const notifier = { send: async (_t, text) => sent.push(text) }
  const statePath = join(mkdtempSync(join(tmpdir(), 'game-')), 'game-state.json')
  const a = new GameAnnouncer({ statePath, notifier, config })

  assert.deepEqual(await a.observe({ level: 3, xp: 300, toNext: 150, streak: 2 }), [])
  assert.deepEqual(await a.observe({ level: 3, xp: 310, toNext: 140, streak: 2 }), [])
  const up = await a.observe({ level: 4, xp: 460, toNext: 240, streak: 3 })
  assert.equal(up.length, 2)
  assert.match(up[0], /^Level 4 reached/)
  assert.match(up[1], /^3-day streak/)
  assert.deepEqual(await a.observe({ level: 3, xp: 440, toNext: 10, streak: 0 }), []) // lost: no ping
  assert.match((await a.observe({ level: 4, xp: 455, toNext: 245, streak: 0 }))[0], /^Level 4/) // regained
  // Survives a restart without re-announcing.
  const b = new GameAnnouncer({ statePath, notifier, config })
  assert.deepEqual(await b.observe({ level: 4, xp: 456, toNext: 244, streak: 0 }), [])
  assert.equal(sent.length, 3)
})

// ---- commitments ------------------------------------------------------------
const dayAt = (day, hour = 12) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00Z`)
const utcDay = ts => new Date(ts).toISOString().slice(0, 10)
const laundryT = new Map([
  ['laundry', { id: 'laundry', kind: 'ondemand', items: [{ id: 'load' }, { id: 'hang' }, { id: 'fold' }] }],
  ['rounds', { id: 'rounds', kind: 'daily', items: [{ id: 'boiler' }] }],
])
const cfg = { ...config, startDay: '2026-10-14', commitments: { stepPenalty: 10, taskPenalty: 10 }, checklists: { rounds: { ignore: true, missPenalty: 5, penaltyDays: ['mon', 'tue', 'wed', 'thu', 'fri'] } } }

test('ignored lists neither earn nor cost', () => {
  const g = computeGame({ runs: [run('rounds', '2026-10-14', ['boiler'])], templates: laundryT, config: cfg, today: '2026-10-17' })
  assert.equal(g.xp, 0)
  assert.equal(g.days.flatMap(d => d.entries).length, 0)
})

test('committed steps left undone cost every day until done, then stop', () => {
  const laundry = {
    runId: 'L1', checklistId: 'laundry', day: '2026-10-14', startIndex: 1, // walk said "from hang"
    checked: { hang: { at: dayAt('2026-10-15') }, fold: { at: dayAt('2026-10-16') } },
  }
  const g = computeGame({
    runs: [laundry], templates: laundryT, config: cfg, today: '2026-10-18',
    commitments: [{ day: '2026-10-14', runIds: ['L1'], taskIds: [] }], dayKeyOf: utcDay,
  })
  const pen = Object.fromEntries(g.days.map(d => [d.day, d.penalty]))
  assert.equal(pen['2026-10-14'], -20) // hang + fold left; load was never committed
  assert.equal(pen['2026-10-15'], -10) // fold left, carried
  assert.equal(pen['2026-10-16'] ?? 0, 0) // done
  assert.equal(pen['2026-10-17'] ?? 0, 0)
  const carried = g.days.find(d => d.day === '2026-10-15').entries.find(e => e.kind === 'carry')
  assert.equal(carried.carried, true)
})

test('a committed task costs every day it stays open, and nothing from the day it is done', () => {
  const g = computeGame({
    runs: [], templates: laundryT, config: cfg, today: '2026-10-18',
    commitments: [{ day: '2026-10-14', runIds: [], taskIds: ['dentist'] }],
    taskInfo: { dentist: { label: 'Call the dentist', doneAt: dayAt('2026-10-16') } },
    dayKeyOf: utcDay,
  })
  const pen = Object.fromEntries(g.days.map(d => [d.day, d.penalty]))
  assert.equal(pen['2026-10-14'], -10)
  assert.equal(pen['2026-10-15'], -10)
  assert.equal(pen['2026-10-16'] ?? 0, 0)
})

test('a reviewed earlier completion date rescales vet XP without changing doctor', () => {
  const game = computeGame({
    runs: [], templates: laundryT, config: cfg, today: '2026-10-18',
    commitments: [{ day: '2026-10-14', runIds: [], taskIds: ['doctor', 'vet'] }],
    taskInfo: {
      doctor: { label: 'Text my doctor', doneAt: null },
      vet: { label: 'Call the vet', doneAt: dayAt('2026-10-17'), completedOn: '2026-10-15' },
    },
    dayKeyOf: utcDay,
  })
  const penalties = Object.fromEntries(game.days.map(day => [day.day, day.penalty]))
  assert.equal(penalties['2026-10-14'], -20)
  assert.equal(penalties['2026-10-15'], -10)
  assert.equal(penalties['2026-10-16'], -10)
})

test('commitments before startDay and on today are never charged', () => {
  const g = computeGame({
    runs: [], templates: laundryT, config: cfg, today: '2026-10-15',
    commitments: [{ day: '2026-10-12', runIds: [], taskIds: ['t'] }],
    taskInfo: { t: { label: 'T', doneAt: null } },
    dayKeyOf: utcDay,
  })
  const pen = Object.fromEntries(g.days.map(d => [d.day, d.penalty]))
  assert.equal(pen['2026-10-12'], undefined)
  assert.equal(pen['2026-10-13'], undefined)
  assert.equal(pen['2026-10-14'], -10) // first day the game counts
  assert.equal(pen['2026-10-15'], undefined) // today: not over yet
})

test('a committed list finished by hand with steps left costs that day, then stops', () => {
  const laundry = { runId: 'L2', checklistId: 'laundry', day: '2026-10-14', finishedAt: dayAt('2026-10-15'), checked: {} }
  const g = computeGame({
    runs: [laundry], templates: laundryT, config: cfg, today: '2026-10-18',
    commitments: [{ day: '2026-10-14', runIds: ['L2'], taskIds: [] }], dayKeyOf: utcDay,
  })
  const pen = Object.fromEntries(g.days.map(d => [d.day, d.penalty]))
  assert.equal(pen['2026-10-14'], -30)
  assert.equal(pen['2026-10-15'], -30)
  assert.equal(pen['2026-10-16'] ?? 0, 0)
})
