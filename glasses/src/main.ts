import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  StartUpPageCreateResult,
  validateEvenHubPageContainer,
  formatEvenHubPageContainerValidationError,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'

import { config } from './config'
import {
  beginStep,
  resetStep,
  checkItem,
  completeInboxItem,
  completeTask,
  fetchCoachCue,
  fetchPlan,
  fetchSnapshot,
  startChecklist,
} from './api'
import { loadSnapshot, saveSnapshot } from './storage'
import {
  findRun,
  indexRows,
  planRows,
  taskDetailRows,
  inboxItems,
  otherSpace,
  render,
  startable,
  type UiState,
  type View,
} from './render'
import { newGame, nudge, serve, tick as pongTick } from './pong'

/**
 * Ops Board — a check-on-demand view of building metrics on the Even G2.
 *
 *   index view -> one row per board, worst status first
 *   board view -> one row per metric, paginated
 *
 * Input (a single event-capturing text container receives everything):
 *   scroll up/down   move the cursor (index) / change page (board)
 *   click            open the selected board / next page
 *   double-click     back to index; from the index, the system exit dialog
 *   tap+long-press   contextual menu
 *
 * Every screen is drawn by rewriting one text container with
 * textContainerUpgrade, which is flicker-free and leaves the contextual menu
 * intact. rebuildPageContainer is never called: it would clear the menu and
 * flash the display on every navigation. That is also why the board index is a
 * text container rather than a native list — lists cannot be updated in place,
 * so a 15-second poll would mean a full rebuild every 15 seconds.
 */

const CONTAINER_ID = 1
const CONTAINER_NAME = 'board'

const MENU = {
  SWITCH: 1,
  REFRESH: 2,
  FITS: 3,
  TOGGLE_FILTER: 4,
  PONG: 5,
  LISTS: 6,
  DIAG: 7,
  BACK: 8,
  COACH: 11,
  START: 10,
  EXIT: 9,
} as const

// Seeded from cache so the first paint has real content. `fromCache` keeps it
// honest on screen until a live fetch lands.
const cached = loadSnapshot()

/**
 * Reopen where you left off.
 *
 * There is no picker screen: a gate between launching and seeing your list is
 * a step every single time for a choice that changes maybe twice a day.
 */
function lastSpace(): 'ops' | 'life' {
  try {
    return localStorage.getItem('opsboard.space') === 'life' ? 'life' : 'ops'
  } catch {
    return 'ops'
  }
}

const state: UiState = {
  view: { kind: 'index', cursor: 0 },
  snapshot: cached,
  error: null,
  loading: cached === null,
  lastOkAt: null,
  fromCache: cached !== null,
  alertsOnly: false,
  plan: null,
  planLoading: false,
  cue: null,
  cueReturn: null,
  pong: null,
  events: 0,
  lastEvent: '-',
  // Off. It did its job finding the sysEvent bug; leaving it on replaces the
  // clock with debug output on every screen.
  diagnostics: false,
  space: lastSpace(),
  scrollTop: 0,
  armedTaskId: null,
}

const bridge = await waitForEvenAppBridge()
let lastInputAt = Date.now()

// ---- rendering -------------------------------------------------------------

async function paint(): Promise<void> {
  try {
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        content: render(state),
      }),
    )
  } catch (err) {
    // A failed paint must never take the app down; the next poll repaints.
    // Recorded so a silent upgrade failure is visible on the next successful
    // paint rather than looking like dead input.
    paintErrors += 1
    console.error('[paint]', err)
  }
}

let paintErrors = 0
let inFlight = false

