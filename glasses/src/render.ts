import { config } from './config'
import { ALL_CLEAR } from './art'
import { renderPong, type PongState } from './pong'
import { renderFontTest } from './fonttest'

/** Injected by vite.config.ts from app.json; falls back when run under Node. */
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
import type {
  AgendaRow,
  AssistantChat,
  AssistantProvider,
  BlockPlan,
  Board,
  ChecklistItem,
  ChecklistRun,
  CoachSegment,
  CoachCue,
  CoachMode,
  CoachSessionSummary,
  InboxGroup,
  InboxItem,
  Snapshot,
  Space,
  StartableChecklist,
  TaskRow,
  TaskNote,
  NoteTranscript,
  DoneRow,
} from './types'
import {
  assemble,
  boardRow,
  checklistItemRow,
  checklistRow,
  inboxGroupRow,
  inboxItemRow,
  agendaRow,
  taskRow,
  ruleRight,
  ruleCentred,
  ago,
  clockShort,
  countdown,
  wrap,
  mins,
  bar,
  clip,
  clipToWidth,
  LINE_CHARS,
  metricRow,
  pad,
} from './format'

export type View =
  | { kind: 'index'; cursor: number }
  | { kind: 'board'; boardId: string; cursor: number }
  | { kind: 'checklist'; runId: string; cursor: number }
  | { kind: 'picker'; cursor: number }
  | { kind: 'plan'; cursor: number }
  | { kind: 'chores'; cursor: number }
  | { kind: 'notes'; cursor: number }
  | { kind: 'capture'; cursor: number }
  | { kind: 'note'; subjectKind: 'task' | 'chore'; subjectId: string; noteId: string; cursor: number }
  | { kind: 'transcript'; subjectKind: 'task' | 'chore'; subjectId: string; noteId: string; scroll?: number }
  | { kind: 'task'; taskId: string; cursor: number }
  /**
   * The Listen screen.
   *
   * `scroll` is how far back through the transcript you have wound, in lines,
   * 0 meaning pinned to the newest. It has to live on the view rather than in
   * the module because the screen repaints every two seconds while recording —
   * anything not in the view would be reset by the next frame, which is what
   * "I scrolled up and it snapped back" looks like.
   */
  | { kind: 'cue'; scroll?: number; modeCursor?: number }
  | { kind: 'assistant'; phase: 'providers'; cursor: number }
  | { kind: 'assistant'; phase: 'chat'; provider: AssistantProvider; scroll?: number }
  | { kind: 'pong' }
  | { kind: 'fonttest'; page: number }
  | { kind: 'inbox'; group: string; cursor: number }

export interface UiState {
  view: View
  snapshot: Snapshot | null
  error: string | null
  /** true while the first fetch is in flight and there is nothing to show yet */
  loading: boolean
  /** wall-clock ms of the last successful fetch */
  lastOkAt: number | null
  /** true while showing a cached snapshot that no live fetch has replaced yet */
  fromCache: boolean
  alertsOnly: boolean
  /** last plan fetched for the current window, null while loading or failed */
  plan: BlockPlan | null
  planLoading: boolean
  /** latest foreground Coach cue returned by the hub */
  cue: CoachCue | null
  /** active listening session for the current space, if one exists */
  coachSession: CoachSessionSummary | null
  /** Coach modes loaded with the current session snapshot. */
  coachModes: CoachMode[]
  /** mode selected for the next listening session */
  coachModeId: string | null
  /** persistent selected-provider conversation from the hub */
  assistantChat: AssistantChat | null
  /** true while the glasses microphone is capturing a chat turn */
  assistantRecording: boolean
  /** true after capture while STT is draining and the turn is queued */
  assistantSending: boolean
  /** Loaded only while a note detail/transcript needs the original session. */
  noteTranscript: NoteTranscript | null
  /** screen to return to after a manual Coach cue is dismissed */
  cueReturn: View | null
  /** non-null only while the game is on screen */
  pong: PongState | null
  /**
   * Diagnostics, shown in the header.
   *
   * `events` counts every event the bridge has delivered; `lastEvent` names the
   * most recent one. If tapping does nothing and this does not move, the app is
   * not receiving input at all — which is a very different problem from the app
   * receiving it and mishandling it.
   */
  events: number
  lastEvent: string
  /** show the event counter in the header instead of the clock */
  diagnostics: boolean
  /** which half of life you are looking at */
  space: Space
  /** first visible row of the current list; slides one row at a time */
  scrollTop: number
  /**
   * The task the cursor is sitting on that has been armed for completion.
   *
   * Ticking off "call dentist" is not undoable from the glasses, and a stray
   * tap on the running order is exactly how the dishwasher step got started by
   * accident. So the first tap arms and the row asks; the second confirms.
   * Any cursor movement disarms.
   */
  armedTaskId: string | null
  /**
   * Daily steps ticked during this visit to the running order, as
   * `runId:itemId`.
   *
   * Done steps leave the list, which is right — the page is what is left to
   * do. But leaving the instant you tick one means the row you just acted on
   * disappears under your finger, taking the only evidence you did anything
   * and the only way to undo it. These stay until you leave the page.
   */
  stickyDone: Set<string>
  /** A second click deletes this selected user-created note; movement disarms. */
  armedNoteId: string | null
  /**
   * Whether the glasses are currently showing us.
   *
   * The OS hands the screen back to its own dashboard when you stop looking
   * and says so with FOREGROUND_EXIT_EVENT. Polling on through that is BLE
   * traffic and battery spent drawing something nobody can see.
   */
  foreground: boolean
  /**
   * When a non-quiet audio chunk was last sent.
   *
   * There is no other way to tell a live microphone from a dead one. Without
   * it, Listen looks identical whether it is hearing you or not — which is
   * exactly how it felt the first time.
   */
  lastAudioAt: number | null
  /**
   * Counters down the audio path.
   *
   * A listening session that produces nothing has six places it can fail and
   * looked identical at all of them. These say which one.
   */
  audio: {
    open: boolean
    frames: number
    chunks: number
    sent: number
    rejected: number
    lastRms: number
    /** what shape the host actually delivered PCM in */
    kind: string
    /** audio events delivered by the host, counted before any of our gating */
    raw: number
    error: string | null
  }
}

/**
 * The index is one flat, scrollable list of mixed rows: checklists first,
 * then a way to start another, then boards.
 *
 * Modelling it as rows rather than sections keeps navigation to a single
 * cursor. Two independent cursors on one screen would mean the same scroll
 * gesture doing different things depending on invisible focus state — the kind
 * of thing that is fine at a desk and useless while walking a building.
 */
export type IndexRow =
  | { kind: 'inbox'; group: InboxGroup }
  | { kind: 'check'; run: ChecklistRun }
  | { kind: 'start' }
  | { kind: 'plan' }
  | { kind: 'switch' }
  | { kind: 'board'; board: Board }

/**
 * The Life screen, top to bottom, as one page.
 *
 * Big-ticket tasks, then the running order. Nothing else — no Lists row, no
 * way out, no index. The Life index listed the same Dishes the running order
 * lists, one click away, which made it a menu whose contents duplicated the
 * screen you were already on. Lists live in the long-press menu now: useful
 * while this is being built, not something to spend a row on every day.
 *
 * The blank row between the two sections is deliberate. Nine lines is not many
 * to spend one on, but without it the screen is a solid block of characters
 * and nothing tells your eye where the big stuff stops and the list begins.
 */
