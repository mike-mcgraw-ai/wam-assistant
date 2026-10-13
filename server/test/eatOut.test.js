import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanEatOut, eatOutEntries } from '../src/eatOut.js'
import { computeGame } from '../src/game.js'

const rule = { weeklyTarget: 100, underXP: 50, overPenalty: 50, settleDays: 3, firstWeek: '2026-10-19' }
const weeks = [
  { week: '2026-10-12', eatOut: 40 },  // before firstWeek
  { week: '2026-10-19', eatOut: 100 }, // exactly the target: under
  { week: '2026-10-26', eatOut: 130.5 },
  { week: '2026-11-02', eatOut: 20 },
]

test('cleanEatOut keeps Monday weeks and dollar totals, rejects anything else', () => {
  assert.deepEqual(cleanEatOut({ through: '2026-10-11', weeks: [{ week: '2026-10-05', eatOut: '98.814' }] }),
    { through: '2026-10-11', weeks: [{ week: '2026-10-05', eatOut: 98.81 }] })
  assert.match(cleanEatOut({ through: '2026-10-11', weeks: [{ week: '2026-10-06', eatOut: 1 }] }).error, /not a Monday/)
  assert.match(cleanEatOut({ through: '2026-10-11', weeks: [{ week: '2026-10-05', eatOut: -1 }] }).error, /dollar/)
  assert.match(cleanEatOut({ through: 'yesterday', weeks: [] }).error, /through/)
  assert.match(cleanEatOut(null).error, /object/)
})

test('a week scores on its Sunday, once settled, from firstWeek on', () => {
  // Sunday 10/25 + 3 settle days: not yet on the 28th, scored on the 29th.
  assert.deepEqual(eatOutEntries({ eatOut: { through: '2026-10-28', weeks }, rule, today: '2026-10-28' }), [])
  const e = eatOutEntries({ eatOut: { through: '2026-11-04', weeks }, rule, today: '2026-11-05' })
  assert.deepEqual(e.map(x => [x.day, x.under, x.xp]), [
    ['2026-10-25', true, 50],
    ['2026-11-01', false, -50],
  ])
})

test('a feed that stopped before a week ended never scores that week', () => {
  const e = eatOutEntries({ eatOut: { through: '2026-10-24', weeks }, rule, today: '2026-11-20' })
  assert.deepEqual(e, [])
})

test('no rule or no data means no entries', () => {
  assert.deepEqual(eatOutEntries({ eatOut: { through: '2026-11-04', weeks }, rule: undefined, today: '2026-11-05' }), [])
  assert.deepEqual(eatOutEntries({ eatOut: null, rule, today: '2026-11-05' }), [])
})

test('computeGame adds the weekly result and keeps the zero floor', () => {
  const g = computeGame({
    runs: [],
    templates: new Map(),
    config: { startDay: '2026-10-14', levels: { base: 100, growth: 50 }, defaults: { stepXP: 10, completeBonus: 25 }, eatOut: rule },
    today: '2026-11-05',
    eatOut: { through: '2026-11-04', weeks },
  })
  // +50 on 10/25, then -50 on 11/01: back to 0, never below.
  assert.equal(g.xp, 0)
  const sun = g.days.find(d => d.day === '2026-10-25')
  assert.equal(sun.earned, 50)
  assert.equal(sun.entries[0].kind, 'eat-out')
  assert.equal(g.days.find(d => d.day === '2026-11-01').penalty, -50)
})