async function refresh(): Promise<void> {
  // The poll timer and a menu Refresh can land together; a second concurrent
  // fetch would only race to write the same state.
  if (inFlight) return
  inFlight = true
  try {
    const result = await fetchSnapshot()
    if (result.ok) {
      state.snapshot = result.snapshot
      state.error = null
      state.lastOkAt = Date.now()
      state.fromCache = false
      saveSnapshot(result.snapshot)
      clampCursor()
    } else {
      // Keep the last good snapshot on screen and flag the header instead of
      // blanking: aging data that is visibly marked as aging beats no data.
      state.error = result.error
    }
    state.loading = false
    // Keep polling while the game is up — you want current data the moment
    // you quit — but do not repaint over the field.
    if (state.view.kind !== 'pong') await paint()
  } finally {
    inFlight = false
  }
}

function copyView(view: View): View {
  return { ...view } as View
}

function homeView(): View {
  return state.space === 'life' ? { kind: 'plan', cursor: 0 } : { kind: 'index', cursor: 0 }
}

function dismissCue(): void {
  state.view = state.cueReturn ? copyView(state.cueReturn) : homeView()
  state.cueReturn = null
  clampCursor()
}

function canAutoRefreshCue(): boolean {
  if (!config.autoCue || state.space !== 'ops' || state.planLoading) return false
  if (Date.now() - lastInputAt < config.cueIdleMs) return false
  return state.view.kind === 'index' || state.view.kind === 'cue'
}

async function refreshCoachCue(auto = false): Promise<void> {
  if (auto && !canAutoRefreshCue()) return

  const result = await fetchCoachCue(state.space, state.cue?.id ?? null)
  if (!result.ok) return

  const changed = !state.cue || state.cue.id !== result.cue.id
  state.cue = result.cue

  if (state.view.kind === 'cue' || (!auto && state.view.kind === 'index')) {
    await paint()
    return
  }
  if (auto && changed && canAutoRefreshCue()) await paint()
}

async function openCoachCue(): Promise<void> {
  await refreshCoachCue(false)
  state.cueReturn = state.view.kind === 'cue' ? state.cueReturn : copyView(state.view)
  state.view = { kind: 'cue' }
  state.scrollTop = 0
  await paint()
}

// ---- navigation ------------------------------------------------------------

function rowCount(): number {
  switch (state.view.kind) {
    case 'index':
      return indexRows(state).length
    case 'board': {
      const { boardId } = state.view
      return state.snapshot?.boards.find(b => b.id === boardId)?.metrics.length ?? 0
    }
    case 'plan':
      // planRows already includes the section separator.
      return planRows(state).length
    case 'task':
      return taskDetailRows(state, state.view.taskId).length
    case 'checklist':
      return findRun(state, state.view.runId)?.items.length ?? 0
    case 'picker':
      return startable(state).length
    case 'inbox':
      return inboxItems(state, state.view.group).length
    case 'cue':
    case 'pong':
    case 'fonttest':
      return 0
  }
}

function clampCursor(): void {
  const view = state.view
  if (view.kind === 'pong' || view.kind === 'fonttest' || view.kind === 'cue') return
  const count = rowCount()
  view.cursor = count === 0 ? 0 : Math.min(view.cursor, count - 1)
  followCursor()
}

/**
 * Slide the window so the cursor stays visible, moving one row at a time.
 * Called after any cursor change; a no-op while the cursor is already on
 * screen, which is what stops the view drifting under you.
 */
function followCursor(): void {
  const view = state.view
  if (!('cursor' in view)) return

  const size = view.kind === 'plan' ? config.rowsPerPage - 1 : config.rowsPerPage
  const total = rowCount()

  if (view.cursor < state.scrollTop) state.scrollTop = view.cursor
  else if (view.cursor >= state.scrollTop + size) state.scrollTop = view.cursor - size + 1

  state.scrollTop = Math.max(0, Math.min(state.scrollTop, Math.max(0, total - size)))
}