/**
 * The hub's catch-all for captures it could not route. Mirrors
 * `CAPTURE_TASK_ID` in `server/src/index.js`.
 */
const CAPTURE_TASK_ID = 'captured-notes'

export type PlanRow =
  | { kind: 'listen' }
  | { kind: 'daily'; runId: string; listName: string; item: ChecklistItem }
  | { kind: 'task'; task: TaskRow }
  | { kind: 'chores' }
  | { kind: 'agenda'; row: AgendaRow | DoneRow }

/** Is this agenda row a step whose clock is already going? */
function isRunning(state: UiState, row: AgendaRow | DoneRow): boolean {
  if (row.kind !== 'do') return false
  const run = state.snapshot?.checklists?.active.find(r => r.checklistId === row.choreId && !r.complete)
  const item = run?.items.find(i => i.id === row.stepId)
  return Boolean(item && !item.done && (item.running || (item.stepKind === 'wait' && item.endsAt !== null)))
}

export function planRows(state: UiState): PlanRow[] {
  const plan = state.plan
  if (!plan) return []

  // The hub files a Listen capture with no obvious home onto a task called
  // "Captured notes", which is a sensible place to keep them and a useless row
  // to carry on the running order: it is not a thing to do, it never
  // completes, and its whole contents are one click away behind the LIFE line
  // now. It stays in `plan.tasks` so the Notes screen can still read it.
  const tasks: PlanRow[] = (plan.tasks ?? [])
    .filter(task => task.taskId !== CAPTURE_TASK_ID)
    .map(task => ({ kind: 'task', task }))
  const agenda: PlanRow[] = plan.agenda.map(row => ({ kind: 'agenda', row }))
  // The old blank separator, now carrying a name and a destination. A row
  // that only created space was the cheapest thing on the page to improve.
  const gap: PlanRow[] = agenda.length ? [{ kind: 'chores' }] : []

  // The LIFE line, made selectable. Scrolling up off the first task lands on
  // it, and a click starts talking — general capture, no subject, which is the
  // "just let me say a thing" case that otherwise needed the long-press menu.
  // It costs no row: the header line was already on screen doing nothing.
  // Anything required today, above everything else, until it is done.
  //
  // A daily list has no durations and cannot be scheduled into the running
  // order the way a chore is — but "required daily" is exactly the thing that
  // must not live one screen away behind Lists, because the whole failure mode
  // is forgetting it exists. So its unfinished steps sit at the top of the
  // page you already look at, and the section disappears the moment the last
  // one is ticked. Tomorrow's run brings it back on its own.
  const required: PlanRow[] = []
  for (const run of state.snapshot?.checklists?.active ?? []) {
    if (run.kind !== 'daily') continue
    if (!inSpace(run.space, state.space)) continue
    for (const item of run.items) {
      // A ticked step stays put for the rest of this visit. Vanishing the
      // instant it is ticked takes its own evidence with it — you are left
      // looking at a shorter list with no sign you did anything, and no way
      // back if the click was wrong. Leaving the page clears the set, so it
      // is gone the next time you come to it.
      if (item.done && !state.stickyDone.has(`${run.runId}:${item.id}`)) continue
      required.push({ kind: 'daily', runId: run.runId, listName: run.name, item })
    }
  }

  return [{ kind: 'listen' }, ...required, ...tasks, ...gap, ...agenda]
}

/** Rows the cursor is allowed to stop on. */
export function selectable(row: PlanRow | undefined): boolean {
  return row !== undefined
}

/**
 * Every chore, whole, as one block — not the interleaved running order.
 *
 * The running order answers "what can I do in the time I have". This answers
 * "what is actually on my plate", which is a different question and was only
 * reachable by opening chores one at a time.
 */
export type ChoreRow =
  | { kind: 'run'; run: ChecklistRun }
  | { kind: 'start'; list: StartableChecklist }

/**
 * The chores, one row each, with a progress bar.
 *
 * A level between the running order and the steps. The running order answers
 * "what can I do in the time I have" and is interleaved across chores; this
 * answers "what is on my plate", one chore per row, and drills into the steps.
 * Flattening the two into one screen made a long list you had to page through
 * to find anything.
 */
export function choreRows(state: UiState): ChoreRow[] {
  const rows: ChoreRow[] = []
  // Finished chores stay on the list. A chore that vanishes the moment you
  // tick the last step takes its own evidence with it, and leaves you no way
  // to start it again — which for laundry is a daily problem, not an edge case.
  for (const run of state.snapshot?.checklists?.active ?? []) {
    if (!inSpace(run.space, state.space)) continue
    rows.push({ kind: 'run', run })
  }
  const running = new Set(rows.map(r => (r.kind === 'run' ? r.run.checklistId : '')))
  for (const list of startable(state)) {
    if (!running.has(list.id)) rows.push({ kind: 'start', list })
  }
  return rows
}

/**
 * The two things the LIFE line leads to.
 *
 * Clicking it used to start recording outright, which made the one row at the
 * top of the running order mean exactly one thing and left the notes you had
 * already captured reachable only through the long-press menu. A two-item
 * stop makes both permanent: talk, or read back what you said. It costs one
 * extra click on capture, which is the right trade for never losing the way
 * back to your own notes.
 */
export type CaptureRow = { kind: 'listen' } | { kind: 'notes' }

export function captureRows(): CaptureRow[] {
  return [{ kind: 'listen' }, { kind: 'notes' }]
}

function renderCapture(state: UiState, cursor: number): string {
  const rows = captureRows()
  const live = state.coachSession?.active
  const notes = noteRows(state).length

  const lines: string[] = [clockLine(state), ruleCentred('Capture', false), '']
  rows.forEach((row, i) => {
    const point = i === cursor ? '>' : ' '
    if (row.kind === 'listen') {
      lines.push(clipToWidth(`${point}Listen        ${live ? 'recording now' : 'start talking'}`))
    } else {
      lines.push(clipToWidth(`${point}Notes         ${notes === 0 ? 'nothing saved' : `${notes} saved`}`))
    }
  })

  lines.push('', rows[cursor]?.kind === 'listen'
    ? live ? 'click to stop recording' : 'click and start talking'
    : 'click to read them back')
  return assemble(lines, config.maxChars, config.maxLines)
}

function renderChores(state: UiState, cursor: number): string {
  const rows = choreRows(state)
  if (rows.length === 0) {
    return assemble([clockLine(state), spaceLine(state), '', 'No chores.'], config.maxChars, config.maxLines)
  }

  // Five rows, not four: header, rule, five chores, blank, hint is nine lines
  // exactly. The old budget left the bottom of the screen empty.
  const win = windowFollow(cursor, rows.length, config.maxLines - 4, state.scrollTop)
  const lines: string[] = [clockLine(state), ruleRight('Chores', false)]
  for (let i = win.start; i < win.end; i += 1) {
    const row = rows[i]
    if (row.kind === 'run') {
      if (row.run.complete) {
        const armed = state.armedTaskId === row.run.runId
        const right = armed ? 'reset?' : `${ago(row.run.lastAt ?? null)} ago`
        lines.push(
          clip(
            `${i === cursor ? '>' : ' '}${bar(row.run.total, row.run.total)} ${pad(row.run.name, 12)} ${right}`,
            LINE_CHARS,
          ),
        )
      } else lines.push(checklistRow(row.run, i === cursor))
    }
    else {
      lines.push(
        clip(`${i === cursor ? '>' : ' '}${bar(0, row.list.total)} ${pad(row.list.name, 12)} 0/${row.list.total}`, LINE_CHARS),
      )
    }
  }
  lines.push('', 'click to open')
  return assemble(lines, config.maxChars, config.maxLines)
}

