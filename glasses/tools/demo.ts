import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-ignore - reaching across into the server package for a self-contained demo
import { Store } from '../../server/src/state.js'
// @ts-ignore
import { Checklists } from '../../server/src/checklists.js'
// @ts-ignore
import { agenda, planBlock, reach } from '../../server/src/plan.js'
import { render, type UiState } from '../src/render'
import { LINE_CHARS } from '../src/format'

const boardsCfg = JSON.parse(readFileSync(join(process.cwd(), '..', 'server', 'src', 'boards.config.json'), 'utf8'))
const checksCfg = JSON.parse(readFileSync(join(process.cwd(), '..', 'server', 'src', 'checklists.config.json'), 'utf8'))

const store: any = new Store(boardsCfg, '')
const checklists: any = new Checklists(checksCfg, {})
const now = Date.now()

// A realistic mid-morning state: one real problem, one thing drifting, one
// sensor that has quietly stopped reporting, rounds partly done.
const live: Array<[string, any, number]> = [
  ['ahu1.sat', 70.4, 0],
  ['ahu1.static', 1.7, 0],
  ['chw.supply', 44.2, 0],
  ['zones.hot', 2, 20 * 60],
  ['main.kw', 883, 0],
  ['gen.status', 'READY', 0],
  ['ups.load', 58, 0],
  ['fa.panel', 'NORMAL', 0],
  ['fp.pressure', 101, 0],
  ['elev.down', 0, 0],
  ['wo.open', 44, 0],
  ['wo.urgent', 0, 0],
  ['wo.overdue', 3, 0],
]
for (const [id, value, agoSec] of live) store.set(id, value, { source: 'demo', at: now - agoSec * 1000 })
store.set('ahu1.sat', 70.4, { source: 'demo', at: now, note: 'CH-1 locked out 14:02' })

const M = 60_000
const snap = checklists.snapshot(now)
const am = snap.active.find((r: any) => r.checklistId === 'am-rounds')
for (const [item, mins] of [['boiler', 96], ['ahu', 88], ['chiller', 71]] as const) {
  checklists.check(am.runId, item, true, now - mins * M)
}

// Three past laundry runs so the medians are real rather than estimates.
for (const t of [[4, 32, 3, 55, 14, 7], [5, 31, 4, 58, 18, 9], [3, 33, 5, 52, 12, 6]]) {
  const r = checklists.start('laundry').run
  let clock = now - 30 * 3600 * 1000
  const ids = ['load', 'wash', 'move', 'dry', 'hang', 'away']
  ids.forEach((id, i) => {
    checklists.beginStep(r.runId, id, clock)
    clock += t[i] * M
    checklists.check(r.runId, id, true, clock)
  })
  checklists.finish(r.runId, clock)
}

// ...and one in progress, mid wash cycle.
const liveRun = checklists.start('laundry').run
checklists.beginStep(liveRun.runId, 'load', now - 6 * M)
checklists.check(liveRun.runId, 'load', true, now - 2 * M)
checklists.beginStep(liveRun.runId, 'wash', now - 2 * M)

// a step started by accident five hours ago
const stray = checklists.start('dishes').run
checklists.beginStep(stray.runId, 'load', now - 5 * 3600 * 1000)

const inboxGroups = [
  { name: 'Groceries', items: [
    { id:'i1', text:'grab milk and cat food', by:'sam', createdAt:now, status:'sorted', kind:'shopping', list:'Groceries', parts:['milk'], note:null },
    { id:'i2', text:'grab milk and cat food', by:'sam', createdAt:now, status:'sorted', kind:'shopping', list:'Groceries', parts:['cat food'], note:null },
    { id:'i3', text:'coffee filters', by:'sam', createdAt:now, status:'sorted', kind:'shopping', list:'Groceries', parts:['coffee filters'], note:null },
  ]},
  { name: 'Home', items: [
    { id:'i4', text:'call the plumber about the upstairs sink', by:'mike', createdAt:now, status:'sorted', kind:'task', list:'Home', parts:['call the plumber'], note:'upstairs sink' },
  ]},
  { name: 'Unsorted', items: [
    { id:'i5', text:'that thing for the car', by:'sam', createdAt:now, status:'raw', kind:null, list:null, parts:null, note:null },
  ]},
]

const snapshot = {
  ...store.snapshot(now),
  inbox: inboxGroups,
  checklists: checklists.snapshot(now),
  stats: checklists.allStats(),
}

const frame = (title: string, body: string) => {
  const lines = body.split('\n')
  const bar = '-'.repeat(LINE_CHARS + 2)
  console.log(`\n### ${title}`)
  console.log(`+${bar}+`)
  for (const line of lines) console.log(`| ${line.padEnd(LINE_CHARS)} |`)
  console.log(`+${bar}+`)
  console.log(`${body.length} chars / ${lines.length} lines`)
}

const base: UiState = {
  view: { kind: 'index', cursor: 0 },
  snapshot, error: null, loading: false,
  lastOkAt: now, fromCache: false, alertsOnly: false,
  plan: null, planLoading: false,
  cue: null, coachSession: null, cueReturn: null,
  pong: null,
  events: 0, lastEvent: '-', diagnostics: false, space: 'ops',
  scrollTop: 0, armedTaskId: null,
}