function move(delta: number): void {
  // Bound to a local so TypeScript can narrow the union; every branch mutates
  // the same object state.view already points at.
  const view = state.view

  if (view.kind === 'fonttest') {
    view.page = (view.page + 1) % 5
    return
  }

  if (view.kind === 'cue') {
    dismissCue()
    return
  }

  if (view.kind === 'pong') {
    // Scroll is the only continuous-ish input available, so it drives the
    // paddle directly rather than moving a cursor.
    if (state.pong) state.pong = nudge(state.pong, delta)
    return
  }

  const count = rowCount()
  if (count === 0) return

  // Stop at the ends rather than wrapping. Wrapping made sense when a list was
  // four rows; on a forty-row list it means one flick at the top throws you to
  // the bottom of page ten with no idea how you got there.
  let next = Math.max(0, Math.min(count - 1, view.cursor + delta))

  // Step over the blank between the tasks and the list. Landing on it would
  // mean one flick out of every list doing nothing at all.
  if (view.kind === 'plan' || view.kind === 'task') {
    const rows: Array<{ kind: string }> =
      view.kind === 'plan' ? planRows(state) : taskDetailRows(state, view.taskId)
    const step = delta >= 0 ? 1 : -1
    while (rows[next]?.kind === 'space' && next > 0 && next < count - 1) next += step
    if (rows[next]?.kind === 'space') next = view.cursor
  }

  view.cursor = next
  // Moving off a row cancels its pending confirm. An armed task that stayed
  // armed while you scrolled away would fire on the next tap somewhere else.
  state.armedTaskId = null
  followCursor()
}

/**
 * Toggle a checklist item.
 *
 * Applied locally first so the tick appears under your finger, then reconciled
 * against what the server actually recorded. If the write fails the local
 * change is rolled back rather than left sitting there looking saved — an item
 * you believe is ticked but which never persisted is the one failure this
 * feature cannot afford.
 */
async function toggle(runId: string, itemId: string): Promise<void> {
  const run = findRun(state, runId)
  const item = run?.items.find(i => i.id === itemId)
  if (!run || !item) return

  const previous = { done: item.done, at: item.at }
  const next = !item.done

  item.done = next
  item.at = next ? Date.now() : null
  run.done += next ? 1 : -1
  run.complete = run.done === run.total

  // Checking something advances to the next thing still outstanding, so a set
  // of rounds is click-click-click rather than click-scroll-click-scroll.
  if (next && state.view.kind === 'checklist') {
    const from = run.items.findIndex(i => i.id === itemId)
    const ahead = run.items.findIndex((i, idx) => idx > from && !i.done)
    const anywhere = run.items.findIndex(i => !i.done)
    const target = ahead !== -1 ? ahead : anywhere
    if (target !== -1) state.view.cursor = target
  }

  await paint()

  const result = await checkItem(runId, itemId, next)
  if (result.ok) {
    if (state.snapshot) state.snapshot.checklists = result.checklists
    state.error = null

    // Ticking one step means you have arrived at the next: start its clock,
    // and arm it if it is a wait.
    const updated = findRun(state, runId)
    if (next && updated?.currentItemId) {
      const began = await beginStep(runId, updated.currentItemId)
      if (began.ok && state.snapshot) state.snapshot.checklists = began.checklists
    }
  } else {
    item.done = previous.done
    item.at = previous.at
    run.done += next ? -1 : 1
    run.complete = run.done === run.total
    state.error = result.error
  }
  await paint()
}

/**
 * Fetch a block plan. The scheduling maths lives on the server so it can use
 * real medians and whatever is already running — the glasses only draw it.
 */
/**
 * Move between Ops and Life.
 *
 * Life lands on the running order rather than its index — that is the screen
 * that answers "what now", and the lists are for going and looking at
 * something specific. Ops lands on its index, where the boards are.
 */
async function switchSpace(): Promise<void> {
  state.space = otherSpace(state.space)
  state.cue = null
  try {
    localStorage.setItem('opsboard.space', state.space)
  } catch {
    // A blocked store just means it opens on Ops next time.
  }

  if (state.space === 'life') {
    await openPlan()
    return
  }

  state.view = { kind: 'index', cursor: 0 }
  state.scrollTop = 0
  clampCursor()
  await refreshCoachCue(false)
  await paint()
}