/**
 * Every note you have taken, newest first, one line each.
 *
 * Notes live on their tasks, which is right when you are working one and
 * useless when you are trying to remember what you told yourself yesterday —
 * that meant opening tasks one at a time to find out. This is the other view
 * of the same data: all of it, smallest space it fits in, with the task it
 * belongs to named so a line is never orphaned from its subject.
 */
export type NoteRow = {
  note: TaskNote
  subject: { kind: 'task' | 'chore'; id: string; label: string }
}

export function noteRows(state: UiState): NoteRow[] {
  const rows: NoteRow[] = []
  for (const task of state.plan?.tasks ?? []) {
    for (const note of task.notes ?? []) {
      rows.push({ note, subject: { kind: 'task', id: task.taskId, label: task.label } })
    }
  }
  for (const note of state.snapshot?.checklists?.notes ?? []) {
    if (note.space && note.space !== state.space) continue
    rows.push({ note, subject: { kind: 'chore', id: note.checklistId, label: note.label } })
  }
  // Newest first: the thing you said most recently is the thing you are most
  // likely to be looking for.
  return rows.sort((a, b) => (b.note.at ?? 0) - (a.note.at ?? 0))
}

export function findNoteRow(
  state: UiState,
  subjectKind: 'task' | 'chore',
  subjectId: string,
  noteId: string,
): NoteRow | undefined {
  return noteRows(state).find(row =>
    row.subject.kind === subjectKind && row.subject.id === subjectId && row.note.id === noteId,
  )
}

function shortNoteSummary(text: string): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return 'Untitled note'
  const sentence = clean.match(/^.{12,}?[.!?](?:\s|$)/)?.[0]?.trim() ?? clean
  return sentence
}

function renderNotes(state: UiState, cursor: number): string {
  const rows = noteRows(state)
  if (rows.length === 0) {
    return assemble(
      [clockLine(state), ruleCentred('Notes', false), '', 'Nothing written down yet.', '', 'Listen, then talk.'],
      config.maxChars,
      config.maxLines,
    )
  }

  const win = windowFollow(cursor, rows.length, config.maxLines - 2, state.scrollTop)
  const lines: string[] = [clockLine(state), ruleCentred(`Notes ${rows.length}`, false)]
  for (let i = win.start; i < win.end; i += 1) {
    const { note, subject } = rows[i]
    const point = i === cursor ? '>' : ' '
    lines.push(clipToWidth(`${point}${clip(shortNoteSummary(note.text), 28)} · ${subject.label}`))
  }
  return assemble(lines, config.maxChars, config.maxLines)
}

export type NoteDetailAction = 'transcript' | 'delete'

export function noteDetailActions(_state: UiState, row: NoteRow | undefined): NoteDetailAction[] {
  if (!row) return []
  const actions: NoteDetailAction[] = []
  if (row.note.id.endsWith(':note')) actions.push('transcript')
  if (row.note.at !== 0) actions.push('delete')
  return actions
}

function renderNoteDetail(
  state: UiState,
  subjectKind: 'task' | 'chore',
  subjectId: string,
  noteId: string,
  cursor: number,
): string {
  const row = findNoteRow(state, subjectKind, subjectId, noteId)
  if (!row) return assemble(['Note', '', 'That note is gone.'], config.maxChars, config.maxLines)

  const actions = noteDetailActions(state, row)
  const lines = [clipToWidth(`Note · ${row.subject.label} · ${ago(row.note.at)} ago`), 'Summary']
  const summaryRoom = Math.max(1, config.maxLines - lines.length - actions.length)
  const summary = wrap(row.note.text, LINE_CHARS)
  for (const line of summary.slice(0, summaryRoom)) lines.push(clipToWidth(line))

  const key = `${row.subject.kind}:${row.subject.id}:${row.note.id}`
  actions.forEach((action, index) => {
    const point = index === cursor ? '>' : ' '
    if (action === 'transcript') lines.push(`${point}[=] Full transcript`)
    else lines.push(state.armedNoteId === key ? `${point}[!] Click again: delete` : `${point}[x] Delete note`)
  })
  return assemble(lines, config.maxChars, config.maxLines)
}

/**
 * An item with no space belongs to whatever you are looking at.
 *
 * Filtering it out instead would empty every screen the moment the server is
 * older than the app — which is exactly what happened, and it looks like the
 * whole thing is broken rather than like one missing field.
 */
function inSpace(itemSpace: unknown, current: Space): boolean {
  return itemSpace === undefined || itemSpace === null || itemSpace === current
}

export function visibleBoards(state: UiState): Board[] {
  const boards = (state.snapshot?.boards ?? []).filter(b => inSpace(b.space, state.space))
  if (!state.alertsOnly) return boards
  return boards.filter(b => b.status !== 'ok')
}

export function startable(state: UiState): StartableChecklist[] {
  return (state.snapshot?.checklists?.startable ?? []).filter(t => inSpace(t.space, state.space))
}

/** The shared list is personal, so it only appears in the life space. */
export function inboxGroups(state: UiState): InboxGroup[] {
  // The shared list is personal, but never hide it when spaces are unknown.
  const known = (state.snapshot?.boards ?? []).some(b => b.space)
  if (known && state.space !== 'life') return []
  return (state.snapshot?.inbox ?? []).filter(g => g.items.length > 0)
}

export function inboxItems(state: UiState, group: string): InboxItem[] {
  return inboxGroups(state).find(g => g.name === group)?.items ?? []
}

export function indexRows(state: UiState): IndexRow[] {
  const rows: IndexRow[] = []

  // Shared-list groups sit above your own checklists: something the other
  // person added is the thing most likely to be news to you.
  for (const group of inboxGroups(state)) rows.push({ kind: 'inbox', group })
  const active = (state.snapshot?.checklists?.active ?? []).filter(r => inSpace(r.space, state.space))

  // Incomplete lists earn a row. A finished daily list drops off rather than
  // taking up space saying it is done — the point of the screen is what is left.
  for (const run of active) {
    if (state.alertsOnly && run.complete) continue
    if (run.complete && run.kind === 'daily') continue
    rows.push({ kind: 'check', run })
  }

  // Back on this screen rather than in the menu: this IS the lists screen, so
  // "start another one" belongs here next to the ones already running.
  if (startable(state).length > 0 && !state.alertsOnly) rows.push({ kind: 'start' })
  if (!state.alertsOnly) rows.push({ kind: 'plan' })

  for (const board of visibleBoards(state)) rows.push({ kind: 'board', board })

  // Reachable without the contextual menu on purpose: scroll and click are the
  // two gestures known to work, so nothing essential hides behind long-press.
  // Switch stays reachable without the long-press menu. The screen test is
  // gone from here — it has already given up every number it had.
  if (!state.alertsOnly) rows.push({ kind: 'switch' })

  return rows
}

