import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addDays, computeGame, GameAnnouncer, levelFor, weekday } from '../src/game.js'

const templates = new Map([
  ['morning', { id: 'morning', kind: 'daily', items: [{ id: 'meds' }, { id: 'teeth' }] }],
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
const full = day => [run('morning', day, ['meds', 'teeth']), run('rounds', day, ['boiler'])]

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
    runs: [run('dishes', '2026-10-10', ['load', 'run']), run('morning', '2026-10-10', ['meds'])],
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
