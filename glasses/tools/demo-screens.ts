/**
 * The demo state, shared.
 *
 * One realistic snapshot, built from the real server modules and the real
 * config files, rendered through the real `render()` into every screen worth
 * looking at. Two consumers:
 *
 *   tools/demo.ts         `npm run demo`, ASCII frames in the terminal
 *   screens.html          the dev-only screens page, the same frames as pixels
 *
 * Keep it the only place the demo state is built. If the terminal and the
 * screens page ever build their state separately, the fast loop starts lying.
 *
 * Runs in Node only: the server modules import node:fs. The screens page gets
 * these frames from the dev server (tools/screens-plugin.ts), never by
 * bundling this file for the browser.
 */
// @ts-ignore - reaching across into the server package for a self-contained demo
import { Store } from '../../server/src/state.js'
// @ts-ignore
import { Checklists } from '../../server/src/checklists.js'
// @ts-ignore
import { agenda, planBlock, reach } from '../../server/src/plan.js'
import boardsCfg from '../../server/src/boards.config.json'
import checksCfg from '../../server/src/checklists.config.json'
import { planRows, render, type UiState } from '../src/render'
import type { CoachMode, DayDraft } from '../src/types'
import { newGame, serve, tick as pongTick, nudge } from '../src/pong'

export interface DemoScreen {
  title: string
  /** exactly what render() returned: the frame the glasses would be sent */
  text: string
}