function renderIndexRow(row: IndexRow, selected: boolean, space: Space): string {
  switch (row.kind) {
    case 'inbox':
      return inboxGroupRow(row.group, selected)
    case 'check':
      return checklistRow(row.run, selected)
    case 'start':
      return clip(`${selected ? '>' : ' '}+   Start a list`, LINE_CHARS)
    case 'plan':
      return clip(`${selected ? '>' : ' '}=   The running order`, LINE_CHARS)
    case 'switch':
      return clip(`${selected ? '>' : ' '}~   Switch to ${spaceLabel(otherSpace(space))}`, LINE_CHARS)
    case 'board':
      return boardRow(row.board, selected)
  }
}

export function aiWidgetText(state: UiState): string | null {
  const cue = state.cue
  if (state.space !== 'ops' || !cue || cue.quiet) return null
  if (cue.expiresAt && Date.now() > cue.expiresAt + config.cueMs) return null

  // The body is the news; the title is usually a category. "AI: Ops alert: 4
  // stale" sitting two words from the word OPS spends the line saying where
  // you already know you are.
  const body = cue.lines.find(Boolean)
  if (body) return body
  return cue.title.replace(/^(ops|life)\s+/i, '')
}

function header(state: UiState, right: string): string {
  return plainHeader(state, right)
}

/**
 * Header prefix.
 *
 * No app name and no clock: the image container above carries the time, and
 * repeating it in text wasted the most valuable row on the screen.
 */
/** "SEPT 9/9/26 TUES        11:26p  LIFE" */
export function clockLine(_state: UiState, now = new Date()): string {
  const h24 = now.getHours()
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  const time = `${h}:${String(now.getMinutes()).padStart(2, '0')}${h24 < 12 ? 'a' : 'p'}`
  // The build number lives here now. Reading it used to mean toggling
  // Diagnostics, which is a lot of ceremony for one line you check every time
  // you install something.
  return clip(`${dateLabel(now)}  ${time}  v${APP_VERSION}`, LINE_CHARS)
}

/**
 * Which half you are in, on its own row.
 *
 * It used to be the last word on the clock line, where it was three characters
 * competing with a date and a time — exactly the position your eye skips. On
 * its own line it answers "am I looking at work or home" before you have read
 * anything else, which is the whole question when both screens are lists.
 *
 * The connection flag rides along here rather than on the clock: if this is
 * stale or cached data, that belongs with the label saying what you are
 * looking at.
 */
export function spaceLine(state: UiState, selected = false): string {
  const label = state.space === 'ops' ? 'OPS' : 'LIFE'
  // Selected, the line stops being a header and starts being a button, so it
  // has to say what the click does rather than only what space you are in.
  const point = selected ? '>  ' : '   '



  const connection = state.fromCache
    ? '  ~CACHE'
    : state.error
      ? '  !NET'
      : state.lastOkAt && Date.now() - state.lastOkAt > config.pollMs * 3
        ? '  !OLD'
        : ''

  // Microphone state, ASCII so the firmware cannot silently drop it. MIC*
  // means a chunk of actual speech went up in the last few seconds; MIC. means
  // listening but hearing nothing. A recording indicator that cannot tell you
  // those apart is not worth the characters.
  // Three states, because "trying" and "hearing" are different failures.
  // MIC? opened but no audio has arrived at all; MIC. audio arriving but under
  // the speech threshold; MIC* speech actually going up.
  const mic = state.coachSession?.active
    ? state.lastAudioAt && Date.now() - state.lastAudioAt < 4000
      ? '  MIC*'
      : state.audio.frames > 0
        ? '  MIC.'
        : '  MIC?'
    : ''

  const ai = aiWidgetText(state)
  // When the line is the cursor it earns the right-hand slot, so the one thing
  // you can do from here is spelled out instead of guessed at.
  const action = selected ? (state.coachSession?.active ? '   RECORDING' : '   click: talk / notes') : ''
  return clipToWidth(`${point}${label}${connection}${mic}${action}${ai && !selected ? `   AI: ${ai}` : ''}`)
}

export function dateLabel(now = new Date()): string {
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][now.getMonth()]
  const yy = String(now.getFullYear()).slice(-2)
  const day = ['SUN','MON','TUES','WED','THUR','FRI','SAT'][now.getDay()]
  return `${month} ${now.getMonth() + 1}/${now.getDate()}/${yy} ${day}`
}

function plainHeader(state: UiState, right: string): string {
  // ~CACHE outranks the others: if this is last-known data from a cold start,
  // that is the first thing to know about everything else on screen.
  const connection = state.fromCache
    ? ' ~CACHE'
    : state.error
      ? ' !NET'
      : state.lastOkAt && Date.now() - state.lastOkAt > config.pollMs * 3
        ? ' !OLD'
        : ''
  // Date and time live in the image above. What is left is a title, and only
  // where a title tells you something — an empty one is dropped by the callers
  // rather than costing a row to say nothing.
  return clip(`${right}${connection}`, LINE_CHARS)
}

/**
 * Sliding window.
 *
 * The view moves by a single row when the cursor would leave it, rather than
 * jumping a whole page. Paging is disorienting on a screen this small: the
 * whole thing changes at once and you have to re-find your place. Sliding
 * keeps every neighbouring row where you last saw it.
 *
 * `top` is the previous scroll position, so the window only moves when it has
 * to — scrolling within the visible rows does not shift anything.
 */
export function windowFollow(cursor: number, total: number, size: number, _top: number) {
  // Page-flip, not row-slide.
  //
  // The cursor moves within a still screen, and the screen changes only when
  // the cursor leaves it. Sliding a row at a time keeps the display in
  // constant motion, which reads as slow and clunky at this refresh rate — the
  // snap is what feels fast.
  const page = Math.floor(cursor / size)
  const start = page * size
  const pages = Math.max(1, Math.ceil(total / size))
  return {
    start,
    end: Math.min(start + size, total),
    more: total > size,
    atTop: page === 0,
    atEnd: page >= pages - 1,
  }
}

const SPACES: Array<{ id: Space; label: string }> = [
  { id: 'ops', label: 'Ops' },
  { id: 'life', label: 'Life' },
]

/** The other space — what the switch row goes to. */
export function otherSpace(space: Space): Space {
  return space === 'ops' ? 'life' : 'ops'
}

export function spaceLabel(space: Space): string {
  return SPACES.find(s => s.id === space)?.label ?? space
}