// Build a 60-minute plan the way the server would.
const plannable = checklists.allStats()
  .filter((s: any) => s.plan.length && s.plan.every((x: any) => x.hasDuration))
  .map((s: any) => ({ id: s.checklistId, name: s.name, steps: s.plan }))
const block = planBlock(plannable)
const withPlan = {
  ...base,
  plan: {
    ...block,
    agenda: agenda(block),
    reach: plannable.map((c: any) => ({ choreId: c.id, name: c.name, ...reach(c, 60) })),
  },
}

const amRun = snapshot.checklists.active.find((r: any) => r.checklistId === 'am-rounds')
const demoCue = {
  id: 'demo-ops',
  title: 'Ops alert',
  lines: ['HVAC: CH-1 locked out 14:02', 'Open the board for detail.'],
  kind: 'ops' as const,
  priority: 3,
  quiet: false,
  createdAt: now,
  expiresAt: now + 120_000,
  nextAfterMs: 120_000,
}

const listenSession = {
  id: 'demo-session',
  space: 'ops' as const,
  modeId: 'conversation',
  modeName: 'Conversation',
  title: 'Pitch meeting',
  startedAt: now - 90_000,
  updatedAt: now - 12_000,
  endedAt: null,
  active: true,
  segmentCount: 1,
  recentSegments: [
    {
      id: 'seg-1',
      clientId: 'seg-1',
      speaker: 'Dana',
      text: 'What did the Q3 budget close at?',
      final: true,
      at: now - 12_000,
    },
  ],
  lastCueAt: null,
  lastRecapAt: null,
}

const questionCue = {
  id: 'demo-question',
  title: 'Question raised',
  lines: ['Dana: What did the Q3 budget close at?', 'Answer lane queued.'],
  kind: 'answer' as const,
  priority: 3,
  quiet: false,
  createdAt: now,
  expiresAt: now + 120_000,
  nextAfterMs: 120_000,
}

frame('Ops index', render(withPlan))
frame('Ops index — AI widget', render({ ...withPlan, cue: demoCue }))
frame('Coach — manual', render({ ...withPlan, cue: demoCue, view: { kind: 'cue' } }))
frame('Coach — listening question', render({ ...withPlan, cue: questionCue, coachSession: listenSession, view: { kind: 'cue' } }))
frame('Life index', render({ ...withPlan, space: 'life', view: { kind: 'index', cursor: 0 } }))
frame('Life index — no auto AI widget', render({ ...withPlan, space: 'life', cue: demoCue, view: { kind: 'index', cursor: 0 } }))
frame('Shared list — Groceries', render({ ...withPlan, space: 'life', view: { kind: 'inbox', group: 'Groceries', cursor: 0 } }))

frame('Index — "Flagged only" on', render({ ...base, alertsOnly: true }))
frame('Checklist — AM Rounds', render({ ...base, view: { kind: 'checklist', runId: amRun.runId, cursor: 3 } }))
frame('Checklist — paged down to the last item', render({ ...base, view: { kind: 'checklist', runId: amRun.runId, cursor: 7 } }))
frame('Picker — start a list', render({ ...base, view: { kind: 'picker', cursor: 0 } }))
frame('Board detail — HVAC', render({ ...base, view: { kind: 'board', boardId: 'hvac', cursor: 0 } }))
const laundry = snapshot.checklists.active.find((r: any) => r.checklistId === 'laundry')
frame('Laundry — mid wash cycle', render({ ...base, view: { kind: 'checklist', runId: laundry.runId, cursor: 1 } }))
frame('Running order — cursor row 1', render({ ...withPlan, space: 'life', view: { kind: 'plan', cursor: 1 } }))
frame('Running order — cursor row 4', render({ ...withPlan, space: 'life', view: { kind: 'plan', cursor: 4 } }))
frame('Index — cold start from cache', render({ ...base, fromCache: true }))
frame('Index — server unreachable', render({ ...base, error: 'timeout' }))

// --- everything clear, and the game ---
import { newGame, serve, tick as pongTick, nudge } from '../src/pong'
const clearSnapshot = JSON.parse(JSON.stringify(snapshot))
for (const b of clearSnapshot.boards) {
  b.status = 'ok'; b.counts = { ok: b.metrics.length }; b.summary = `${b.metrics.length} ok`
  for (const m of b.metrics) m.status = 'ok'
}
for (const r of clearSnapshot.checklists.active) {
  r.done = r.total; r.complete = true; for (const i of r.items) i.done = true
}
frame('Index — everything clear', render({ ...base, snapshot: clearSnapshot }))

let g = serve(newGame())
for (let i = 0; i < 26; i += 1) {
  const t = g.ballY - (g.playerY + 1)
  if (i % 2 === 0 && Math.abs(t) > 0.5) g = nudge(g, Math.sign(t))
  g = pongTick(g)
}
frame('Pong — mid rally', render({ ...base, view: { kind: 'pong' }, pong: g }))
import { cardIsWellFormed } from '../src/fonttest'
console.log('\nfont test card lines all equal length:', cardIsWellFormed())
frame('Pong — serve', render({ ...base, view: { kind: 'pong' }, pong: { ...newGame(), playerScore: 3, cpuScore: 2, ticks: 5 } }))