async function openPlan(): Promise<void> {
  state.view = { kind: 'plan', cursor: 0 }
  state.scrollTop = 0
  state.planLoading = true
  await paint()
  const result = await fetchPlan(state.space)
  state.planLoading = false
  if (result.ok) {
    state.plan = result.plan
    state.error = null
  } else {
    state.error = result.error
  }
  await paint()
}

/**
 * Open a checklist, starting a run for it if one is not already going.
 * Starting one is only ever a prelude to working through it, so this drops
 * straight into the list rather than back to the index.
 */
async function openChecklist(checklistId: string): Promise<void> {
  const existing = state.snapshot?.checklists?.active.find(r => r.checklistId === checklistId)
  if (existing) {
    await enterChecklist(existing.runId)
    return
  }

  const result = await startChecklist(checklistId)
  if (!result.ok) {
    state.error = result.error
    await paint()
    return
  }

  if (state.snapshot) state.snapshot.checklists = result.checklists
  state.error = null
  const opened = result.checklists.active.find(r => r.checklistId === checklistId)
  if (opened) await enterChecklist(opened.runId)
  else {
    state.view = { kind: 'index', cursor: 0 }
  state.scrollTop = 0
    await paint()
  }
}

/**
 * Enter a checklist at whatever step you are on.
 *
 * Deliberately starts nothing. Opening a list to look at the times should not
 * commit you to doing it — auto-starting on arrival meant glancing at Dishes
 * silently began a step and left it running for hours.
 *
 * Clicking a step is what starts it.
 */
async function enterChecklist(runId: string): Promise<void> {
  const run = findRun(state, runId)
  const index = run?.items.findIndex(i => i.id === run.currentItemId)
  state.view = { kind: 'checklist', runId, cursor: index && index > 0 ? index : 0 }
  state.scrollTop = 0
  await paint()
}

/**
 * The game runs on its own interval and paints itself.
 *
 * While it is on screen the ops poll keeps running in the background — the
 * server is still the source of truth and you want fresh data the moment you
 * quit — but it must not paint over the field, so `paint` is gated on the
 * current view rather than the poll being paused.
 */
let pongTimer: ReturnType<typeof setInterval> | null = null

/** Roughly 6 frames a second. Lower it if the glasses cannot keep up. */
const PONG_TICK_MS = 160

function stopPong(): void {
  if (pongTimer !== null) {
    clearInterval(pongTimer)
    pongTimer = null
  }
  state.pong = null
}

function startPong(): void {
  stopPong()
  state.pong = newGame()
  state.view = { kind: 'pong' }
  void paint()

  pongTimer = setInterval(() => {
    if (state.view.kind !== 'pong' || !state.pong) {
      stopPong()
      return
    }
    state.pong = pongTick(state.pong)
    void paint()
  }, PONG_TICK_MS)
}