function renderIndex(state: UiState, cursor: number): string {
  if (!state.snapshot) {
    if (state.loading) return 'WAM\n\nLoading...'
    return [
      'WAM',
      '',
      'No data',
      state.error ?? 'unknown error',
      '',
      clip(config.serverUrl, LINE_CHARS),
      '',
      'menu > Refresh to retry',
    ].join('\n')
  }

  const rows = indexRows(state)
  const cue = aiWidgetText(state)
  const visibleRows = config.rowsPerPage

  const win = windowFollow(cursor, rows.length, visibleRows, state.scrollTop)

  // One header row: date, time and which space. Back to text rather than an
  // image — at this size the image bought nothing over the firmware font, cost
  // more vertical space than it saved, and lagged a second behind a switch
  // while its bytes went over BLE.
  const lines: string[] = [clockLine(state), spaceLine(state)]
  const { start, end } = win

  // Nothing outstanding anywhere in this space.
  const open = (state.snapshot.checklists?.active ?? []).filter(
    r => !r.complete && inSpace(r.space, state.space),
  )
  const checksLeft = open.reduce((n, r) => n + (r.total - r.done), 0)
  const flagged = visibleBoards(state).some(b => b.status !== 'ok')
  const listItems = inboxGroups(state).reduce((n, g) => n + g.items.length, 0)

  if (checksLeft === 0 && !flagged && listItems === 0 && !cue && !state.alertsOnly && rows.length > 0) {
    // Everything genuinely done and green. Worth marking rather than showing
    // a wall of ticked boxes.
    return assemble([header(state, 'all ok'), '', ALL_CLEAR], config.maxChars, config.maxLines)
  }

  if (rows.length === 0) {
    lines.push(state.alertsOnly ? 'Nothing flagged.' : 'Nothing configured.')
  } else {
    for (let i = start; i < end; i += 1) {
      lines.push(renderIndexRow(rows[i], i === cursor, state.space))
    }
  }


  return assemble(lines, config.maxChars, config.maxLines)
}

function renderBoard(state: UiState, boardId: string, cursor: number): string {
  const board = state.snapshot?.boards.find(b => b.id === boardId)
  if (!board) return 'WAM\n\nBoard is gone.\n\ndbl-tap to go back'

  // Cursor, not paging: every other screen moves a selector, and the same
  // gesture behaving differently depending on where you are is the fastest way
  // to make a thing feel broken.
  const win = windowFollow(cursor, board.metrics.length, config.rowsPerPage, state.scrollTop)
  const { start, end } = win
  const more = win.more ? `${win.atTop ? '' : '^'}${win.atEnd ? '' : 'v'}` : ''

  const lines = [header(state, `${clip(board.name, 12)}${more ? ` ${more}` : ''}`)]
  for (let i = start; i < end; i += 1) {
    lines.push(clip(`${i === cursor ? '>' : ' '}${metricRow(board.metrics[i])}`, LINE_CHARS))
  }

  const selected = board.metrics[cursor]
  if (selected?.note) lines.push('', clip(`- ${selected.note}`, LINE_CHARS))


  return assemble(lines, config.maxChars, config.maxLines)
}

export function findRun(state: UiState, runId: string): ChecklistRun | undefined {
  return state.snapshot?.checklists?.active.find(r => r.runId === runId)
}

function renderChecklist(state: UiState, runId: string, cursor: number): string {
  const run = findRun(state, runId)
  if (!run) return 'WAM\n\nList closed.\n\ndbl-tap to go back'

  // One row past the last step: talk about this chore. Same idea as the task
  // screen — capture started from inside a list already knows what it is about,
  // so nothing downstream has to guess which chore the note belongs to.
  const total = run.items.length + 1
  const win = windowFollow(cursor, total, config.rowsPerPage, state.scrollTop)
  const { start, end } = win
  const more = win.more ? `${win.atTop ? '' : '^'}${win.atEnd ? '' : 'v'}` : ''

  const lines = [
    header(
      state,
      `${clip(run.name, 11)} ${bar(run.done, run.total, 6)} ${run.done}/${run.total}${more ? ` ${more}` : ''}`,
    ),
  ]
  for (let i = start; i < end; i += 1) {
    if (i === run.items.length) {
      const live = state.coachSession?.active
      lines.push(clip(`${i === cursor ? '>' : ' '}${live ? '[*] Stop listening' : '[~] Note on this list'}`, LINE_CHARS))
    } else lines.push(checklistItemRow(run.items[i], i === cursor))
  }

  // The only footer left in the app: a flagged row resets instead of ticking,
  // which is the one place the click does something you would not expect.
  // What a click does, spelled out while this is still new. Deliberately not
  // the double-tap: going back is the one gesture that is already obvious.
  const item = run.items[cursor]
  if (cursor === run.items.length) {
    lines.push(state.coachSession?.active ? 'recording - click to stop' : `click to talk about ${clip(run.name, 14)}`)
    return assemble(lines, config.maxChars, config.maxLines)
  }
  const tip = item?.suspect
    ? 'running too long - click to reset'
    : item?.done
      ? `done ${clockShort(item.at)} - click to undo`
      : item?.stepKind === 'check'
        ? 'click to tick it off'
      : item?.running
        ? `running ${mins(item.elapsedMs)} - click to finish`
        : item?.stepKind === 'wait' && item.endsAt !== null
          ? `${countdown(item.remainingSeconds)} left - click to finish`
          : 'click to start'
  lines.push(tip)
  return assemble(lines, config.maxChars, config.maxLines)
}

function renderPicker(state: UiState, cursor: number): string {
  const lists = startable(state)
  const lines = [header(state, 'Start a list')]

  if (lists.length === 0) {
    lines.push('Nothing left to start.')
  } else {
    const { start, end } = windowFollow(cursor, lists.length, config.rowsPerPage, state.scrollTop)
    for (let i = start; i < end; i += 1) {
      const list = lists[i]
      lines.push(clip(`${i === cursor ? '>' : ' '}   ${pad(list.name, 18)} ${list.total} items`, LINE_CHARS))
    }
  }


  return assemble(lines, config.maxChars, config.maxLines)
}

function renderInbox(state: UiState, group: string, cursor: number): string {
  const items = inboxItems(state, group)
  if (items.length === 0) return `WAM\n\n${group} is clear.\n\ndbl-tap to go back`

  const win = windowFollow(cursor, items.length, config.rowsPerPage, state.scrollTop)
  const { start, end } = win
  const more = win.more ? `${win.atTop ? '' : '^'}${win.atEnd ? '' : 'v'}` : ''
  const lines = [header(state, `${clip(group, 14)} ${items.length}${more ? ` ${more}` : ''}`)]
  for (let i = start; i < end; i += 1) lines.push(inboxItemRow(items[i], i === cursor))


  return assemble(lines, config.maxChars, config.maxLines)
}

/**
 * The running order.
 *
 * No title row and no footer. The clock image sits directly above this and the
 * gestures are the same as everywhere else — a row spent restating either was
 * a row not spent on the list.
 */
/**
 * The bottom line, describing whatever the cursor is on.
 *
 * It replaces a fixed hint that said the same thing everywhere and an `...`
 * overflow marker that said nothing at all. The last row of a nine-row screen
 * is too expensive to spend on either. It carries both the state of the row
 * and what a click will do to it.
 */
function planTip(state: UiState, rows: PlanRow[], cursor: number): string {
  const ruleAt = rows.findIndex(r => r.kind === 'chores')
  const row = rows[cursor]
  if (!row) return 'Chores'

  // Above the line the rule is just a heading for what is below it — the
  // big-ticket rows say what they are, and a tip about them on a divider that
  // does not belong to them reads as noise.
  if (ruleAt !== -1 && cursor < ruleAt) return 'Chores'
  if (row.kind === 'chores') return 'Chores - click to open'
  if (row.kind === 'task') {
    return state.armedTaskId === row.task.taskId
      ? '! Task - click again to finish'
      : '! Task - click to open'
  }

  if (row.kind === 'listen') {
    return state.coachSession?.active ? 'Recording - click to open Listen' : 'Capture - talk, or read your notes'
  }

  if (row.kind === 'daily') {
    if (row.item.done) return `${row.listName} - done ${clockShort(row.item.at)} - click to undo`
    if (state.armedTaskId === `${row.runId}:${row.item.id}`) return 'Click again to mark it done'
    return `${row.listName} - required today`
  }

  const r = row.row
  if (r.kind === 'gap') return '~ Waiting - nothing to start'
  if (r.kind === 'done') return `[x] Done ${ago(r.at)} ago - click to undo`
  if (isRunning(state, r)) return '[*] Going - click to finish'
  if (!r.open) return '( ) Later - earlier step first'
  return '[>] Ready - click to start'
}

