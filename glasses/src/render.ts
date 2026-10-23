import { config } from './config'
import { ALL_CLEAR } from './art'
import { renderPong, type PongState } from './pong'
import { renderFontTest } from './fonttest'
// The chat screen's words are shared with the WAM Home iPad app (v0.177.0).
import * as chatText from './chattext.js'
import { DISPLAY_PX, measure, USABLE_PX, WIDTH } from './metrics'

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
  DayDraftItem,
  Followup,
} from './types'
import {
  assemble,
  boardRow,
  checklistItemRow,
  checklistRow,
  inboxGroupRow,
  inboxItemLines,
  agendaRow,
  taskRow,
  taskDoneRow,
  ruleRight,
  ruleCentred,
  ago,
  clockShort,
  countdown,
  wrap,
  mins,
  timerClock,
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
  | { kind: 'daystart'; phase: 'recording' | 'reviewing' | 'draft' | 'row' | 'failed'; scroll?: number; cursor?: number; message?: string; itemId?: string; editKind?: 'label' | 'note'; returnCursor?: number }
  | { kind: 'chores'; cursor: number }
  | { kind: 'notes'; cursor: number }
  | { kind: 'capture'; cursor: number }
  | { kind: 'review'; phase: 'list' | 'card'; index: number; cursor: number; returnTo?: 'capture' | 'notes'; armedAction?: string; armedAt?: number }
  | { kind: 'note'; subjectKind: 'task' | 'chore'; subjectId: string; noteId: string; cursor: number }
  | { kind: 'transcript'; subjectKind: 'task' | 'chore'; subjectId: string; noteId: string; scroll?: number }
  | { kind: 'task'; taskId: string; cursor: number }
  /** "Done, follow up later": scroll picks the day, click arms, click saves. */
  | { kind: 'followupDate'; taskId: string; days: number }
  /**
   * The Listen screen.
   *
   * `scroll` is how far back through the transcript you have wound, in lines,
   * 0 meaning pinned to the newest. It has to live on the view rather than in
   * the module because the screen repaints every two seconds while recording —
   * anything not in the view would be reset by the next frame, which is what
   * "I scrolled up and it snapped back" looks like.
   *
   * `startArmed` is the first tap in arm-then-confirm. Recording starts on the
   * second tap only; movement or back leaves/cancels it.
   */
  | { kind: 'cue'; scroll?: number; modeCursor?: number; startArmed?: boolean }
  | { kind: 'assistant'; phase: 'providers'; cursor: number }
  | { kind: 'assistant'; phase: 'chat'; provider: AssistantProvider; scroll?: number; replyId?: string | null }
  | { kind: 'timerReset'; done?: boolean; count?: number }
  | { kind: 'pong' }
  | { kind: 'fonttest'; page: number }
  /** `returnTo: 'capture'` when opened from the Capture menu's Groceries row */
  | { kind: 'inbox'; group: string; cursor: number; returnTo?: 'capture' }

export interface UiState {
  view: View
  spokenReview: { items: SpokenReviewItem[]; total: number; loading: boolean; error: string | null }
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
  planError: string | null
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
  /** latest known conversations for the provider picker */
  assistantThreads: Partial<Record<AssistantProvider, AssistantChat>>
  /** true while the glasses microphone is capturing a chat turn */
  assistantRecording: boolean
  /** true after a chat turn is recorded but before it has been sent */
  assistantReviewing: boolean
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
  recentTaskDone: Map<string, TaskRow>
  /** Number of times each completed row has paged fully out of view. */
  donePageAways: Map<string, number>
  /** Completed rows stay saved, but disappear locally after two page-aways. */
  hiddenDone: Set<string>
  /** A second click deletes this selected user-created note; movement disarms. */
  armedNoteId: string | null
  /** true after Listen is stopped but before its note is saved or discarded */
  listenReviewing: boolean
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
  | { kind: 'start-day' }
  | { kind: 'rebuild-day' }
  | { kind: 'daily'; runId: string; listName: string; item: ChecklistItem }
  | { kind: 'task'; task: TaskRow }
  | { kind: 'task-done'; task: TaskRow }
  | { kind: 'followup'; followup: Followup }
  | { kind: 'chores' }
  | { kind: 'agenda'; row: AgendaRow | DoneRow }

/** Is this agenda row a step whose clock is already going? */
function isRunning(state: UiState, row: AgendaRow | DoneRow): boolean {
  if (row.kind !== 'do') return false
  const run = state.snapshot?.checklists?.active.find(r => r.checklistId === row.choreId && !r.complete)
  const item = run?.items.find(i => i.id === row.stepId)
  return Boolean(item && !item.done && (item.running || (item.stepKind === 'wait' && item.endsAt !== null)))
}

/** Exact far-right timer for the active Home row, refreshed once a second. */
function agendaLiveClock(state: UiState, row: AgendaRow | DoneRow): string {
  if (row.kind !== 'do') return ''
  const run = state.snapshot?.checklists?.active.find(r => r.checklistId === row.choreId && !r.complete)
  const item = run?.items.find(i => i.id === row.stepId)
  if (!item || item.done) return ''
  const now = Date.now()
  if (item.stepKind === 'wait' && item.endsAt !== null) {
    const seconds = Math.ceil((item.endsAt - now) / 1000)
    return seconds >= 0 ? timerClock(seconds) : `+${timerClock(-seconds)}`
  }
  if (item.running && item.startedAt !== null) return timerClock((now - item.startedAt) / 1000)
  return ''
}

export function planRows(state: UiState): PlanRow[] {
  const plan = state.plan
  if (!plan) return []

  const committedTaskIds = new Set(plan.day?.taskIds ?? [])
  const committedTasks: PlanRow[] = plan.tasks
    .filter(task => task.taskId !== CAPTURE_TASK_ID && committedTaskIds.has(task.taskId) && !state.recentTaskDone.has(task.taskId))
    .map(task => ({ kind: 'task', task }))
  const completedTasks: PlanRow[] = [...state.recentTaskDone.values()]
    .filter(task => committedTaskIds.has(task.taskId) && !state.hiddenDone.has(`task:${task.taskId}`))
    .map(task => ({ kind: 'task-done', task }))

  // Dated follow-ups in their 7-day window (or overdue): one-click rows like
  // Shower. A ticked one stays for the rest of the visit so it can be undone.
  const followRows: PlanRow[] = (plan.followups ?? [])
    .filter(f => !f.done || (state.stickyDone.has(`fu:${f.id}`) && !state.hiddenDone.has(`fu:${f.id}`)))
    .map(followup => ({ kind: 'followup', followup }))

  // Before the morning walk-through, Home is the Brief: the Life doorway and
  // the Start Day action, nothing else. Tasks and follow-ups (carried
  // over, pinned from the iPad, urgent groceries) wait behind it until Start
  // Day or the greeting is clicked. Mike, 2026-10-18: "the brief page is completely gone - taken
  // over by the tasks that are supposed to be hidden behind that brief one."
  if (state.space === 'life' && plan.day?.started !== true && plan.day?.skipped !== true) {
    return [{ kind: 'listen' }, { kind: 'start-day' }]
  }

  // The hub files a Listen capture with no obvious home onto a task called
  // "Captured notes", which is a sensible place to keep them and a useless row
  // to carry on the running order: it is not a thing to do, it never
  // completes, and its whole contents are one click away behind the LIFE line
  // now. It stays in `plan.tasks` so the Notes screen can still read it.
  const dailyStepKeys = new Set(
    (state.snapshot?.checklists?.active ?? [])
      .filter(run => run.kind === 'daily' && inSpace(run.space, state.space))
      .flatMap(run => run.items.map(item => `${run.checklistId}:${item.id}`)),
  )
  const agenda: PlanRow[] = plan.agenda
    // Daily steps already have a dedicated top-of-Home lane. Letting the
    // scheduler draw them again is how Shower appeared at both ends.
    .filter(row => row.kind === 'gap' || !dailyStepKeys.has(`${row.choreId}:${row.stepId}`))
    .filter(row => row.kind !== 'done' || !state.hiddenDone.has(`${row.runId}:${row.stepId}`))
    .map(row => ({ kind: 'agenda', row }))

  // Start Day commitments belong on today's Home screen, but only the exact
  // task IDs committed by today's walk. That keeps the historical backlog and
  // catch-all notes task from flooding the running order.

  // The LIFE line, made selectable. Scrolling up off the first body row lands
  // on it, and a click opens the voice-note path — general capture, no subject,
  // which is the "just let me say a thing" case that otherwise needed the
  // long-press menu.
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
      const doneKey = `${run.runId}:${item.id}`
      if (item.done && (!state.stickyDone.has(doneKey) || state.hiddenDone.has(doneKey))) continue
      required.push({ kind: 'daily', runId: run.runId, listName: run.name, item })
    }
  }

  // The walk stays one row away all day: after Start Day it adds to the day
  // (a mid-day "and also"), after Skip it is the way back in. Last, so it
  // never pushes the running order down.
  const walk: PlanRow[] = state.space === 'life'
    ? [{ kind: 'start-day' }, ...(plan.day?.started ? [{ kind: 'rebuild-day' as const }] : [])]
    : []

  return [{ kind: 'listen' }, ...required, ...followRows, ...committedTasks, ...completedTasks, ...agenda, ...walk]
}