async function activate(): Promise<void> {
  const view = state.view

  if (view.kind !== 'index') state.lastEvent = `clk:${view.kind}`

  if (view.kind === 'cue') {
    dismissCue()
    await paint()
    return
  }

  if (view.kind === 'board') {
    // Nothing to open on a metric; the cursor is for reading long boards.
    await paint()
    return
  }

  if (view.kind === 'checklist') {
    const run = findRun(state, view.runId)
    const item = run?.items[view.cursor]
    if (!run || !item) return

    // A step running implausibly long resets instead of completing — recording
    // five hours for loading a dishwasher would corrupt the median for good.
    if (item.suspect) {
      const result = await resetStep(run.runId, item.id)
      if (result.ok && state.snapshot) state.snapshot.checklists = result.checklists
      else state.error = 'could not reset'
      await paint()
      return
    }

    // First click on an unstarted `do` step starts its clock; the next
    // completes it. Two clicks, both deliberate.
    if (item.stepKind === 'do' && !item.done && !item.running) {
      const began = await beginStep(run.runId, item.id)
      if (began.ok && state.snapshot) state.snapshot.checklists = began.checklists
      await paint()
      return
    }

    await toggle(run.runId, item.id)
    return
  }

  if (view.kind === 'pong') {
    if (state.pong) state.pong = serve(state.pong)
    await paint()
    return
  }

  if (view.kind === 'fonttest') {
    view.page = (view.page + 1) % 5
    await paint()
    return
  }

  if (view.kind === 'task') {
    const row = taskDetailRows(state, view.taskId)[view.cursor]
    if (row?.kind !== 'done') {
      // A note line is for reading. Nothing happens.
      await paint()
      return
    }

    // Arm, then confirm. Ticking off "call dentist" you have not made is not
    // something you can undo from your face.
    if (state.armedTaskId !== view.taskId) {
      state.armedTaskId = view.taskId
      await paint()
      return
    }

    state.armedTaskId = null
    const ok = await completeTask(view.taskId)
    if (!ok) {
      state.error = 'could not save'
      await paint()
      return
    }
    await openPlan()
    return
  }

  if (view.kind === 'plan') {
    const row = planRows(state)[view.cursor]

    // Opening a row jumps to the chore it belongs to — the plan says what to
    // do next, so the obvious gesture is "take me there".
    if (row?.kind === 'agenda' && row.row.kind === 'do') {
      await openChecklist(row.row.choreId)
      return
    }

    if (row?.kind === 'task') {
      // Open it rather than tick it. A one-off usually has something you need
      // to know before you can start — which dentist, how far the drive is —
      // and completing straight from the list gave that nowhere to live.
      state.view = { kind: 'task', taskId: row.task.taskId, cursor: 0 }
      state.scrollTop = 0
      state.armedTaskId = null
      clampCursor()
      await paint()
      return
    }

    await paint()
    return
  }

  if (view.kind === 'picker') {
    const list = startable(state)[view.cursor]
    if (list) await openChecklist(list.id)
    return
  }

  if (view.kind === 'inbox') {
    const item = inboxItems(state, view.group)[view.cursor]
    if (!item) return
    // Optimistic removal would be wrong here: the list is shared, so the
    // server's view is the one that counts. Tick, then refetch.
    const ok = await completeInboxItem(item.id)
    if (!ok) state.error = 'could not save'
    await refresh()
    clampCursor()
    await paint()
    return
  }

  const rows = indexRows(state)
  const row = rows[view.cursor]

  // Trace the decision into the header. "norow" means the click arrived and
  // was handled, but there was nothing at the cursor to open — which looks
  // exactly like the click never happening.
  state.lastEvent = `clk:${view.cursor}/${rows.length}:${row?.kind ?? 'norow'}`

  if (!row) {
    await paint()
    return
  }

  switch (row.kind) {
    case 'inbox':
      state.view = { kind: 'inbox', group: row.group.name, cursor: 0 }
  state.scrollTop = 0
      break
    case 'check':
      await enterChecklist(row.run.runId)
      return
    case 'start':
      state.view = { kind: 'picker', cursor: 0 }
  state.scrollTop = 0
      break
    case 'plan':
      await openPlan()
      return
    case 'switch':
      // Same path as the menu item. This used to be a second copy of the
      // switch that always landed on the index, so coming into Life from the
      // Ops screen gave you an empty all-clear page instead of the running
      // order — the one screen Life exists for.
      await switchSpace()
      return
    case 'board':
      state.view = { kind: 'board', boardId: row.board.id, cursor: 0 }
  state.scrollTop = 0
      break
  }
  await paint()
}