function renderPlan(state: UiState, cursor: number): string {
  const plan = state.plan
  if (!plan) {
    return `WAM\n\n${state.planLoading ? 'Working it out...' : 'No plan yet.'}\n\ndbl-tap to go back`
  }

  const rows = planRows(state)
  if (rows.length <= 1) {
    return 'WAM\n\nNothing with known step times.\n\nAdd estimates in the config.'
  }

  // The rule carries the tip, but it scrolls off once you page past it. On
  // those pages the tip moves to the bottom row instead, so what a click does
  // is never more than a glance away — and no page pays for it twice.
  // The listen row is drawn as the header line, so it is not part of the body
  // and must not be windowed with it. It used to sit in the window and be
  // skipped, which cost the first page a row it never got back — eight lines
  // where nine fit — and pushed the page boundaries out of step, so the second
  // page opened by repeating the last row of the first.
  const body = rows.slice(1)
  const bodyCursor = Math.max(0, cursor - 1)

  // Pages are walked, not divided.
  //
  // A page fits six rows plus a tip line, except a page carrying the Chores
  // rule, which fits seven because the rule carries the tip itself. Dividing
  // by a size cannot express that: the first attempt paged at one size and
  // drew at another, which repeated a row, and the second drew one row past
  // the page it belonged to — visible here, only selectable on the next page.
  // Walking the boundaries makes the rule hold everywhere: what you can see,
  // you can select.
  const ruleAtBody = body.findIndex(r => r.kind === 'chores')
  const FULL = config.maxLines - 2
  let start = 0
  let size = FULL
  for (;;) {
    size = ruleAtBody >= start && ruleAtBody < start + FULL ? FULL : FULL - 1
    if (bodyCursor < start + size || start + size >= body.length) break
    start += size
  }
  const ruleShown = ruleAtBody >= start && ruleAtBody < start + size
  const win = { start, end: Math.min(body.length, start + size) }

  const lines: string[] = [clockLine(state), spaceLine(state, cursor === 0)]
  for (let i = win.start; i < win.end; i += 1) {
    const row = body[i]
    const point = i === bodyCursor && cursor > 0 ? '>' : ' '
    if (row.kind === 'chores') {
      lines.push(ruleCentred(planTip(state, rows, cursor), i === bodyCursor && cursor > 0))
    } else if (row.kind === 'daily') {
      const selected = i === bodyCursor && cursor > 0
      if (selected && state.armedTaskId === `${row.runId}:${row.item.id}`) {
        lines.push(clip('>[?] Mark done?', LINE_CHARS))
      } else {
        // The same row the list itself draws, so a step looks the same wherever
        // you meet it — no duration column, because there is no duration.
        lines.push(checklistItemRow(row.item, selected))
      }
    } else if (row.kind === 'task') {
      const armed = state.armedTaskId === row.task.taskId
      lines.push(clip(`${point}${taskRow(row.task, armed)}`, LINE_CHARS))
    } else if (row.kind === 'agenda') {
      lines.push(clip(`${point}${agendaRow(row.row, isRunning(state, row.row))}`, LINE_CHARS))
    }
  }

  if (!ruleShown) lines.push(planTip(state, rows, cursor))

  return assemble(lines, config.maxChars, config.maxLines)
}

/**
 * One task, opened.
 *
 * Rows are the note lines and then the actions, so scrolling reads the notes
 * rather than being a gesture with nothing to do. Clicking a note line does
 * nothing on purpose — the cursor is a reading aid here, not a selector.
 */
export type TaskDetailRow =
  | { kind: 'noteline'; text: string; first: boolean }
  | { kind: 'space' }
  | { kind: 'listen' }
  | { kind: 'done' }

export function taskDetailRows(state: UiState, taskId: string): TaskDetailRow[] {
  const task = findTask(state, taskId)
  if (!task) return []

  const rows: TaskDetailRow[] = []
  for (const note of task.notes ?? []) {
    // Two characters of indent on continuation lines so a three-line note
    // still reads as one note rather than three.
    wrap(note.text, LINE_CHARS - 2).forEach((line, i) => {
      rows.push({ kind: 'noteline', text: line, first: i === 0 })
    })
  }
  if (rows.length > 0) rows.push({ kind: 'space' })
  // Talk about this task, from this task. Starting capture anywhere else means
  // the hub has to guess the subject; started from here it is not a guess.
  rows.push({ kind: 'listen' })
  rows.push({ kind: 'done' })
  return rows
}

export function findTask(state: UiState, taskId: string): TaskRow | undefined {
  return state.plan?.tasks?.find(t => t.taskId === taskId)
}

function renderTaskDetail(state: UiState, taskId: string, cursor: number): string {
  const task = findTask(state, taskId)
  if (!task) return 'WAM\n\nThat task is gone.'

  const rows = taskDetailRows(state, taskId)
  const est = task.ms === null ? 'no estimate' : mins(task.ms)
  const when = task.opensLabel ? ` - opens ${task.opensLabel}` : ''

  const lines: string[] = [
    clip(task.label, LINE_CHARS),
    clip(`${est}${when}${task.note ? ` - ${task.note}` : ''}`, LINE_CHARS),
  ]

  if (rows.length === 1) lines.push('', 'No notes yet. Add one from your phone.')

  const win = windowFollow(cursor, rows.length, config.rowsPerPage - 2, state.scrollTop)
  for (let i = win.start; i < win.end; i += 1) {
    const row = rows[i]
    const point = i === cursor ? '>' : ' '
    if (row.kind === 'space') lines.push('')
    else if (row.kind === 'listen') {
      const live = state.coachSession?.active
      lines.push(clip(`${point}${live ? '[*] Stop listening' : '[~] Add a note by voice'}`, LINE_CHARS))
    } else if (row.kind === 'done') {
      const armed = state.armedTaskId === taskId
      lines.push(clip(`${point}${armed ? '[?] Really done?' : '[ ] Mark done'}`, LINE_CHARS))
    } else {
      lines.push(clip(`${point}${row.first ? '- ' : '  '}${row.text}`, LINE_CHARS))
    }
  }

  return assemble(lines, config.maxChars, config.maxLines)
}

type TranscriptBlock = {
  speaker: string
  text: string
}

function endsLikeSentence(text: string): boolean {
  return /[.!?][)"'\]]?$/.test(text.trim())
}

/**
 * STT arrives as short segments, but the glasses should read like speech.
 * Merge adjacent chunks from the same speaker into compact paragraph blocks
 * before wrapping, so "I need to do..." does not become a screenful of crumbs.
 */
