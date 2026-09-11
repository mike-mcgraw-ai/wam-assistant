import { config } from './config'
import { ALL_CLEAR } from './art'
import { renderPong, type PongState } from './pong'
import { renderFontTest } from './fonttest'

/** Injected by vite.config.ts from app.json; falls back when run under Node. */
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
import type {
  AgendaRow,
  BlockPlan,
  Board,
  ChecklistRun,
  CoachCue,
  InboxGroup,
  InboxItem,
  Snapshot,
  Space,
  StartableChecklist,
  TaskRow,
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
  wrap,
  mins,
  bar,
  clip,
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
  | { kind: 'task'; taskId: string; cursor: number }
  | { kind: 'cue' }
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
export type PlanRow =
  | { kind: 'task'; task: TaskRow }
  | { kind: 'space' }
  | { kind: 'agenda'; row: AgendaRow }

export function planRows(state: UiState): PlanRow[] {
  const plan = state.plan
  if (!plan) return []

  const tasks: PlanRow[] = (plan.tasks ?? []).map(task => ({ kind: 'task', task }))
  const agenda: PlanRow[] = plan.agenda.map(row => ({ kind: 'agenda', row }))
  const gap: PlanRow[] = tasks.length && agenda.length ? [{ kind: 'space' }] : []

  return [...tasks, ...gap, ...agenda]
}

/** Rows the cursor is allowed to stop on. */
export function selectable(row: PlanRow | undefined): boolean {
  return row !== undefined && row.kind !== 'space'
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

function aiWidgetLine(state: UiState): string | null {
  const cue = state.cue
  if (state.space !== 'ops' || !cue || cue.quiet) return null
  if (cue.expiresAt && Date.now() > cue.expiresAt + config.cueMs) return null

  const marker = cue.priority >= 4 ? '!' : cue.kind === 'ops' ? 'X' : '*'
  const body = cue.lines.find(Boolean)
  return clip(`${marker} AI ${cue.title}${body ? `: ${body}` : ''}`, LINE_CHARS)
}

function header(state: UiState, right: string): string {
  if (state.diagnostics) return diagHeader(state, right)
  return plainHeader(state, right)
}

/**
 * Header for first-run debugging: build version, event count, last event.
 *
 * The version is the important half — it is the only way to be certain the
 * build on your face is the one you just packed.
 */
function diagHeader(state: UiState, _right: string): string {
  return clip(`v${APP_VERSION} ${state.events}:${state.lastEvent}`, LINE_CHARS)
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
  return clip(`${dateLabel(now)}  ${time}`, LINE_CHARS)
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
export function spaceLine(state: UiState): string {
  const connection = state.fromCache
    ? '  ~CACHE'
    : state.error
      ? '  !NET'
      : state.lastOkAt && Date.now() - state.lastOkAt > config.pollMs * 3
        ? '  !OLD'
        : ''
  // Indented so it reads as a label over the block rather than as the first
  // row of it. The list starts directly underneath — a blank line here cost a
  // row out of nine and separated the label from the thing it labels.
  return clip(`   ${state.space === 'ops' ? 'OPS' : 'LIFE'}${connection}`, LINE_CHARS)
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
  const cue = aiWidgetLine(state)
  const visibleRows = cue ? config.rowsPerPage - 1 : config.rowsPerPage

  const win = windowFollow(cursor, rows.length, visibleRows, state.scrollTop)

  // One header row: date, time and which space. Back to text rather than an
  // image — at this size the image bought nothing over the firmware font, cost
  // more vertical space than it saved, and lagged a second behind a switch
  // while its bytes went over BLE.
  const lines: string[] = [clockLine(state), spaceLine(state)]
  if (cue) lines.push(cue)
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

  const win = windowFollow(cursor, run.items.length, config.rowsPerPage, state.scrollTop)
  const { start, end } = win
  const more = win.more ? `${win.atTop ? '' : '^'}${win.atEnd ? '' : 'v'}` : ''

  const lines = [
    header(
      state,
      `${clip(run.name, 11)} ${bar(run.done, run.total, 6)} ${run.done}/${run.total}${more ? ` ${more}` : ''}`,
    ),
  ]
  for (let i = start; i < end; i += 1) lines.push(checklistItemRow(run.items[i], i === cursor))

  // The only footer left in the app: a flagged row resets instead of ticking,
  // which is the one place the click does something you would not expect.
  if (run.items[cursor]?.suspect) lines.push('click resets this step')
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
function renderPlan(state: UiState, cursor: number): string {
  const plan = state.plan
  if (!plan) {
    return `WAM\n\n${state.planLoading ? 'Working it out...' : 'No plan yet.'}\n\ndbl-tap to go back`
  }

  const rows = planRows(state)
  if (rows.length <= 1) {
    return 'WAM\n\nNothing with known step times.\n\nAdd estimates in the config.'
  }

  const win = windowFollow(cursor, rows.length, config.rowsPerPage, state.scrollTop)

  // A blank under the clock as well. The header used to butt straight into the
  // first task and the whole screen read as one wall of characters; the list
  // is allowed to run onto a second page, so the line is affordable.
  const lines: string[] = [clockLine(state), spaceLine(state)]
  for (let i = win.start; i < win.end; i += 1) {
    const row = rows[i]
    const point = i === cursor ? '>' : ' '
    if (row.kind === 'space') {
      lines.push('')
    } else if (row.kind === 'task') {
      const armed = state.armedTaskId === row.task.taskId
      lines.push(clip(`${point}${taskRow(row.task, armed)}`, LINE_CHARS))
    } else if (row.kind === 'agenda') {
      lines.push(clip(`${point}${agendaRow(row.row)}`, LINE_CHARS))
    }
  }

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
    else if (row.kind === 'done') {
      const armed = state.armedTaskId === taskId
      lines.push(clip(`${point}${armed ? '[?] Really done?' : '[ ] Mark done'}`, LINE_CHARS))
    } else {
      lines.push(clip(`${point}${row.first ? '- ' : '  '}${row.text}`, LINE_CHARS))
    }
  }

  return assemble(lines, config.maxChars, config.maxLines)
}

function renderCue(state: UiState): string {
  const cue = state.cue
  if (!cue) return assemble([header(state, 'Coach'), '', 'No cue yet.'], config.maxChars, config.maxLines)

  const lines: string[] = [header(state, cue.title), '']
  for (const line of cue.lines) {
    for (const wrapped of wrap(line, LINE_CHARS)) lines.push(wrapped)
  }

  return assemble(lines, config.maxChars, config.maxLines)
}

/** Single entry point: UI state in, one string for the text container out. */
export function render(state: UiState): string {
  switch (state.view.kind) {
    case 'index':
      return renderIndex(state, state.view.cursor)
    case 'board':
      return renderBoard(state, state.view.boardId, state.view.cursor)
    case 'task':
      return renderTaskDetail(state, state.view.taskId, state.view.cursor)
    case 'checklist':
      return renderChecklist(state, state.view.runId, state.view.cursor)
    case 'picker':
      return renderPicker(state, state.view.cursor)
    case 'plan':
      return renderPlan(state, state.view.cursor)
    case 'cue':
      return renderCue(state)
    case 'pong':
      return state.pong ? renderPong(state.pong) : 'PONG\n\nloading...'
    case 'fonttest':
      return renderFontTest(state.view.page)
    case 'inbox':
      return renderInbox(state, state.view.group, state.view.cursor)
  }
}