async function back(): Promise<void> {
  if (state.view.kind === 'cue') {
    dismissCue()
    await paint()
    return
  }

  if (state.view.kind === 'pong') {
    stopPong()
    state.view = { kind: 'index', cursor: 0 }
  state.scrollTop = 0
    clampCursor()
    await refresh()
    return
  }

  // In Life the running order is home: it is what the screen is for, and there
  // is no index behind it any more. Going "back" from it means leaving.
  if (state.view.kind === 'task') {
    await openPlan()
    return
  }

  if (state.view.kind === 'plan' && state.space === 'life') {
    await bridge.shutDownPageContainer(1)
    return
  }

  if (state.view.kind !== 'index') {
    if (state.space === 'life') {
      await openPlan()
      return
    }
    state.view = { kind: 'index', cursor: 0 }
    state.scrollTop = 0
    clampCursor()
    await paint()
    return
  }
  // Root page: exitMode 1 raises the system confirmation dialog. Required —
  // exiting silently from the root page is an explicit QA rejection reason.
  await bridge.shutDownPageContainer(1)
}

async function onMenu(itemID: number): Promise<void> {
  switch (itemID) {
    case MENU.SWITCH:
      await switchSpace()
      break
    case MENU.REFRESH:
      await refresh()
      if (state.space === 'ops') await refreshCoachCue(false)
      break
    case MENU.FITS:
      await openPlan()
      break
    case MENU.TOGGLE_FILTER:
      state.alertsOnly = !state.alertsOnly
      if (
        state.view.kind !== 'board' &&
        state.view.kind !== 'plan' &&
        state.view.kind !== 'pong' &&
        state.view.kind !== 'fonttest' &&
        state.view.kind !== 'cue'
      ) {
        state.view.cursor = 0
      }
      clampCursor()
      await paint()
      break
    case MENU.PONG:
      startPong()
      break
    case MENU.LISTS:
      // The index: shared list, checklists you can start, the boards. Off the
      // Life screen and in here, because during ordinary use it says nothing
      // the running order has not already said.
      state.view = { kind: 'index', cursor: 0 }
      state.scrollTop = 0
      clampCursor()
      if (state.space === 'ops') await refreshCoachCue(false)
      await paint()
      break
    case MENU.COACH:
      await openCoachCue()
      break
    case MENU.DIAG:
      state.diagnostics = !state.diagnostics
      await paint()
      break
    case MENU.START:
      state.view = { kind: 'picker', cursor: 0 }
      state.scrollTop = 0
      clampCursor()
      await paint()
      break
    case MENU.BACK:
      await back()
      break
    case MENU.EXIT:
      await bridge.shutDownPageContainer(1)
      break
    default:
      break
  }
}

// ---- boot ------------------------------------------------------------------

const page = new CreateStartUpPageContainer({
  containerTotalNum: 1,
  textObject: [
    new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: CONTAINER_ID,
      containerName: CONTAINER_NAME,
      // Draw the cached view straight into the create call: one fewer round
      // trip before anything readable is on the glasses.
      content: render(state),
      isEventCapture: 1,
    }),
  ],
  menuObject: new MenuContainerProperty({
    menuItems: [
      // First item: the label cannot change after create, so it names both
      // ends rather than the destination.
      // Six. Everything cut was either a second way to do something that
      // already had one — Running order is where the space switch lands, All
      // boards is what double-tap does, Start a list belongs on the Lists
      // screen — or was only ever there for the build (Pong, Flagged only).
      // The handlers all survive, so putting one back is one line.
      new MenuItemProperty({ itemName: 'Ops / Life', itemID: MENU.SWITCH }),
      new MenuItemProperty({ itemName: 'Lists', itemID: MENU.LISTS }),
      new MenuItemProperty({ itemName: 'Coach', itemID: MENU.COACH }),
      new MenuItemProperty({ itemName: 'Refresh', itemID: MENU.REFRESH }),
      new MenuItemProperty({ itemName: 'Diagnostics', itemID: MENU.DIAG }),
    ],
  }),
})

// Catch menu/z-order/brightness violations here rather than as a silent no-op
// on the glasses.
const validation = validateEvenHubPageContainer(page)
if (!validation.valid) {
  console.error('[boot]', formatEvenHubPageContainerValidationError(validation))
}