function transcriptBlocks(segments: CoachSegment[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []

  for (const segment of segments) {
    const speaker = segment.speaker === 'me' ? 'me' : 'other'
    const text = segment.text.replace(/\s+/g, ' ').trim()
    if (!text) continue

    const previous = blocks[blocks.length - 1]
    const startsNewBlock =
      !previous ||
      previous.speaker !== speaker ||
      previous.text.length > 260 ||
      (previous.text.length > 140 && endsLikeSentence(previous.text))

    if (startsNewBlock) blocks.push({ speaker, text })
    else previous.text = `${previous.text} ${text}`
  }

  return blocks
}

function transcriptLines(segments: CoachSegment[]): string[] {
  const lines: string[] = []

  for (const block of transcriptBlocks(segments)) {
    const prefix = block.speaker === 'me' ? '> ' : '- '
    const wrapped = wrap(block.text, LINE_CHARS - prefix.length)
    for (let i = 0; i < wrapped.length; i += 1) {
      lines.push(`${i === 0 ? prefix : '  '}${wrapped[i]}`)
    }
  }

  return lines
}

export function noteTranscriptScrollMax(state: UiState): number {
  const rows = transcriptLines(state.noteTranscript?.segments ?? [])
  return Math.max(0, rows.length - (config.maxLines - 1))
}

function renderNoteTranscript(
  state: UiState,
  subjectKind: 'task' | 'chore',
  subjectId: string,
  noteId: string,
  scroll = 0,
): string {
  const row = findNoteRow(state, subjectKind, subjectId, noteId)
  const transcript = state.noteTranscript?.noteId === noteId ? state.noteTranscript : null
  if (!row || !transcript) {
    return assemble(['Transcript', '', 'Original transcript unavailable.'], config.maxChars, config.maxLines)
  }

  const all = transcriptLines(transcript.segments)
  const room = config.maxLines - 1
  const max = Math.max(0, all.length - room)
  const start = Math.min(Math.max(0, scroll), max)
  const end = Math.min(all.length, start + room)
  const position = all.length > room ? ` ${start + 1}-${end}/${all.length}` : ''
  const lines = [clipToWidth(`Transcript · ${row.subject.label}${position}`)]
  for (const line of all.slice(start, end)) lines.push(clipToWidth(line))
  if (all.length === 0) lines.push('', 'No transcript lines were saved.')
  return assemble(lines, config.maxChars, config.maxLines)
}

/**
 * How far back the transcript can be wound, in wrapped lines.
 *
 * The renderer clamps what it draws, but the cursor lives in the view — so
 * without this the scroll value keeps climbing past the end of the transcript
 * and you flick twenty times to get back to live from a screen that stopped
 * moving ten flicks ago.
 */
export function transcriptScrollMax(state: UiState): number {
  const segments = state.coachSession?.recentSegments ?? []
  if (segments.length === 0) return 0
  // Two lines of chrome above the transcript at the very least; being a little
  // generous here only ever means one extra flick, never a wall.
  const room = Math.max(1, config.maxLines - 2)
  return Math.max(0, transcriptLines(segments).length - room)
}

function transcriptWindow(lines: string[], room: number, scrollBack: number): string[] {
  const maxScroll = Math.max(0, lines.length - room)
  const scroll = Math.min(Math.max(0, scrollBack), maxScroll)
  const end = lines.length - scroll
  let start = Math.max(0, end - room)

  const window = lines.slice(start, end)
  // A long paragraph may be dozens of wrapped rows. Rewinding to its first
  // row on every scroll made the paragraph literally unscrollable. Mark a
  // mid-paragraph window as continuation instead of changing its position.
  if (start > 0 && window[0]?.startsWith('  ')) window[0] = `~ ${window[0].trimStart()}`
  return window
}

function listenSummary(session: CoachSessionSummary | null, cue: CoachCue | null): string | null {
  // A timely interjection outranks the background summary while it is visible.
  // It still gets exactly one row: Listen is primarily a transcript reader.
  const cueText = cue && (!session || cue.createdAt >= session.startedAt)
    ? cue.lines?.join(' ').replace(/\s+/g, ' ').trim()
    : ''
  if (cueText) return clipToWidth(`! ${cueText}`)

  const notes = session?.runningNote?.lines ?? []
  const raw = notes.find(line => /^Thread\s*:/i.test(line)) ?? notes[0]
  if (!raw) {
    const latest = session?.recentSegments?.at(-1)?.text.replace(/\s+/g, ' ').trim()
    return latest ? clipToWidth(`= ${latest}`) : null
  }
  const summary = raw.replace(/^(?:Thread|Now|Hold)\s*:\s*/i, '').trim()
  return summary ? clipToWidth(`= ${summary}`) : null
}

function listenModeLabel(mode: CoachMode): string {
  if (mode.id === 'conversation') return 'Conversate'
  if (mode.id === 'listening') return 'Listen'
  if (mode.id === 'meeting') return 'Meeting'
  return mode.name
}

function renderCue(state: UiState, scrollBack = 0): string {
  const session = state.coachSession
  const cue = state.cue
  const lines: string[] = []
  // Only the explicit flag. Diagnostics used to turn this on too, back when
  // diagnostics meant "show me the internals"; it now means "number the
  // lines", and stapling the audio counters to it buried the transcript —
  // which is the entire point of this screen — under a stats panel.
  const listenDebug = config.listenDebug

  if (!session && state.coachModes.length > 0) {
    const cursor = state.view.kind === 'cue' ? state.view.modeCursor ?? 0 : 0
    lines.push(clockLine(state), ruleCentred('Listen mode', false), '')
    state.coachModes.forEach((mode, index) => {
      const point = cursor === index ? '>' : ' '
      const active = mode.id === state.coachModeId ? '[*]' : '[ ]'
      lines.push(clipToWidth(`${point}${active} ${listenModeLabel(mode)}`))
    })
    return assemble(lines, config.maxChars, config.maxLines)
  }

  if (session?.active) {
    const a = state.audio ?? { open: false, frames: 0, chunks: 0, sent: 0, rejected: 0, lastRms: 0, kind: '-', raw: 0, error: null }
    const mic = !a.open ? 'CLOSED' : a.sent > 0 ? 'MIC*' : a.frames > 0 ? 'MIC.' : 'MIC?'
    if (listenDebug) {
      lines.push(
        clipToWidth(`${mic}  ${clip(session.modeName, 14)}  ${session.segmentCount} lines`),
        clipToWidth(`raw ${a.raw}  frames ${a.frames}  chunks ${a.chunks}  sent ${a.sent}`),
        clipToWidth(`quiet ${a.rejected}  rms ${a.lastRms}/${config.audioMinRms}  pcm ${a.kind}`),
      )
      if (a.error) lines.push(clipToWidth(`err ${a.error}`))

      // The other half of the path. The glasses can prove audio left; this says
      // what the hub did with it.
      const stt = state.snapshot?.stt
      if (stt) {
        lines.push(
          clipToWidth(`stt ${stt.provider}${stt.configured ? '' : ' UNSET'}  ok ${stt.ok}  empty ${stt.empty}  fail ${stt.failed}  ${stt.lastMs}ms`),
        )
        if (stt.lastError) lines.push(clipToWidth(`stt err ${stt.lastError}`))
      }
    } else lines.push(clipToWidth(`LISTEN  ${clip(session.modeName, 12)}  ${session.segmentCount} lines  ${mic}`))
  } else {
    // Stopped is a screen you can act on, not a dead end. Listen from the menu
    // brings you here without recording, so this line has to say how to start.
    const stt = state.snapshot?.stt
    const lines0 = ['STOPPED Listen - click to start']
    if (listenDebug && stt) lines0.push('', clipToWidth(`stt ${stt.provider}${stt.configured ? '' : ' UNSET'}  ok ${stt.ok}  empty ${stt.empty}  fail ${stt.failed}`))
    if (!cue && !session?.recentSegments?.length) return assemble(lines0, config.maxChars, config.maxLines)
    lines.push(...lines0)
  }

  if (!listenDebug) {
    const summary = listenSummary(session ?? null, cue ?? null)
    if (summary) lines.push(summary)
  } else if (cue) {
    lines.push('')
    for (const line of cue.lines) {
      for (const wrapped of wrap(line, LINE_CHARS)) lines.push(wrapped)
    }
  }

  const segments = session?.recentSegments ?? []
  if (segments.length > 0) {
    const room = Math.max(0, config.maxLines - lines.length)
    if (room <= 0) return assemble(lines, config.maxChars, config.maxLines)

    // Wrap everything first, then window over the wrapped lines. Windowing
    // over segments and wrapping after means one long sentence silently eats
    // the whole screen and the scroll position stops meaning anything.
    const all = transcriptLines(segments)

    const maxScroll = Math.max(0, all.length - room)
    const scroll = Math.min(Math.max(0, scrollBack), maxScroll)
    for (const line of transcriptWindow(all, room, scrollBack)) lines.push(line)
    // Say so when you are not at the live end, or a paused view of an old line
    // reads as a transcript that has stopped moving.
    if (scroll > 0) lines.push(clipToWidth(`  ^ ${scroll} more below - scroll down for live`))
  } else if (session?.active) {
    // Name which half is quiet. "Nothing heard yet" is true whether the mic is
    // dead, the chunks never left, or the hub transcribed them to nothing —
    // three different problems that need three different fixes.
    const a = state.audio
    const stt = state.snapshot?.stt
    const why =
      !a.open ? 'mic closed'
        : a.sent === 0 ? 'nothing sent to hub'
        : stt && stt.failed > 0 ? 'hub stt failing'
        : stt && stt.empty > 0 ? 'hub stt heard nothing'
        : 'waiting on hub'
    lines.push('', `No lines yet - ${why}`)
  }

  return assemble(lines, config.maxChars, config.maxLines)
}

const ASSISTANT_PROVIDERS: Array<{ id: AssistantProvider; label: string }> = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
]