function planPageWindow(rows: PlanRow[], cursor: number) {
  const body = rows.slice(1)
  const bodyCursor = Math.max(0, cursor - 1)
  const size = config.maxLines - 3
  let start = 0
  while (bodyCursor >= start + size && start + size < body.length) start += size
  return body.slice(start, Math.min(body.length, start + size))
}

/** Completed rows visible on the cursor's current Home page. */
export function visiblePlanDoneKeys(state: UiState, cursor: number): string[] {
  const keys = []
  for (const row of planPageWindow(planRows(state), cursor)) {
    if (row.kind === 'daily' && row.item.done) keys.push(`${row.runId}:${row.item.id}`)
    if (row.kind === 'agenda' && row.row.kind === 'done') keys.push(`${row.row.runId}:${row.row.stepId}`)
    if (row.kind === 'task-done') keys.push(`task:${row.task.taskId}`)
    if (row.kind === 'followup' && row.followup.done) keys.push(`fu:${row.followup.id}`)
  }
  return keys
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
 * The Capture choices the LIFE line leads to.
 *
 * Clicking it used to start recording outright, which made the one row at the
 * top of the running order mean exactly one thing and left the notes you had
 * already captured reachable only through the long-press menu. The Capture
 * stop keeps Listen, Notes, Review, and Chat reachable without putting a
 * historical backlog on the running order.
 */
export interface SpokenReviewItem {
  id: string
  sessionId?: string | null
  revision: number
  title: string
  summary: string
  sourceType: string
  capturedAt: number
  reviewState: string
  clarificationQuestions: string[]
  cleanedTranscript: string
  rawTranscript?: { text: string; complete?: boolean }
  audio?: { state: string }
  parentId?: string | null
  amendmentKind?: 'correction' | 'detail' | null
  amendmentBaseRevision?: number | null
  amendmentOriginal?: string | null
  provenance?: { humanEditedFields?: string[] }
}

export type CaptureRow = { kind: 'listen' } | { kind: 'notes' } | { kind: 'groceries' } | { kind: 'review' } | { kind: 'chat' }

export function captureRows(): CaptureRow[] {
  // Groceries stays in the menu even when empty (Mike, 2026-10-18).
  return [{ kind: 'listen' }, { kind: 'notes' }, { kind: 'groceries' }, { kind: 'review' }, { kind: 'chat' }]
}

/** The household Groceries list as the glasses see it. */
export function groceryItems(state: UiState): InboxItem[] {
  return (state.snapshot?.inbox ?? []).find(group => group.name === 'Groceries')?.items ?? []
}

function renderCapture(state: UiState, cursor: number): string {
  const rows = captureRows()
  const live = state.coachSession?.active
  const notes = noteRows(state).length

  const lines: string[] = [clockLine(state), ruleCentred('Capture', false), '']
  rows.forEach((row, i) => {
    const point = i === cursor ? '>' : ' '
    if (row.kind === 'listen') {
      lines.push(clipToWidth(`${point}Listen        ${live ? 'recording now' : 'arm mic'}`))
    } else if (row.kind === 'notes') {
      lines.push(clipToWidth(`${point}Notes         ${notes === 0 ? 'nothing saved' : `${notes} saved`}`))
    } else if (row.kind === 'groceries') {
      const items = groceryItems(state)
      const urgent = items.filter(item => item.urgent).length
      lines.push(clipToWidth(`${point}Groceries     ${items.length === 0 ? 'empty' : `${items.length} item${items.length === 1 ? '' : 's'}`}${urgent ? `  ${urgent} urgent` : ''}`))
    } else if (row.kind === 'review') {
      lines.push(clipToWidth(`${point}Review        ${state.spokenReview.total} to check`))
    } else {
      const ready = state.snapshot?.assistant?.chatgpt || state.snapshot?.assistant?.claude
      lines.push(clipToWidth(`${point}Chat          ${ready ? 'choose AI' : 'Mac setup needed'}`))
    }
  })

  const selected = rows[cursor]?.kind
  lines.push('', selected === 'listen'
    ? live ? 'click to stop recording' : 'click to arm mic'
    : selected === 'notes'
      ? 'click to read them back'
      : selected === 'groceries'
        ? 'click for the household list'
      : selected === 'review'
        ? 'click for one card at a time'
      : 'click to choose ChatGPT or Claude')
  return assemble(lines, config.maxChars, config.maxLines)
}

export function spokenReviewActions(item?: SpokenReviewItem): string[] {
  if (item?.parentId) {
    const clarified = item.reviewState === 'unreviewed' ||
      item.reviewState === 'needs_clarification' && !item.clarificationQuestions?.length &&
      item.provenance?.humanEditedFields?.includes('cleanedTranscript')
    return clarified && (item.rawTranscript?.complete || item.provenance?.humanEditedFields?.includes('cleanedTranscript')) && item.amendmentOriginal != null
      ? ['Apply words', 'Open on phone', 'Ignore'] : ['Open on phone', 'Ignore']
  }
  return ['Task/Home', 'Keep moment', 'Done', 'Ignore', 'Add detail', 'Correct', 'Open on phone']
}

/**
 * A review card as scroll stops: what was heard (title, summary, the open
 * question), then each action on its own row.
 *
 * The card used to show one clipped line of the capture and a single action
 * line that the Ring cycled through, so a long capture could not be read on
 * the glasses at all. Like note detail, one scroll now moves one line through
 * the card and on into the actions.
 */
export function spokenReviewCardStops(item?: SpokenReviewItem): { text: string[]; actions: string[] } {
  if (!item) return { text: [], actions: [] }
  const useful = (item.summary || item.cleanedTranscript || item.rawTranscript?.text || '').replace(/\s+/g, ' ').trim()
  const text: string[] = [...wrap(item.title || 'Untitled capture', LINE_CHARS - 1)]
  if (item.parentId) {
    text.push(...wrap(`Was: ${item.amendmentOriginal || 'open on phone'}`, LINE_CHARS - 1))
    text.push(...wrap(`Now: ${item.cleanedTranscript || 'Transcript pending'}`, LINE_CHARS - 1))
  } else text.push(...wrap(useful || 'Transcript pending', LINE_CHARS - 1))
  if (item.reviewState === 'needs_clarification' || item.clarificationQuestions?.length) {
    text.push(...wrap(`? ${item.clarificationQuestions?.[0] || 'Needs your help'}`, LINE_CHARS - 1))
  } else text.push(`Audio: ${item.audio?.state || 'missing'}`)
  return { text, actions: spokenReviewActions(item) }
}

function renderSpokenReview(state: UiState, view: Extract<View, { kind: 'review' }>): string {
  const review = state.spokenReview
  const item = review.items[view.index]
  const lines = [clockLine(state), ruleCentred(`Review ${review.total}`, false)]
  if (review.loading) lines.push('', 'Loading spoken work...')
  else if (!item) lines.push('', review.error ? clipToWidth(review.error) : 'Nothing needs review.')
  else {
    const date = new Date(item.capturedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    lines.push(clipToWidth(`${view.index + 1}/${review.total}  ${item.sourceType}  ${date}`))
    if (review.error) lines.push(clipToWidth(`! ${review.error}`))
    const { text, actions } = spokenReviewCardStops(item)
    if (view.phase === 'list') {
      // One card per scroll: a preview of what was heard, not its whole text.
      const room = roomBelow(lines, 2)
      for (const line of text.slice(0, room)) lines.push(clipToWidth(` ${line}`))
      lines.push('', 'scroll cards - click to open')
    } else {
      const total = text.length + actions.length
      const win = windowFollow(view.cursor, total, roomBelow(lines), state.scrollTop)
      for (let i = win.start; i < win.end; i += 1) {
        const point = i === view.cursor ? '>' : ' '
        if (i < text.length) {
          lines.push(clipToWidth(`${point}${text[i]}`))
          continue
        }
        const action = actions[i - text.length]
        const armed = view.armedAction === action && Date.now() - (view.armedAt || 0) < 5000
        lines.push(clipToWidth(armed
          ? `${point}[!] ${action === 'Task/Home' ? `confirm Home: ${item.title}` : `click again: ${action}`}`
          : `${point}[ ] ${action}`))
      }
    }
  }
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
  const raw = String(text || '')
  // A note written by the hub leads with its summary on its own line — the
  // AI recap, or the distilled title when no model ran. That first line IS
  // the summary, so flattening the whole note and hunting for a sentence
  // ending threw it away and grabbed the start of the transcript instead.
  const first = raw.split('\n').map(line => line.trim()).find(Boolean)
  if (first) return first
  const clean = raw.replace(/\s+/g, ' ').trim()
  if (!clean) return 'Untitled note'
  return clean.match(/^.{12,}?[.!?](?:\s|$)/)?.[0]?.trim() ?? clean
}

function renderNotes(state: UiState, cursor: number): string {
  const rows = noteRows(state)
  if (rows.length === 0) {
    return assemble(
      [clockLine(state), ruleCentred('Notes', false), '', clipToWidth(`${cursor === 0 ? '>' : ' '}Review ${state.spokenReview.total}`), '', 'Nothing written down yet.'],
      config.maxChars,
      config.maxLines,
    )
  }

  const win = windowFollow(cursor, rows.length + 1, config.maxLines - 2, state.scrollTop)
  const lines: string[] = [clockLine(state), ruleCentred(`Notes ${rows.length}`, false)]
  if (win.start === 0) lines.push(clipToWidth(`${cursor === 0 ? '>' : ' '}Review ${state.spokenReview.total}`))
  for (let i = Math.max(1, win.start); i < win.end; i += 1) {
    const { note, subject } = rows[i - 1]
    const point = i === cursor ? '>' : ' '

    // The summary gets the whole row.
    //
    // It used to be cut at 28 characters to make space for the subject, and
    // the subject was "Captured notes" on almost every row — the hub's
    // catch-all — so every line was truncated to append the same six words
    // that said nothing. A label only earns space when it distinguishes this
    // note from the one above it, which the catch-all never does.
    //
    // Where the subject IS real, it goes after the text and is the first
    // thing clipped: knowing what a note says beats knowing where it is
    // filed, and the detail screen carries the subject anyway.
    const named =
      subject.kind === 'task' && subject.id === CAPTURE_TASK_ID ? '' : `   ${subject.label}`
    lines.push(clipToWidth(`${point}${shortNoteSummary(note.text)}${named}`))
  }
  return assemble(lines, config.maxChars, config.maxLines)
}

export type NoteDetailAction = 'transcript' | 'make-task' | 'queue-chatgpt' | 'queue-claude' | 'delete'

export function noteDetailActions(_state: UiState, row: NoteRow | undefined): NoteDetailAction[] {
  if (!row) return []
  const actions: NoteDetailAction[] = []
  if (row.note.id.endsWith(':note')) actions.push('transcript')
  if (row.subject.kind === 'task' && row.subject.id === CAPTURE_TASK_ID) actions.push('make-task')
  actions.push('queue-chatgpt', 'queue-claude')
  if (row.note.at !== 0) actions.push('delete')
  return actions
}

/**
 * Note detail as one list of scroll stops: every line of the note, then each
 * action.
 *
 * The note used to be cut to whatever room the actions left, and the Ring only
 * moved between the actions — so a long note could never be read past its
 * first few lines: the cursor stayed on the actions outside the text while the
 * rest of it ran off the bottom (Mike, 2026-10-17). Now one scroll moves one
 * line through the note and on into the actions, and the page flips only at
 * its edge.
 */
export function noteDetailStops(state: UiState, row: NoteRow | undefined): { text: string[]; actions: NoteDetailAction[] } {
  if (!row) return { text: [], actions: [] }
  return { text: wrap(row.note.text, LINE_CHARS - 1), actions: noteDetailActions(state, row) }
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

  const { text, actions } = noteDetailStops(state, row)
  const lines = [clipToWidth(`Note · ${row.subject.label} · ${ago(row.note.at)} ago`)]
  const total = text.length + actions.length
  const win = windowFollow(cursor, total, roomBelow(lines), state.scrollTop)

  const key = `${row.subject.kind}:${row.subject.id}:${row.note.id}`
  for (let i = win.start; i < win.end; i += 1) {
    const point = i === cursor ? '>' : ' '
    if (i < text.length) {
      lines.push(clipToWidth(`${point}${text[i]}`))
      continue
    }
    const action = actions[i - text.length]
    const actionKey = `${key}:${action}`
    if (action === 'transcript') lines.push(`${point}[=] Full transcript`)
    else if (action === 'make-task') {
      lines.push(
        state.armedNoteId === actionKey
          ? `${point}[!] Click again: add Home`
          : `${point}[+] Make Home task`,
      )
    } else if (action === 'queue-chatgpt') {
      lines.push(
        state.armedNoteId === `queued:${actionKey}` ? `${point}[G] ChatGPT queued`
          : state.armedNoteId === actionKey ? `${point}[!] Click again: queue GPT`
            : `${point}[G] Queue ChatGPT`,
      )
    } else if (action === 'queue-claude') {
      lines.push(
        state.armedNoteId === `queued:${actionKey}` ? `${point}[C] Claude queued`
          : state.armedNoteId === actionKey ? `${point}[!] Click again: queue Claude`
            : `${point}[C] Queue Claude`,
      )
    } else {
      lines.push(state.armedNoteId === actionKey ? `${point}[!] Click again: delete` : `${point}[x] Delete note`)
    }
  }
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
  // person added is the thing most likely to be news to you. In Life only
  // urgent items earn a row here (v0.193.0); the whole list lives under the
  // Life bar, in Capture → Groceries. Mike, 2026-10-23: "URGENT is the only
  // ones that should be added to glasses list on main page".
  for (const group of inboxGroups(state)) {
    if (state.space === 'life' && !group.items.some(item => item.urgent)) continue
    rows.push({ kind: 'inbox', group })
  }
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
      return inboxGroupRow(row.group, selected, space === 'life')
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
export function spaceLine(state: UiState, selected = false, labelOverride?: string, actionOverride?: string): string {
  // Before Start Day, Life Home greets instead of naming the space (Mike,
  // 2026-10-13). Same line in every other way: selectable, opens talk / notes,
  // carries the connection, mic and game markers.
  const label = labelOverride ?? (state.space === 'ops' ? 'OPS' : 'LIFE')
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
  const action = selected
    ? state.coachSession?.active ? '   RECORDING' : `   click: ${actionOverride ?? 'talk / notes'}`
    : ''
  const aiText = ai && !selected ? `   AI: ${ai}` : ''
  // The game bar takes whatever room the rest of the line leaves.
  const game = gameText(state, USABLE_PX - measure(`${point}${label}${connection}${mic}${action}${aiText}`))
  // Selected, the click hint is the point of the line. If the game markers
  // would push it off the edge (a long label like the morning greeting), the
  // markers give way for as long as the cursor is here.
  const full = `${point}${label}${connection}${mic}${game}${action}${aiText}`
  if (selected && game && measure(full) > USABLE_PX) {
    return clipToWidth(`${point}${label}${connection}${mic}${action}`)
  }
  return clipToWidth(full)
}

/**
 * The life game on the space line: "  Lv4 ━━━━━━━──────── 45%  +40  3d".
 *
 * It rides on a line that is already there rather than costing one of the nine
 * rows. Mike (2026-10-15) wants the bar big — one line across up to half the
 * screen — and not drawn with #/-. So progress is a heavy line running into a
 * light one, and it grows to fill the room the line has left, capped at half
 * the screen: full length beside LIFE, shorter beside the morning greeting.
 *
 * Box-drawing glyphs are not in font.json and the firmware drops what it
 * lacks, so the level and percentage stay in ASCII beside the bar: if the line
 * fails to draw, the number still says where he is. The bar is sized as if
 * each glyph were as wide as `m`, so an unmeasured glyph can only make it
 * shorter than planned, never push the line into a wrap. +N is XP earned
 * today, Nd the streak. Everything is computed on the hub by fixed rules.
 */
const BAR_HEAVY = '\u2501'
const BAR_LIGHT = '\u2500'
const BAR_MAX_PX = DISPLAY_PX / 2 - 48 // half the visible line, after Lv/%
const BAR_MIN_CELLS = 4

export function gameText(state: UiState, roomPx = USABLE_PX): string {
  const g = state.snapshot?.game
  if (!g) return ''
  const fraction = Math.max(0, Math.min(1, g.into / Math.max(1, g.size)))
  const pct = `${Math.floor(fraction * 100)}%`
  const today = g.todayEarned > 0 ? `  +${g.todayEarned}` : ''
  const streak = g.streak > 0 ? `  ${g.streak}d` : ''
  const words = `  Lv${g.level}  ${pct}${today}${streak}`
  const cellPx = WIDTH['m'] ?? 16
  const cells = Math.min(Math.floor(BAR_MAX_PX / cellPx), Math.floor((roomPx - measure(words) - 4) / cellPx))
  if (cells < BAR_MIN_CELLS) return words
  // Never show a full line for partial progress.
  const heavy = Math.min(fraction < 1 ? cells - 1 : cells, Math.floor(fraction * cells))
  return `  Lv${g.level} ${BAR_HEAVY.repeat(heavy)}${BAR_LIGHT.repeat(cells - heavy)} ${pct}${today}${streak}`
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
 * The confirm gate's countdown, applied to a finished frame.
 *
 * While a second click would still be ignored, the prompt counts 3, 2, 1:
 * "Click again" reads "Wait N", and the armed row's own [?] / [!] marker reads
 * [N]. The marker matters most: most armed prompts never said "click again"
 * ("[?] Mark done?", "[?] Confirm task done?", "[?] Rebuild today"), so a
 * countdown keyed only to those words was silently missing from them — and a
 * rewording (v0.168.0) could drop it from the rest. The armed row is the
 * cursor row: arming always happens on the row under the cursor.
 */
export function armCountdown(content: string, left: number): string {
  const lines = content.split('\n').map(line =>
    line.replace(/Click again/g, `Wait ${left}`).replace(/click again/g, `wait ${left}`))
  const at = lines.findIndex(line => line.startsWith('>') && /\[[?!]\]/.test(line))
  if (at >= 0) lines[at] = lines[at].replace(/\[[?!]\]/, `[${left}]`)
  return lines.join('\n')
}

/**
 * How many list rows fit under the lines already on screen.
 *
 * Every list used to size its window from a fixed setting (`rowsPerPage`)
 * instead of from what was left after its own header. On the native text
 * screen the budget is 10 lines, 9 under the clock — so the last rows of each
 * page were drawn past the bottom of the glasses, and a cursor that landed on
 * one of them was off-screen while the list around it stood still. Sizing from
 * the real remainder keeps the cursor on a line that exists.
 */
export function roomBelow(lines: readonly string[], reserve = 0): number {
  return Math.max(1, config.maxLines - lines.length - reserve)
}

/**
 * Page-aligned window. The cursor moves against a fixed page; the viewport
 * changes only after the cursor crosses a page edge.
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

/** The app font has no emoji glyphs even though phone notifications do. */
function glassesSafeText(value: string): string {
  return value
    .replace(/💬/gu, ' TXT ')
    .replace(/📩/gu, ' MAIL ')
    .replace(/🔗/gu, ' LI ')
    .replace(/🌤/gu, ' TEMP ')
    .replace(/💵/gu, ' MONEY ')
    .replace(/💧/gu, ' HUM ')
    .replace(/☔/gu, ' RAIN ')
    .replace(/⚙/gu, ' -- ')
    .replace(/[–—]/gu, '--')
    .replace(/°/gu, 'F ')
    .replace(/→/gu, ' at ')
    .replace(/\s+/g, ' ')
    .trim()
}

function wrapToGlassWidth(value: string): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word
    if (!line || measure(candidate) <= USABLE_PX) line = candidate
    else {
      lines.push(clipToWidth(line))
      line = word
    }
  }
  if (line) lines.push(clipToWidth(line))
  return lines
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
  // Only urgent items are news on this screen in Life (v0.193.0).
  const listItems = inboxGroups(state).reduce((n, g) => n + g.items.filter(item => state.space !== 'life' || item.urgent).length, 0)

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
  const noteRoom = board.metrics.some(metric => metric.note) ? 2 : 0
  const win = windowFollow(cursor, board.metrics.length, roomBelow(['header'], noteRoom), state.scrollTop)
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

/**
 * A routine can be closed with steps left: the dishwasher that isn't full
 * enough to run (v0.194.0). Every-day lists are ticked, never closed.
 * Mike, 2026-10-23: "Dishes dont really need to be ran - since its not full,
 * but I did all the other steps so need to close it all off".
 */
export function closable(run: ChecklistRun): boolean {
  return run.kind === 'ondemand'
}

/** Rows on a list's own screen: its steps, the note row, then Close. */
export function checklistRowCount(run: ChecklistRun): number {
  return run.items.length + 1 + (closable(run) ? 1 : 0)
}

/** What the confirming tap will do to a checklist step (v0.120.0 gate). */
function armedVerb(item: ChecklistItem): string {
  if (item.suspect) return 'Reset'
  if (item.done) return 'Undo'
  if (item.stepKind === 'check') return 'Tick'
  if (item.running || (item.stepKind === 'wait' && item.endsAt !== null)) return 'Finish'
  return 'Start'
}

function renderChecklist(state: UiState, runId: string, cursor: number): string {
  const run = findRun(state, runId)
  if (!run) return 'WAM\n\nList closed.\n\ndbl-tap to go back'

  // One row past the last step: talk about this chore. Same idea as the task
  // screen — capture started from inside a list already knows what it is about,
  // so nothing downstream has to guess which chore the note belongs to.
  const total = checklistRowCount(run)
  const win = windowFollow(cursor, total, roomBelow(['header'], 1), state.scrollTop)
  const left = run.total - run.done
  const { start, end } = win
  const more = win.more ? `${win.atTop ? '' : '^'}${win.atEnd ? '' : 'v'}` : ''

  const lines = [
    header(
      state,
      `${clip(run.name, 11)} ${bar(run.done, run.total, 6)} ${run.done}/${run.total}${more ? ` ${more}` : ''}`,
    ),
  ]
  for (let i = start; i < end; i += 1) {
    if (i === run.items.length + 1) {
      lines.push(clip(i === cursor && state.armedTaskId === `close:${run.runId}`
        ? `>[?] Close ${run.name}?`
        : `${i === cursor ? '>' : ' '}[ ] Close ${run.name}${left ? ` (${left} left)` : ''}`, LINE_CHARS))
    } else if (i === run.items.length) {
      const live = state.coachSession?.active
      lines.push(clip(`${i === cursor ? '>' : ' '}${live ? '[*] Stop listening' : '[~] Note on this list'}`, LINE_CHARS))
    } else if (i === cursor && state.armedTaskId === `item:${run.runId}:${run.items[i].id}`) {
      lines.push(clipToWidth(`>[?] ${armedVerb(run.items[i])} ${run.items[i].label}?`))
    } else lines.push(checklistItemRow(run.items[i], i === cursor))
  }

  // The only footer left in the app: a flagged row resets instead of ticking,
  // which is the one place the click does something you would not expect.
  // What a click does, spelled out while this is still new. Deliberately not
  // the double-tap: going back is the one gesture that is already obvious.
  const item = run.items[cursor]
  if (cursor === run.items.length + 1) {
    const armedClose = state.armedTaskId === `close:${run.runId}`
    lines.push(armedClose
      ? left ? `click again - ${left} left not needed` : 'click again to close'
      : left ? 'click to close - the rest not needed' : 'click to close it')
    return assemble(lines, config.maxChars, config.maxLines)
  }
  if (cursor === run.items.length) {
    lines.push(state.coachSession?.active ? 'recording - click to stop' : 'click arms voice note')
    return assemble(lines, config.maxChars, config.maxLines)
  }
  const armed = item && state.armedTaskId === `item:${run.runId}:${item.id}`
  const tip = armed
    ? `click again to ${armedVerb(item).toLowerCase()}`
    : item?.suspect
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
    const { start, end } = windowFollow(cursor, lists.length, roomBelow(lines), state.scrollTop)
    for (let i = start; i < end; i += 1) {
      const list = lists[i]
      lines.push(clip(`${i === cursor ? '>' : ' '}   ${pad(list.name, 18)} ${list.total} items`, LINE_CHARS))
    }
  }


  return assemble(lines, config.maxChars, config.maxLines)
}

function activeTimerCount(state: UiState): number {
  let count = 0
  for (const run of state.snapshot?.checklists?.active ?? []) {
    for (const item of run.items) {
      if (item.done) continue
      if (item.running || (item.stepKind === 'wait' && item.endsAt !== null)) count += 1
    }
  }
  return count
}

function renderTimerReset(state: UiState): string {
  const done = state.view.kind === 'timerReset' && state.view.done
  const count = done && state.view.kind === 'timerReset'
    ? state.view.count ?? 0
    : activeTimerCount(state)
  const plural = count === 1 ? '' : 's'

  if (done) {
    return assemble(
      [
        clockLine(state),
        ruleCentred('Reset timers', false),
        '',
        `Canceled ${count} timer${plural}.`,
        'Running order is clean.',
        '',
        'tap or dbl-tap to return',
      ],
      config.maxChars,
      config.maxLines,
    )
  }

  return assemble(
    [
      clockLine(state),
      ruleCentred('Reset timers', false),
      '',
      count === 0 ? 'No active timers.' : `${count} active timer${plural}.`,
      count === 0 ? 'Nothing to cancel.' : 'Tap cancels all active.',
      'Done steps stay saved.',
      '',
      'dbl-tap backs out',
    ],
    config.maxChars,
    config.maxLines,
  )
}

function renderInbox(state: UiState, group: string, cursor: number): string {
  const items = inboxItems(state, group)
  if (items.length === 0) return `WAM\n\n${group} is clear.\n\ndbl-tap to go back`

  const capacity = roomBelow(['header'])
  const rows = items.map((item, itemIndex) => inboxItemLines(item, itemIndex === cursor, 0, itemIndex === cursor && state.armedTaskId === `list:${item.id}`))
  const pages: Array<{ start: number; end: number; used: number }> = [{ start: 0, end: 0, used: 0 }]
  for (const [itemIndex, row] of rows.entries()) {
    const height = Math.min(row.length, capacity)
    let page = pages[pages.length - 1]
    if (page.used && page.used + height > capacity) {
      page = { start: itemIndex, end: itemIndex, used: 0 }
      pages.push(page)
    }
    page.end = itemIndex + 1
    page.used += height
  }
  const pageIndex = Math.max(0, pages.findIndex(page => cursor < page.end))
  const page = pages[pageIndex]
  const more = pages.length > 1 ? `${pageIndex ? '^' : ''}${pageIndex < pages.length - 1 ? 'v' : ''}` : ''
  const lines = [header(state, `${clip(group, 14)} ${items.length}${more ? ` ${more}` : ''}`)]
  for (let itemIndex = page.start; itemIndex < page.end; itemIndex += 1) {
    lines.push(...rows[itemIndex].slice(0, capacity))
  }

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
  const row = rows[cursor]
  if (!row) return 'Life'
  if (row.kind === 'chores') return 'Chores - click to open'
  if (row.kind === 'start-day') {
    return state.plan?.day?.started ? 'click to add more to today' : 'click to walk the house and name today'
  }
  if (row.kind === 'rebuild-day') return state.armedTaskId === 'rebuild-day' ? 'Click again to rebuild today' : 'Restart today review; unfinished work stays'
  if (row.kind === 'task') {
    return '! Task - click for notes or Mark done'
  }
  if (row.kind === 'task-done') return state.armedTaskId === `undo:task:${row.task.taskId}`
    ? 'Click again to reopen task'
    : '[x] Done - reopen task'
  if (row.kind === 'listen') {
    return state.coachSession?.active ? 'Recording - click to open Listen' : 'Capture - talk, or read your notes'
  }

  if (row.kind === 'followup') {
    const f = row.followup
    if (f.done && state.armedTaskId === `undo:fu:${f.id}`) return 'Click again to undo'
    if (f.done) return 'Follow-up done - click to undo'
    if (state.armedTaskId === `fu:${f.id}`) return 'Click again to check it off'
    return `Follow-up ${dayLabel(f.dueDay)} (${followupWhen(f.daysLeft)}) - click to check off`
  }

  if (row.kind === 'daily') {
    if (row.item.done && state.armedTaskId === `undo:${row.runId}:${row.item.id}`) return 'Click again to undo'
    if (row.item.done) return `${row.listName} - done ${clockShort(row.item.at)} - click to undo`
    if (state.armedTaskId === `${row.runId}:${row.item.id}`) return 'Click again to mark it done'
    return `${row.listName} - required today`
  }

  const r = row.row
  if (r.kind === 'gap') return '~ Waiting - nothing to start'
  if (r.kind === 'done' && state.armedTaskId === `undo:${r.runId}:${r.stepId}`) return 'Click again to undo'
  if (r.kind === 'done') return `[x] Done ${ago(r.at)} ago - click to undo`
  if (state.armedTaskId === `step:${r.choreId}:${r.stepId}`) {
    return isRunning(state, r) ? 'Click again to finish' : 'Click again to start'
  }
  if (isRunning(state, r)) return '[*] Going - click to finish'
  if (!r.open) return '( ) Later - earlier step first'
  return '[>] Ready - click to start'
}

function renderPlan(state: UiState, cursor: number): string {
  const plan = state.plan
  if (!plan) {
    const detail = state.planLoading ? 'Working it out...' : `No plan - ${state.planError || 'waiting for hub'}`
    return assemble([clockLine(state), spaceLine(state), '', ...wrap(detail, LINE_CHARS)], config.maxChars, config.maxLines)
  }

  const rows = planRows(state)
  if (rows.length <= 1) {
    return assemble(
      [clockLine(state), spaceLine(state), '', 'Nothing with known step times.', 'Add estimates in the config.'],
      config.maxChars,
      config.maxLines,
    )
  }

  // Before Start Day, the hub owns the brief contract. Older hubs still fall
  // back to the basic setup/off rows so the screen stays truthful.
  if (state.space === 'life' && plan.day?.started !== true && plan.day?.skipped !== true) {
    const startSelected = cursor === 1
    const summary = plan.morningBrief?.summary ?? {
      line1: 'MAIL SET | SET | MONEY SET',
      line2: '',
      line3: '',
      asOfLabel: '@setup',
    }
    const briefLines = [
      glassesSafeText(summary.line1),
      glassesSafeText(summary.line2),
      glassesSafeText(summary.line3),
    ].filter(Boolean).flatMap(line => wrapToGlassWidth(line)).slice(0, 3)
    // No hint or refresh-time row here: the selectable rows say what they do.
    return assemble(
      [
        clockLine(state),
        spaceLine(state, cursor === 0, 'Good morning, Mike.', 'continue'),
        ...briefLines,
        `${startSelected ? '>' : ' '}+   ${plan.day?.draft ? 'Review Day' : 'Start Day'}`,
      ],
      config.maxChars,
      config.maxLines,
    )
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
  const FULL = config.maxLines - 2
  let start = 0
  let size = FULL
  // Every page now ends in the hint line (v0.117.0): it moved off the Chores
  // rule so the rule stays the same while the cursor moves, and on the glasses
  // the hint is native text, so scrolling never redraws the list picture.
  for (;;) {
    size = FULL - 1
    if (bodyCursor < start + size || start + size >= body.length) break
    start += size
  }
  const win = { start, end: Math.min(body.length, start + size) }

  const lines: string[] = [clockLine(state), spaceLine(state, cursor === 0)]
  for (let i = win.start; i < win.end; i += 1) {
    const row = body[i]
    const point = i === bodyCursor && cursor > 0 ? '>' : ' '
    if (row.kind === 'chores') {
      lines.push(ruleCentred('Chores', i === bodyCursor && cursor > 0))
    } else if (row.kind === 'start-day') {
      lines.push(clip(`${point}+   ${state.plan?.day?.draft ? 'Review Day' : state.plan?.day?.started ? 'Add to day' : 'Start Day'}`, LINE_CHARS))
    } else if (row.kind === 'rebuild-day') {
      lines.push(clip(`${point}${state.armedTaskId === 'rebuild-day' ? '[?] ' : ''}Rebuild today`, LINE_CHARS))
    } else if (row.kind === 'daily') {
      const selected = i === bodyCursor && cursor > 0
      if (selected && state.armedTaskId === `${row.runId}:${row.item.id}`) {
        lines.push(clip('>[?] Mark done?', LINE_CHARS))
      } else if (selected && state.armedTaskId === `undo:${row.runId}:${row.item.id}`) {
        lines.push(clipToWidth(`>[?] Undo ${row.item.label}?`))
      } else {
        // The same row the list itself draws, so a step looks the same wherever
        // you meet it — no duration column, because there is no duration.
        lines.push(checklistItemRow(row.item, selected))
      }
    } else if (row.kind === 'followup') {
      const f = row.followup
      const selected = i === bodyCursor && cursor > 0
      if (selected && state.armedTaskId === `fu:${f.id}`) lines.push(clipToWidth(`>[?] Check off ${f.label}?`))
      else if (selected && state.armedTaskId === `undo:fu:${f.id}`) lines.push(clipToWidth(`>[?] Undo ${f.label}?`))
      else lines.push(followupRow(f, selected))
    } else if (row.kind === 'task') {
      lines.push(taskRow(row.task, false, point === '>'))
    } else if (row.kind === 'task-done') {
      const armed = state.armedTaskId === `undo:task:${row.task.taskId}`
      lines.push(armed ? clipToWidth(`${point}[?] Reopen ${row.task.label}?`) : taskDoneRow(row.task, point === '>'))
    } else if (row.kind === 'agenda') {
      // agendaRow already enforces the measured pixel width. A second
      // character-count cap chopped the final `r` from "Take out of dryer"
      // even though the row still had physical room on the display.
      const selected = i === bodyCursor && cursor > 0
      const r = row.row
      if (selected && r.kind === 'do' && state.armedTaskId === `step:${r.choreId}:${r.stepId}`) {
        lines.push(clipToWidth(`>[?] ${isRunning(state, r) ? 'Finish' : 'Start'} ${r.step}?`))
      } else if (selected && r.kind === 'done' && state.armedTaskId === `undo:${r.runId}:${r.stepId}`) {
        lines.push(clipToWidth(`>[?] Undo ${r.step}?`))
      } else {
        lines.push(clipToWidth(
          `${point}${agendaRow(row.row, isRunning(state, row.row), agendaLiveClock(state, row.row))}`,
          568,
        ))
      }
    }
  }

  lines.push(planTip(state, rows, cursor))

  return assemble(lines, config.maxChars, config.maxLines)
}

export function dayDraftReviewRows(item: DayDraftItem): Array<{ text: string; action?: 'toggle' | 'label' | 'note' | 'reparse' | 'back' }> {
  const details = [
    ...wrap(`Label: ${item.label}${item.fromStep ? ` / ${item.fromStep}` : ''}`, LINE_CHARS - 2),
    ...wrap(`Heard: ${item.source || 'original words unavailable'}`, LINE_CHARS - 2),
    ...(item.uncertain ? ['Needs review: unclear phrase'] : []),
    ...(item.conflict ? wrap(`Already on Home: ${item.conflict}`, LINE_CHARS - 2) : []),
    ...(item.note ? wrap(`Note: ${item.note}`, LINE_CHARS - 2) : []),
  ]
  return [
    ...details.map(text => ({ text })),
    { text: item.include === false ? 'Include this row' : 'Exclude this row', action: 'toggle' },
    { text: 'Say full corrected label', action: 'label' },
    { text: 'Say note for this row', action: 'note' },
    { text: 'Reparse original words', action: 'reparse' },
    { text: 'Back to proposal', action: 'back' },
  ]
}

function renderDayStart(
  state: UiState,
  phase: 'recording' | 'reviewing' | 'draft' | 'row' | 'failed',
  scrollBack = 0,
  message = '',
  cursor = 0,
  itemId?: string,
): string {
  if (phase === 'row') {
    const item = state.plan?.day?.draft?.items.find(row => row.id === itemId)
    if (!item) return assemble(['REVIEW TODAY', 'Row unavailable'], config.maxChars, config.maxLines)
    const rows = dayDraftReviewRows(item)
    const room = Math.max(1, config.maxLines - 2)
    const start = Math.max(0, Math.min(cursor, rows.length - room))
    return assemble([
      message ? clipToWidth(`! ${message}`) : clockLine(state),
      `REVIEW ROW ${item.include === false ? 'excluded' : 'kept'}`,
      ...rows.slice(start, start + room).map((row, index) => clipToWidth(`${start + index === cursor ? '>' : ' '}${row.text}`)),
    ], config.maxChars, config.maxLines)
  }
  if (phase === 'draft') {
    const draft = state.plan?.day?.draft
    const items = draft?.items ?? []
    const rows = [
      ...items.map(item => `${item.include === false ? '[ ]' : '[x]'} ${item.label}${item.fromStep ? ` / ${item.fromStep}` : ''}`),
      'Add recording',
      'Build again',
      'Use this list',
    ]
    const selected = Math.max(0, Math.min(rows.length - 1, cursor))
    const room = Math.max(1, config.maxLines - 3)
    const start = Math.max(0, Math.min(selected, rows.length - room))
    const shown = rows.slice(start, start + room).map((line, index) => {
      const rowIndex = start + index
      const armed =
        (rowIndex === items.length + 1 && state.armedTaskId === 'day-draft-restart') ||
        (rowIndex === items.length + 2 && state.armedTaskId === 'day-draft-commit')
      return clipToWidth(`${rowIndex === selected ? '>' : ' '}${armed ? '[?] ' : ''}${line}`)
    })
    const kept = items.filter(item => item.include !== false).length
    return assemble(
      [
        message ? clipToWidth(`! ${message}`) : clockLine(state),
        `REVIEW TODAY  ${kept}/${items.length} kept`,
        ...shown,
        selected < items.length ? 'click to inspect row' : selected === items.length ? 'click to record more'
          : selected === items.length + 1 ? 'start today\'s review over' : 'add kept work to your list',
      ],
      config.maxChars,
      config.maxLines,
    )
  }

  const heard = (state.coachSession?.recentSegments ?? [])
    .flatMap(segment => wrap(`> ${segment.text}`, LINE_CHARS))
  const footer = phase === 'recording'
    ? 'click to stop and review'
    : phase === 'reviewing'
      ? 'click to build today'
      : 'click to try Start Day again'
  const room = Math.max(1, config.maxLines - 3)
  const maxScroll = Math.max(0, heard.length - room)
  const back = Math.max(0, Math.min(maxScroll, scrollBack))
  const end = heard.length - back
  const shown = heard.slice(Math.max(0, end - room), end)
  return assemble(
    [
      clockLine(state),
      `START DAY  ${phase === 'recording' ? 'REC' : phase === 'reviewing' ? 'REVIEW' : 'TRY AGAIN'}`,
      ...(phase === 'failed' ? wrap(message || 'Nothing heard. Try the walk again.', LINE_CHARS) : shown.length ? shown : ['Walk the house. Name every chore for today.']),
      footer,
    ],
    config.maxChars,
    config.maxLines,
  )
}

/**
 * One task, opened.
 *
 * Completion and voice actions lead; notes remain readable below them.
 */
export type TaskDetailRow =
  | { kind: 'noteline'; text: string; first: boolean }
  | { kind: 'space' }
  | { kind: 'listen' }
  | { kind: 'done' }
  | { kind: 'later' }

export function taskDetailRows(state: UiState, taskId: string): TaskDetailRow[] {
    const task = findTask(state, taskId)
  if (!task) return []

  // Done, or done with a dated step still to come (v0.170.0 follow-ups).
  const rows: TaskDetailRow[] = [{ kind: 'done' }, { kind: 'later' }, { kind: 'listen' }]
  if (task.notes?.length) rows.push({ kind: 'space' })
  for (const note of task.notes ?? []) {
    // Two characters of indent on continuation lines so a three-line note
    // still reads as one note rather than three.
    wrap(note.text, LINE_CHARS - 2).forEach((line, i) => {
      rows.push({ kind: 'noteline', text: line, first: i === 0 })
    })
  }
  return rows
}

export function findTask(state: UiState, taskId: string): TaskRow | undefined {
  return state.plan?.tasks?.find(t => t.taskId === taskId)
}

/** "today" / "tomorrow" / "in 5d" / "2d late". */
export function followupWhen(daysLeft: number): string {
  if (daysLeft === 0) return 'today'
  if (daysLeft === 1) return 'tomorrow'
  return daysLeft < 0 ? `${-daysLeft}d late` : `in ${daysLeft}d`
}

/** `YYYY-MM-DD` plus n calendar days (UTC arithmetic: no DST drift). */
export function dayPlus(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** "Wed Oct 28" for a `YYYY-MM-DD` day. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** A follow-up on Home: "[ ] Doctor appointment ... in 5d", when right-aligned. */
function followupRow(f: Followup, selected: boolean): string {
  const left = `${selected ? '>' : ' '}${f.done ? '[x]' : '[ ]'} `
  const when = `  ${followupWhen(f.daysLeft)}`
  let label = f.label
  while (label.length > 1 && measure(`${left}${label}${when}`) > USABLE_PX) label = label.slice(0, -1)
  let line = `${left}${label}`
  while (measure(`${line} ${when}`) <= USABLE_PX) line += ' '
  return clipToWidth(`${line}${when}`)
}

/**
 * Picking the follow-up day for "Done, follow up later". One scroll = one
 * day, starting a week out; click arms, click again saves (the task is ticked
 * and the follow-up kept in one request). The label defaults to
 * "Follow up: <task>" and is renamed on the phone.
 */
function renderFollowupDate(state: UiState, view: Extract<View, { kind: 'followupDate' }>): string {
  const task = findTask(state, view.taskId)
  const today = state.plan?.day?.day
  if (!task || !today) return assemble(['Follow up later', '', 'That task is gone.'], config.maxChars, config.maxLines)
  const due = dayPlus(today, view.days)
  const armed = state.armedTaskId === `followup-date:${view.taskId}`
  const lines = [
    clipToWidth(task.label),
    'Done now - follow up on:',
    '',
    clipToWidth(`${armed ? '>[?] Save ' : '>    '}${dayLabel(due)}  (${followupWhen(view.days)})`),
    '',
    armed ? 'Click again to save' : 'scroll: day earlier / later - click to save',
    'On Home 7 days before; phone reminder on the day',
  ]
  return assemble(lines, config.maxChars, config.maxLines)
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

  const win = windowFollow(cursor, rows.length, roomBelow(lines), state.scrollTop)
  for (let i = win.start; i < win.end; i += 1) {
    const row = rows[i]
    const point = i === cursor ? '>' : ' '
    if (row.kind === 'space') lines.push('')
    else if (row.kind === 'listen') {
      const live = state.coachSession?.active
      const stoppedLabel = task.needsPlan ? 'Build plan by voice' : 'Add a note by voice'
      lines.push(clip(`${point}${live ? '[*] Stop listening' : `[~] ${stoppedLabel}`}`, LINE_CHARS))
    } else if (row.kind === 'done') {
      const armed = state.armedTaskId === taskId
      lines.push(clip(`${point}${armed ? '[?] Confirm task done?' : '[ ] Mark done'}`, LINE_CHARS))
    } else if (row.kind === 'later') {
      lines.push(clip(`${point}[>] Done, follow up later`, LINE_CHARS))
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
  const room = listenTranscriptRoom(state)
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

function listenSummaryLines(session: CoachSessionSummary | null, cue: CoachCue | null): string[] {
  const rows: string[] = []
  // A timely interjection gets the first row, but no longer replaces the
  // conversation compass. The whole point of the compass is surviving the
  // tangent that produced the interjection.
  const cueText = cue && (!session || cue.createdAt >= session.startedAt)
    ? cue.lines?.join(' ').replace(/\s+/g, ' ').trim()
    : ''
  if (cueText) rows.push(clipToWidth(`AI! ${cueText}`))

  const notes = session?.runningNote?.lines ?? []
  const ordered = cueText
    ? [
        notes.find(line => /^Thread\s*:/i.test(line)),
        notes.find(line => /^Hold\s*:/i.test(line)),
        notes.find(line => /^Now\s*:/i.test(line)),
      ]
    : notes
  for (const note of ordered) {
    const clean = note?.replace(/\s+/g, ' ').trim()
    if (!clean || rows.some(row => row.toLowerCase() === clean.toLowerCase())) continue
    rows.push(clipToWidth(clean))
    if (rows.length >= 3) break
  }

  if (rows.length === 0) {
    const status = session?.aiState?.status
    if (status === 'error') rows.push('Summary unavailable - still recording')
    else if (status === 'thinking') rows.push('Summary: updating...')
    else rows.push('Summary: listening for the thread...')
  }
  return rows.slice(0, 3)
}

function listenTranscriptRoom(state: UiState): number {
  if (config.listenDebug) return Math.max(1, config.maxLines - 3)
  const summaryRows = listenSummaryLines(state.coachSession ?? null, state.cue ?? null).length
  const footerRows = state.coachSession?.active && state.listenReviewing ? 1 : 0
  return Math.max(1, config.maxLines - 1 - summaryRows - footerRows)
}

function listenModeLabel(mode: CoachMode): string {
  if (mode.id === 'conversation') return 'Conversate'
  if (mode.id === 'listening') return 'Listen'
  if (mode.id === 'meeting') return 'Meeting'
  if (mode.id === 'notes') return 'Solo Notes'
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
    const armed = state.view.kind === 'cue' && state.view.startArmed === true
    lines.push(clockLine(state), ruleCentred('Listen mode', false), '')
    state.coachModes.forEach((mode, index) => {
      const point = cursor === index ? '>' : ' '
      const active = armed && cursor === index ? '[?]' : mode.id === state.coachModeId ? '[*]' : '[ ]'
      lines.push(clipToWidth(`${point}${active} ${listenModeLabel(mode)}`))
    })
    lines.push('', armed ? 'armed - click starts' : 'click arms mic')
    if (armed) lines.push('scroll/back cancels')
    return assemble(lines, config.maxChars, config.maxLines)
  }

  if (session?.active) {
    const reviewing = state.listenReviewing
    const a = state.audio ?? { open: false, frames: 0, chunks: 0, sent: 0, rejected: 0, lastRms: 0, kind: '-', raw: 0, error: null }
    const mic = !a.open ? 'CLOSED' : a.sent > 0 ? 'MIC*' : a.frames > 0 ? 'MIC.' : 'MIC?'
    if (listenDebug) {
      lines.push(
        clipToWidth(`${reviewing ? 'REVIEW' : mic}  ${clip(session.modeName, 14)}  ${session.segmentCount} lines`),
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
    } else {
      const rewind = scrollBack > 0 ? `  ^${scrollBack}` : ''
      lines.push(clipToWidth(`${reviewing ? 'REVIEW' : 'LISTEN'}  ${clip(session.modeName, 12)}  ${session.segmentCount} lines  ${reviewing ? 'STOP' : mic}${rewind}`))
    }
  } else {
    // Stopped is a screen you can act on, not a dead end. Listen from the menu
    // brings you here without recording, so this line has to say how to arm it.
    const stt = state.snapshot?.stt
    const armed = state.view.kind === 'cue' && state.view.startArmed === true
    const lines0 = [armed ? 'READY? click again starts' : 'STOPPED Listen - click arms']
    if (armed) lines0.push('scroll/back cancels')
    if (listenDebug && stt) lines0.push('', clipToWidth(`stt ${stt.provider}${stt.configured ? '' : ' UNSET'}  ok ${stt.ok}  empty ${stt.empty}  fail ${stt.failed}`))
    if (!cue && !session?.recentSegments?.length) return assemble(lines0, config.maxChars, config.maxLines)
    lines.push(...lines0)
  }

  if (!listenDebug) {
    lines.push(...listenSummaryLines(session ?? null, cue ?? null))
  } else if (cue) {
    lines.push('')
    for (const line of cue.lines) {
      for (const wrapped of wrap(line, LINE_CHARS)) lines.push(wrapped)
    }
  }

  const segments = session?.recentSegments ?? []
  const reviewFooter = session?.active && state.listenReviewing ? 'click saves - back saves' : null
  if (segments.length > 0) {
    const room = Math.max(0, config.maxLines - lines.length - (reviewFooter ? 1 : 0))
    if (room <= 0) {
      if (reviewFooter) lines.push(clipToWidth(reviewFooter))
      return assemble(lines, config.maxChars, config.maxLines)
    }

    // Wrap everything first, then window over the wrapped lines. Windowing
    // over segments and wrapping after means one long sentence silently eats
    // the whole screen and the scroll position stops meaning anything.
    const all = transcriptLines(segments)

    for (const line of transcriptWindow(all, room, scrollBack)) lines.push(line)
    if (reviewFooter) lines.push(clipToWidth(reviewFooter))
  } else if (reviewFooter) {
    lines.push('', 'No transcript yet', clipToWidth(reviewFooter))
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

const ASSISTANT_PROVIDERS = chatText.PROVIDERS
const ASSISTANT_NATIVE_ROWS = 10

function assistantMessageLines(chat: AssistantChat | null, provider: AssistantProvider): string[] {
  return chatText.passages(chat, provider).flatMap(({ prefix, text }) => {
    const lines = wrap(text, Math.max(8, LINE_CHARS - prefix.length))
    return lines.map((line, index) => `${index === 0 ? prefix : ' '.repeat(prefix.length)}${line}`)
  })
}

export const assistantLatestReplyId = chatText.latestReplyId

export function assistantViewAfterRefresh(
  view: Extract<View, { kind: 'assistant'; phase: 'chat' }>,
  chat: AssistantChat,
): void {
  const replyId = assistantLatestReplyId(chat)
  if (replyId !== null && replyId !== view.replyId) view.scroll = 0
  view.replyId = replyId
}

function assistantIsReady(state: UiState, provider: AssistantProvider, chat: AssistantChat | null): boolean | null {
  if (chat) return chat.ready
  const ready = state.snapshot?.assistant?.[provider]
  return typeof ready === 'boolean' ? ready : null
}

function assistantStatusBadge(state: UiState, provider: AssistantProvider, chat: AssistantChat | null): string {
  return chatText.statusBadge(chat, assistantIsReady(state, provider, chat))
}

function assistantNowText(state: UiState, provider: AssistantProvider, chat: AssistantChat | null): string {
  return chatText.nowText(chat, assistantIsReady(state, provider, chat))
}

function assistantTurn(state: UiState): chatText.TurnState {
  return {
    recording: state.assistantRecording,
    reviewing: state.assistantReviewing,
    sending: state.assistantSending,
    error: state.error,
    armed: state.view.kind === 'assistant' && state.view.phase === 'chat'
      && state.armedTaskId === `assistant-record:${state.view.provider}`,
  }
}

function assistantProviderRows(
  state: UiState,
  provider: { id: AssistantProvider; label: string },
  selected: boolean,
): string {
  const chat = state.assistantThreads[provider.id] ?? null
  const point = selected ? '>' : ' '
  const status = chatText.pickerStatus(assistantStatusBadge(state, provider.id, chat))
  return clipToWidth(`${point}${provider.label}  ${status}`)
}

function assistantFooter(state: UiState): string | null {
  return chatText.footerText(assistantTurn(state))
}

export function assistantCaptureHasWords(session: CoachSessionSummary | null): boolean {
  return Boolean(session?.recentSegments.some(segment => segment.text.trim()))
}

function assistantContentRoom(state: UiState): number {
  const rows = Math.min(config.maxLines, ASSISTANT_NATIVE_ROWS)
  return Math.max(1, rows - 1 - (assistantFooter(state) ? 1 : 0))
}

function assistantLiveTranscriptLines(state: UiState): string[] {
  const segments = state.coachSession?.recentSegments ?? []
  if (segments.length > 0) return transcriptLines(segments)
  if (state.assistantReviewing) return ['No transcript yet.']
  if (state.assistantRecording) return ['Recording...']
  return []
}

function assistantActiveContentLines(state: UiState, provider: AssistantProvider): string[] {
  if (state.assistantRecording || state.assistantReviewing) return assistantLiveTranscriptLines(state)

  const lines = assistantMessageLines(state.assistantChat, provider)
  if (lines.length > 0) return lines
  return [state.assistantChat?.busy ? assistantNowText(state, provider, state.assistantChat) : chatText.EMPTY_CHAT]
}

export function assistantScrollMax(state: UiState): number {
  if (state.view.kind !== 'assistant' || state.view.phase !== 'chat') return 0
  const room = assistantContentRoom(state)
  return Math.max(0, assistantActiveContentLines(state, state.view.provider).length - room)
}

export function assistantScrollBy(scroll: number, max: number, delta: number): number {
  return Math.max(0, Math.min(max, scroll + delta))
}

function renderAssistant(state: UiState): string {
  const view = state.view
  if (view.kind !== 'assistant') return ''
  if (view.phase === 'providers') {
    const lines = [clockLine(state), ruleCentred('Chat', false), '']
    ASSISTANT_PROVIDERS.forEach((provider, index) => {
      lines.push(assistantProviderRows(state, provider, view.cursor === index))
    })
    lines.push('', chatText.pickerHint())
    return assemble(lines, config.maxChars, config.maxLines)
  }

  const label = chatText.label(view.provider)
  const status = chatText.headerStatus(assistantTurn(state), assistantStatusBadge(state, view.provider, state.assistantChat))
  const footer = assistantFooter(state)
  const room = assistantContentRoom(state)
  const content = assistantActiveContentLines(state, view.provider)

  const scroll = Math.max(0, Math.min(assistantScrollMax(state), view.scroll ?? 0))
  const window = content.slice(scroll, scroll + room)
  const scrollMark = scroll > 0 ? ` ^${scroll}` : ''
  return assemble(
    [
      clipToWidth(`${label} ${status}${scrollMark}`),
      ...window,
      ...(footer ? [clipToWidth(footer)] : []),
    ],
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
    case 'followupDate':
      return renderFollowupDate(state, state.view)
    case 'chores':
      return renderChores(state, state.view.cursor)
    case 'notes':
      return renderNotes(state, state.view.cursor)
    case 'capture':
      return renderCapture(state, state.view.cursor)
    case 'review':
      return renderSpokenReview(state, state.view)
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
    case 'daystart':
      return renderDayStart(state, state.view.phase, state.view.scroll ?? 0, state.view.message, state.view.cursor ?? 0, state.view.itemId)
    case 'cue':
      return renderCue(state, state.view.scroll ?? 0)
    case 'assistant':
      return renderAssistant(state)
    case 'timerReset':
      return renderTimerReset(state)
    case 'pong':
      return state.pong ? renderPong(state.pong) : 'PONG\n\nloading...'
    case 'fonttest':
      return renderFontTest(state.view.page)
    case 'inbox':
      return renderInbox(state, state.view.group, state.view.cursor)
  }
}