export function demoScreens(now = Date.now()): DemoScreen[] {
  const screens: DemoScreen[] = []
  const add = (title: string, text: string) => {
    screens.push({ title, text })
  }

  const store: any = new Store(boardsCfg, '')
  const checklists: any = new Checklists(checksCfg, {})

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
  checklists.addNote(
    'vacuum',
    'The start timers were wrong, but the projected end times stayed correct.',
    'listen',
    's-demo-vacuum:note',
    now - 4 * M,
  )

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
    // Near the widest the game text gets: two-digit level, +XP today, streak.
    game: { level: 12, xp: 9440, into: 630, size: 650, toNext: 20, streak: 112, todayEarned: 165 },
  }

  const base: UiState = {
    view: { kind: 'index', cursor: 0 },
    spokenReview: { items: [], total: 0, loading: false, error: null },
    snapshot, error: null, loading: false,
    lastOkAt: now, fromCache: false, alertsOnly: false,
    plan: null, planLoading: false, planError: null,
    cue: null, coachSession: null, coachModes: [], coachModeId: null,
    assistantChat: null, assistantThreads: {},
    assistantRecording: false, assistantReviewing: false, assistantSending: false,
    cueReturn: null,
    pong: null,
    events: 0, lastEvent: '-', diagnostics: false, space: 'ops',
    scrollTop: 0, armedTaskId: null, stickyDone: new Set<string>(),
    donePageAways: new Map<string, number>(), hiddenDone: new Set<string>(), armedNoteId: null,
    listenReviewing: false, foreground: true, lastAudioAt: null,
    audio: { open: false, frames: 0, chunks: 0, sent: 0, rejected: 0, lastRms: 0, kind: '-', raw: 0, error: null },
    noteTranscript: null,
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
      tasks: [{
        kind: 'task' as const,
        taskId: 'clean-garage',
        label: 'Clean out garage',
        note: '',
        ms: null,
        open: true,
        weight: 'big' as const,
        opensLabel: null,
        needsPlan: true,
        notes: [],
      }],
      day: {
        day: '2026-10-11', startHour: 5, started: true, startedAt: now - 15 * M,
        checklistIds: ['laundry', 'dishes', 'vacuum'], taskIds: ['clean-garage'],
        transcript: 'Laundry, dishes, vacuum, and clean out the garage today.',
      },
      morningBrief: null,
    },
  }

  const morningBrief = {
    schemaVersion: 1,
    space: 'life' as const,
    day: '2026-10-11',
    generatedAt: new Date(now).toISOString(),
    snapshotAt: new Date(now).toISOString(),
    mode: 'morning',
    started: false,
    summary: {
      line1: '💬0 📩0 🔗0 🌤61°💧88☔→9a 💵+$240/$18k',
      line2: '',
      line3: '',
      asOfLabel: '@7:05a',
    },
    sources: {},
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
    segmentCount: 3,
    recentSegments: [
      {
        id: 'seg-0',
        clientId: 'seg-0',
        speaker: 'me',
        text: 'The Q3 budget ties back to the vendor line because that is where the growth really landed.',
        final: true,
        at: now - 28_000,
      },
      {
        id: 'seg-1',
        clientId: 'seg-1',
        speaker: 'Dana',
        text: 'What did the Q3 budget close at?',
        final: true,
        at: now - 12_000,
      },
      {
        id: 'seg-2',
        clientId: 'seg-2',
        speaker: 'me',
        text: 'Remind me to send Dana the 2024 taxes note after this.',
        final: true,
        at: now - 4_000,
      },
    ],
    runningNote: {
      title: 'Conversation compass',
      lines: [
        'Thread: Q3 budget and vendor growth',
        'Now: Dana asked for the close number',
        'Hold: Send Dana the 2024 taxes note',
      ],
      updatedAt: now - 4_000,
      segmentCount: 3,
    },
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

  const coachModes: CoachMode[] = [
    { id: 'conversation', name: 'Conversation' },
    { id: 'listening', name: 'Listening' },
    { id: 'meeting', name: 'Meeting' },
    { id: 'notes', name: 'Solo Notes' },
  ].map(({ id, name }) => ({
    id,
    name,
    category: '',
    keepPrivate: false,
    behavior: '',
    cueTypes: {
      answers: true,
      followups: true,
      explanations: true,
      factChecks: true,
      advice: true,
      thoughts: true,
    },
    speakUp: 'medium',
    promptLulls: true,
    periodicRecap: true,
    recapMinutes: 3,
    lullSeconds: 20,
    files: [],
  }))

  add('Ops index', render(withPlan))
  add('Ops index — AI widget', render({ ...withPlan, cue: demoCue }))
  add('Coach — manual', render({ ...withPlan, cue: demoCue, view: { kind: 'cue' } }))
  add('Capture — Listen, Notes, and Chat', render({
    ...withPlan,
    snapshot: { ...snapshot, assistant: { chatgpt: true, claude: true } },
    space: 'life',
    view: { kind: 'capture', cursor: 2 },
  }))
  add('Listen — four modes', render({
    ...withPlan,
    space: 'life',
    cue: null,
    coachModes,
    coachModeId: 'conversation',
    view: { kind: 'cue', modeCursor: 1 },
  }))
  add('Life home — before Start Day', render({
    ...withPlan,
    space: 'life',
    view: { kind: 'plan', cursor: 1 },
    plan: {
      ...withPlan.plan,
      timeline: [], agenda: [], progress: [], reach: [], busyMs: 0,
      day: {
        day: '2026-10-11', startHour: 5, started: false, startedAt: null,
        checklistIds: [], transcript: '',
      },
      morningBrief,
    },
  }))
  add('Life home — greeting selected', render({
    ...withPlan,
    space: 'life',
    view: { kind: 'plan', cursor: 0 },
    plan: {
      ...withPlan.plan,
      timeline: [], agenda: [], progress: [], reach: [], busyMs: 0,
      day: { day: '2026-10-11', startHour: 5, started: false, startedAt: null, checklistIds: [], transcript: '' },
      morningBrief,
    },
  }))
  add('Start Day — recording the house walk', render({
    ...withPlan,
    space: 'life',
    view: { kind: 'daystart', phase: 'recording', scroll: 0 },
    coachSession: { ...listenSession, space: 'life', title: 'Start Day' },
  }))
  const reviewDraft: DayDraft = {
    id: 'demo-day', createdAt: now, transcript: 'Apply for three jobs. Clean the cap. Dishes.',
    items: [
      { id: 'jobs', kind: 'task', label: 'Apply for three jobs', include: true, source: 'Apply for three jobs', note: 'Choose and track three applications' },
      { id: 'kitchen', kind: 'task', label: 'Clean the cap', include: true, source: 'Clean the cap', note: '' },
      { id: 'dishes', kind: 'checklist', label: 'Dishes', include: true, checklistId: 'dishes', source: 'Dishes', note: '' },
    ],
  }
  const reviewPlan = { ...withPlan.plan!, day: { ...withPlan.plan!.day!, draft: reviewDraft } }
  add('Start Day — merged proposal', render({
    ...withPlan, space: 'life', plan: reviewPlan,
    view: { kind: 'daystart', phase: 'draft', cursor: 1 },
  }))
  add('Start Day — inspect misheard row', render({
    ...withPlan, space: 'life', plan: reviewPlan,
    view: { kind: 'daystart', phase: 'row', itemId: 'kitchen', cursor: 2, returnCursor: 1 },
  }))
  add('Chat — provider picker', render({
    ...withPlan,
    snapshot: { ...snapshot, assistant: { chatgpt: true, claude: false } },
    space: 'life',
    view: { kind: 'assistant', phase: 'providers', cursor: 0 },
    assistantThreads: {
      chatgpt: {
        provider: 'chatgpt',
        ready: true,
        busy: true,
        queued: 2,
        pending: { id: 'demo-chat-job', status: 'claimed', claimedBy: 'mikes-mac:chatgpt', attempts: 1, createdAt: now - 30_000, updatedAt: now - 5_000 },
        updatedAt: now,
        messages: [
          { id: 'u1', role: 'user', text: 'Okay ChatGPT, make the chat screen show the goal and current subtask, thank you.', at: now - 35_000 },
        ],
      },
      claude: {
        provider: 'claude',
        ready: false,
        busy: false,
        pending: null,
        updatedAt: now,
        messages: [],
      },
    },
  }))
  add('ChatGPT — conversation', render({
    ...withPlan,
    space: 'life',
    view: { kind: 'assistant', phase: 'chat', provider: 'chatgpt', scroll: 0 },
    assistantChat: {
      provider: 'chatgpt',
      ready: true,
      busy: false,
      pending: null,
      updatedAt: now,
      messages: [
        { id: 'u1', role: 'user', text: 'Can you keep working on the glasses chat and tell me what changed?', at: now - 20_000 },
        { id: 'a1', role: 'assistant', text: 'The voice turn records on the glasses, waits for transcription, and queues a ChatGPT reply. The latest answer opens at its first line, and scrolling down reads through the answer and earlier turns.', at: now - 10_000 },
      ],
    },
  }))
  add('ChatGPT — queued, previous answer stays readable', render({
    ...withPlan,
    space: 'life',
    view: { kind: 'assistant', phase: 'chat', provider: 'chatgpt', scroll: 0, replyId: 'a1' },
    assistantChat: {
      provider: 'chatgpt', ready: true, busy: true, queued: 0,
      pending: { id: 'demo-pending', status: 'queued', claimedBy: null, attempts: 0, createdAt: now, updatedAt: now },
      updatedAt: now,
      messages: [
        { id: 'u1', role: 'user', text: 'What changed in the Chat reader?', at: now - 20_000 },
        { id: 'a1', role: 'assistant', text: 'The reader starts at the first line of my answer and keeps your place while status updates arrive.', at: now - 10_000 },
        { id: 'u2', role: 'user', text: 'What about voice capture?', at: now },
      ],
    },
  }))
  add('ChatGPT — recording', render({
    ...withPlan,
    space: 'life',
    view: { kind: 'assistant', phase: 'chat', provider: 'chatgpt', scroll: 0 },
    assistantRecording: true,
    coachSession: listenSession,
  }))
  add('ChatGPT — recording, scrolled back', render({
    ...withPlan,
    space: 'life',
    view: { kind: 'assistant', phase: 'chat', provider: 'chatgpt', scroll: 3 },
    assistantRecording: true,
    coachSession: {
      ...listenSession,
      recentSegments: [
        ...listenSession.recentSegments,
        {
          id: 'seg-3',
          speaker: 'me',
          text: 'The chat recording screen needs to give nearly the whole display to the spoken transcript and keep scroll position stable while new words arrive.',
          at: now - 6_000,
        },
      ],
    },
  }))
  add('Coach — conversation compass', render({ ...withPlan, cue: null, coachSession: listenSession, view: { kind: 'cue' } }))
  add('Coach — listening question', render({ ...withPlan, cue: questionCue, coachSession: listenSession, view: { kind: 'cue' } }))
  add('Life index', render({ ...withPlan, space: 'life', view: { kind: 'index', cursor: 0 } }))
  add('Life index — no auto AI widget', render({ ...withPlan, space: 'life', cue: demoCue, view: { kind: 'index', cursor: 0 } }))
  add('Shared list — Groceries', render({ ...withPlan, space: 'life', view: { kind: 'inbox', group: 'Groceries', cursor: 0 } }))
  add('Notes — chore note', render({ ...withPlan, space: 'life', view: { kind: 'notes', cursor: 1 } }))
  const reviewItem = {
    id: 'sw_demo-review', revision: 1, title: 'Call the vet about the dog',
    summary: 'Ask about the prescription refill and when the dog should be seen.',
    sourceType: 'solo_notes', capturedAt: now - 30 * M, reviewState: 'unreviewed',
    clarificationQuestions: [], cleanedTranscript: 'Call the vet about the dog and ask about the prescription refill.',
    rawTranscript: { text: 'Call the vet about the dog and ask about the prescription refill.', complete: true },
    audio: { state: 'available' },
  }
  const spokenReview = { items: [reviewItem], total: 1, loading: false, error: null }
  add('Capture — Review count', render({ ...withPlan, space: 'life', spokenReview, view: { kind: 'capture', cursor: 2 } }))
  add('Review — one card', render({ ...withPlan, space: 'life', spokenReview, view: { kind: 'review', phase: 'list', index: 0, cursor: 0 } }))
  add('Review — guarded Home action', render({ ...withPlan, space: 'life', spokenReview,
    view: { kind: 'review', phase: 'card', index: 0, cursor: 0, armedAction: 'Task/Home', armedAt: now } }))
  const amendment = { ...reviewItem, id: 'sw_demo-amendment', title: 'Clean the kitchen', sourceType: 'amendment',
    parentId: reviewItem.id, amendmentKind: 'correction' as const, amendmentBaseRevision: 1,
    amendmentOriginal: 'Clean the cap', cleanedTranscript: 'Clean the kitchen', summary: 'Clean the kitchen' }
  add('Review — voice correction before apply', render({ ...withPlan, space: 'life',
    spokenReview: { items: [amendment], total: 1, loading: false, error: null },
    view: { kind: 'review', phase: 'card', index: 0, cursor: 0 } }))
  const vacuumTranscript = {
    noteId: 's-demo-vacuum:note',
    sessionId: 's-demo-vacuum',
    title: 'Listening',
    startedAt: now - 5 * M,
    endedAt: now - 4 * M,
    segments: [
      { id: 'seg-1', clientId: null, speaker: 'me', text: 'The vacuum start timers were wrong because I missed clicking start.', final: true, at: now - 5 * M },
      { id: 'seg-2', clientId: null, speaker: 'me', text: 'The projected end times were still correct, so I moved to the next task.', final: true, at: now - 4 * M },
    ],
  }
  add('Note — summary and actions', render({
    ...withPlan,
    space: 'life',
    view: { kind: 'note', subjectKind: 'chore', subjectId: 'vacuum', noteId: 's-demo-vacuum:note', cursor: 0 },
    noteTranscript: vacuumTranscript,
  }))
  add('Note — delete armed', render({
    ...withPlan,
    space: 'life',
    view: { kind: 'note', subjectKind: 'chore', subjectId: 'vacuum', noteId: 's-demo-vacuum:note', cursor: 3 },
    armedNoteId: 'chore:vacuum:s-demo-vacuum:note:delete',
    noteTranscript: vacuumTranscript,
  }))
  add('Note — queued for Claude', render({
    ...withPlan,
    space: 'life',
    view: { kind: 'note', subjectKind: 'chore', subjectId: 'vacuum', noteId: 's-demo-vacuum:note', cursor: 2 },
    armedNoteId: 'queued:chore:vacuum:s-demo-vacuum:note:queue-claude',
    noteTranscript: vacuumTranscript,
  }))
  add('Note — full transcript', render({
    ...withPlan,
    space: 'life',
    view: { kind: 'transcript', subjectKind: 'chore', subjectId: 'vacuum', noteId: 's-demo-vacuum:note', scroll: 0 },
    noteTranscript: vacuumTranscript,
  }))

  add('Index — "Flagged only" on', render({ ...base, alertsOnly: true }))
  add('Checklist — AM Rounds', render({ ...base, view: { kind: 'checklist', runId: amRun.runId, cursor: 3 } }))
  add('Checklist — paged down to the last item', render({ ...base, view: { kind: 'checklist', runId: amRun.runId, cursor: 7 } }))
  add('Picker — start a list', render({ ...base, view: { kind: 'picker', cursor: 0 } }))
  add('Board detail — HVAC', render({ ...base, view: { kind: 'board', boardId: 'hvac', cursor: 0 } }))
  const laundry = snapshot.checklists.active.find((r: any) => r.checklistId === 'laundry')
  add('Laundry — mid wash cycle', render({ ...base, view: { kind: 'checklist', runId: laundry.runId, cursor: 1 } }))
  add('Running order — cursor row 1', render({ ...withPlan, space: 'life', view: { kind: 'plan', cursor: 1 } }))
  add('Running order — cursor row 4', render({ ...withPlan, space: 'life', view: { kind: 'plan', cursor: 4 } }))
  {
    // The walk stays reachable all day: the last row of the running order.
    const lifeRows = planRows({ ...withPlan, space: 'life' })
    add('Running order — last row, Add to day', render({ ...withPlan, space: 'life', view: { kind: 'plan', cursor: lifeRows.length - 1 } }))
  }
  add('Life home — Skip for now armed', render({
    ...withPlan,
    space: 'life',
    armedTaskId: 'skip-day',
    view: { kind: 'plan', cursor: 2 },
    plan: {
      ...withPlan.plan,
      timeline: [], agenda: [], progress: [], reach: [], busyMs: 0,
      day: { day: '2026-10-11', startHour: 5, started: false, startedAt: null, checklistIds: [], transcript: '' },
      morningBrief,
    },
  }))
  add('Index — cold start from cache', render({ ...base, fromCache: true }))
  add('Index — server unreachable', render({ ...base, error: 'timeout' }))

  // --- everything clear, and the game ---
  const clearSnapshot = JSON.parse(JSON.stringify(snapshot))
  for (const b of clearSnapshot.boards) {
    b.status = 'ok'; b.counts = { ok: b.metrics.length }; b.summary = `${b.metrics.length} ok`
    for (const m of b.metrics) m.status = 'ok'
  }
  for (const r of clearSnapshot.checklists.active) {
    r.done = r.total; r.complete = true; for (const i of r.items) i.done = true
  }
  add('Index — everything clear', render({ ...base, snapshot: clearSnapshot }))

  let g = serve(newGame())
  for (let i = 0; i < 26; i += 1) {
    const t = g.ballY - (g.playerY + 1)
    if (i % 2 === 0 && Math.abs(t) > 0.5) g = nudge(g, Math.sign(t))
    g = pongTick(g)
  }
  add('Pong — mid rally', render({ ...base, view: { kind: 'pong' }, pong: g }))
  add('Pong — serve', render({ ...base, view: { kind: 'pong' }, pong: { ...newGame(), playerScore: 3, cpuScore: 2, ticks: 5 } }))

  return screens
}