function assistantMessageLines(chat: AssistantChat | null): string[] {
  const lines: string[] = []
  for (const message of chat?.messages ?? []) {
    const prefix = message.role === 'user' ? '> ' : message.role === 'system' ? '! ' : '- '
    const clean = message.text.replace(/\s+/g, ' ').trim()
    const wrapped = wrap(clean, Math.max(8, LINE_CHARS - prefix.length))
    wrapped.forEach((line, index) => lines.push(`${index === 0 ? prefix : '  '}${line}`))
  }
  return lines
}

export function assistantScrollMax(state: UiState): number {
  if (state.view.kind !== 'assistant' || state.view.phase !== 'chat' || state.assistantRecording) return 0
  const room = Math.max(1, config.maxLines - 2)
  return Math.max(0, assistantMessageLines(state.assistantChat).length - room)
}

function renderAssistant(state: UiState): string {
  const view = state.view
  if (view.kind !== 'assistant') return ''
  if (view.phase === 'providers') {
    const lines = [clockLine(state), ruleCentred('Chat', false), '']
    ASSISTANT_PROVIDERS.forEach((provider, index) => {
      const point = view.cursor === index ? '>' : ' '
      const ready = state.snapshot?.assistant?.[provider.id] === true
      lines.push(clipToWidth(`${point}${provider.label}  ${ready ? 'ready' : 'setup needed'}`))
    })
    lines.push('', 'click to choose')
    return assemble(lines, config.maxChars, config.maxLines)
  }

  const label = view.provider === 'claude' ? 'Claude' : 'ChatGPT'
  const status = state.assistantRecording
    ? 'REC'
    : state.assistantSending
      ? 'sending'
      : state.assistantChat?.busy
        ? 'thinking'
        : 'ready'
  const footer = state.assistantRecording
    ? '[mic] click to send'
    : state.assistantSending
      ? 'Transcribing and sending...'
      : state.assistantChat?.busy
        ? `${label} is thinking...`
        : '[mic] click to speak'
  const room = Math.max(1, config.maxLines - 2)
  let content: string[]

  if (state.assistantRecording) {
    const segments = state.coachSession?.recentSegments ?? []
    content = segments.length > 0 ? transcriptLines(segments) : ['Recording...', 'Speak, then click to send.']
  } else {
    content = assistantMessageLines(state.assistantChat)
    if (content.length === 0) content = ['No messages yet.']
  }

  const scroll = Math.max(0, Math.min(assistantScrollMax(state), view.scroll ?? 0))
  const end = content.length - scroll
  const window = content.slice(Math.max(0, end - room), end)
  return assemble(
    [clipToWidth(`${label}  ${status}`), ...window, clipToWidth(footer)],
    config.maxChars,
    config.maxLines,
  )
}

/**
 * Number every line when diagnostics is on.
 *
 * This is here so a screen can be described out loud. "Line 6 is cut off",
 * "line 4 will not select" — that is a bug report I can act on, where "the
 * vacuum one" takes three messages to pin down. It replaced the version and
 * event counters that used to sit on the LIFE line: those answered a question
 * we have already answered, and they cost the one line that appears on every
 * single screen.
 */
function numbered(content: string): string {
  return content
    .split('\n')
    .map((line, i) => `${i + 1} ${line}`)
    .join('\n')
}

/** Single entry point: UI state in, one string for the text container out. */
export function render(state: UiState): string {
  const out = renderView(state)
  return state.diagnostics ? numbered(out) : out
}

function renderView(state: UiState): string {
  switch (state.view.kind) {
    case 'index':
      return renderIndex(state, state.view.cursor)
    case 'board':
      return renderBoard(state, state.view.boardId, state.view.cursor)
    case 'task':
      return renderTaskDetail(state, state.view.taskId, state.view.cursor)
    case 'chores':
      return renderChores(state, state.view.cursor)
    case 'notes':
      return renderNotes(state, state.view.cursor)
    case 'capture':
      return renderCapture(state, state.view.cursor)
    case 'note':
      return renderNoteDetail(
        state,
        state.view.subjectKind,
        state.view.subjectId,
        state.view.noteId,
        state.view.cursor,
      )
    case 'transcript':
      return renderNoteTranscript(
        state,
        state.view.subjectKind,
        state.view.subjectId,
        state.view.noteId,
        state.view.scroll ?? 0,
      )
    case 'checklist':
      return renderChecklist(state, state.view.runId, state.view.cursor)
    case 'picker':
      return renderPicker(state, state.view.cursor)
    case 'plan':
      return renderPlan(state, state.view.cursor)
    case 'cue':
      return renderCue(state, state.view.scroll ?? 0)
    case 'assistant':
      return renderAssistant(state)
    case 'pong':
      return state.pong ? renderPong(state.pong) : 'PONG\n\nloading...'
    case 'fonttest':
      return renderFontTest(state.view.page)
    case 'inbox':
      return renderInbox(state, state.view.group, state.view.cursor)
  }
}