const createResult = await bridge.createStartUpPageContainer(page)
if (createResult !== StartUpPageCreateResult.success) {
  console.error('[boot] createStartUpPageContainer:', StartUpPageCreateResult[createResult])
}

/**
 * Coerce whatever the host sent into an OsEventTypeList.
 *
 * Seen or plausible: a number, the enum name, a short name, a numeric string,
 * or nothing at all on a plain tap. Anything unrecognised returns undefined and
 * is handled as "something arrived, do not act on it" rather than silently
 * dropped.
 */
function normaliseEventType(raw: unknown): OsEventTypeList | undefined {
  if (raw === undefined || raw === null) return OsEventTypeList.CLICK_EVENT

  const parsed = OsEventTypeList.fromJson(raw)
  if (parsed !== undefined) return parsed

  // "0" and friends: a numeric string the SDK's parser does not take.
  const asNumber = Number(raw)
  if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber <= 10) {
    return asNumber as OsEventTypeList
  }
  return undefined
}

bridge.onEvenHubEvent((event: EvenHubEvent) => {
  // Keep logging the raw shape: this is how the sysEvent behaviour below was
  // found in the first place, and the next surprise will show up here too.
  console.log('[event]', JSON.stringify(event))

  state.events += 1
  lastInputAt = Date.now()

  // ---- contextual menu -------------------------------------------------
  const menuItemID = event.menuItemClickEvent?.itemID
  if (menuItemID !== undefined) {
    state.lastEvent = `menu${menuItemID}`
    void onMenu(menuItemID)
    return
  }

  const sysType = event.sysEvent?.eventType

  // ---- lifecycle -------------------------------------------------------
  // Handled before input, because these arrive on sysEvent too and must not
  // be mistaken for taps.
  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    state.lastEvent = 'fg-in'
    void refresh().then(() => refreshCoachCue(false))
    return
  }
  if (
    sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT ||
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT ||
    sysType === OsEventTypeList.IMU_DATA_REPORT
  ) {
    state.lastEvent = `sys${sysType}`
    return
  }

  /**
   * Input can arrive on any of the three carriers.
   *
   * On real hardware taps come through `sysEvent`, not `textEvent` — the
   * opposite of what the platform's own first-app sample shows. Reading only
   * `textEvent` meant every tap was received and discarded, which looks
   * exactly like the firmware sending nothing. Take whichever carrier is
   * present rather than betting on one.
   */
  const source = event.textEvent ?? event.listEvent ?? event.sysEvent
  if (!source) {
    state.lastEvent = 'none'
    return
  }

  const type = normaliseEventType(source.eventType)
  state.lastEvent = type === undefined ? `raw:${source.eventType}` : String(OsEventTypeList[type] ?? type)

  switch (type) {
    case OsEventTypeList.SCROLL_TOP_EVENT:
      move(-1)
      void paint()
      break

    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      move(1)
      void paint()
      break

    case OsEventTypeList.CLICK_EVENT:
      void activate()
      break

    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      void back()
      break

    case OsEventTypeList.LONG_PRESS_EVENT:
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
      // The OS raises its own contextual menu on this; nothing for us to do.
      break

    default:
      void paint()
      break
  }
})

bridge.onLaunchSource(source => console.log('[boot] launched from', source))

await refresh()
/**
 * Life opens on the running order.
 *
 * It is the screen that answers "what now, and how long" — the list views are
 * for going and looking at something specific. Ops still opens on its index,
 * where the boards are.
 */
if (state.space === 'life') {
  await openPlan()
} else {
  await refreshCoachCue(false)
}

/**
 * Poll while in the foreground.
 *
 * On Android the WebView can be suspended when backgrounded, which stops this
 * timer and may drop in-memory state. Nothing here is worth persisting — the
 * server holds the truth — so recovery is just: refetch on the way back in.
 */
setInterval(() => void refresh(), config.pollMs)
setInterval(() => void refreshCoachCue(true), config.cueMs)
