import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  StartUpPageCreateResult,
  validateEvenHubPageContainer,
  formatEvenHubPageContainerValidationError,
  AudioInputSource,
  AudioSpeakerRole,
  type EvenHubEvent,
  type AudioEvent,
} from '@evenrealities/even_hub_sdk'

import { config } from './config'
import { dashboardFrame, TILES, TILE_H, TILE_W, hashTile, listenFrame, splitTiles, textFrame } from './fullpanel'
import { listenBoard } from './listenboard'
import {
  activateCoachMode,
  beginStep,
  resetStep,
  checkItem,
  completeInboxItem,
  completeTask,
  deleteNote,
  discardCoachSession,
  fetchAssistantChat,
  fetchNoteTranscript,
  endCoachSession,
  fetchSessionSummary,
  fetchCoachCue,
  fetchCoachSession,
  fetchPlan,
  fetchSnapshot,
  sendCoachAudio,
  sendAssistantSession,
  startChecklist,
  finishChecklist,
  startCoachSession,
} from './api'
import { loadSnapshot, saveSnapshot } from './storage'
import {
  findRun,
  findNoteRow,
  indexRows,
  noteDetailActions,
  noteRows,
  captureRows,
  assistantScrollMax,
  noteTranscriptScrollMax,
  transcriptScrollMax,
  planRows,
  choreRows,
  taskDetailRows,
  inboxItems,
  otherSpace,
  render,
  startable,
  type UiState,
  type View,
} from './render'
import { newGame, nudge, serve, tick as pongTick } from './pong'
import { startRemoteInput } from './remoteinput'
import type { AssistantProvider } from './types'

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
// Four 288x144 tiles covering the whole 576x288 panel (v0.103.0 claim).
// Ordinary screens draw where the old centred bands sat; Listen uses all four.
const IMAGE_CONTAINER_IDS = [2, 3, 4, 5] as const
const IMAGE_CONTAINER_NAMES = ['tile-tl', 'tile-tr', 'tile-bl', 'tile-br'] as const
/** Dashboard content first; Listen's fast-changing transcript first. */
const DASHBOARD_TILE_SEND_ORDER = [0, 2, 1, 3]
const LISTEN_TILE_SEND_ORDER = [3, 0, 2, 1]
const CAPTURE_TASK_ID = 'captured-notes'

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
  LISTEN: 12,
  NOTES: 13,
  CHAT: 14,
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
  // Life by default. The running order is the screen this exists for, and it
  // is what you want on your face when you put them on without thinking.
  // With Ops sidelined there is only one space, whatever is remembered.
  if (!config.ops) return 'life'
  try {
    return localStorage.getItem('opsboard.space') === 'ops' ? 'ops' : 'life'
  } catch {
    return 'life'
  }
}

const state: UiState = {
  // Follow the remembered space from the first frame. This was a flat `index`,
  // so Life launched onto the index for as long as the first fetch took — the
  // screen with Ledger, "Start a list" and "The running order" on it, which is
  // exactly the screen Life is not supposed to have. openPlan() replaced it a
  // moment later, which made it read as a glitch rather than a wrong default.
  view: lastSpace() === 'life' ? { kind: 'plan', cursor: 0 } : { kind: 'index', cursor: 0 },
  snapshot: cached,
  error: null,
  loading: cached === null,
  lastOkAt: null,
  fromCache: cached !== null,
  alertsOnly: false,
  plan: null,
  planLoading: false,
  planError: null,
  cue: null,
  coachSession: null,
  coachModes: [],
  coachModeId: null,
  assistantChat: null,
  assistantThreads: {},
  assistantRecording: false,
  assistantReviewing: false,
  assistantSending: false,
  noteTranscript: null,
  cueReturn: null,
  pong: null,
  events: 0,
  lastEvent: '-',
  // On. It no longer replaces anything — it numbers the lines, which is how a
  // screen gets described from a walk without a screenshot.
  diagnostics: config.diagnostics,
  space: lastSpace(),
  scrollTop: 0,
  armedTaskId: null,
  stickyDone: new Set<string>(),
  armedNoteId: null,
  listenReviewing: false,
  foreground: true,
  lastAudioAt: null,
  audio: { open: false, frames: 0, chunks: 0, sent: 0, rejected: 0, lastRms: 0, kind: '-', raw: 0, error: null },
}

const bridge = await waitForEvenAppBridge()
let lastInputAt = Date.now()
let audioSessionId: string | null = null
let audioOpen = false
let audioFrames: Uint8Array[] = []
let audioBytes = 0
let audioChunkStartedAt = 0
let audioUploading = false
let audioLastRole = AudioSpeakerRole.Unknown
let audioLastDirection: number | null = null
let audioLogLastAt = 0

const ASSISTANT_PROVIDERS: AssistantProvider[] = ['chatgpt', 'claude']

// ---- rendering -------------------------------------------------------------

/**
 * Send the frame to the hub as well, for the mirror.
 *
 * Fire and forget, and deliberately unawaited: a slow or missing hub must
 * never delay what reaches the glasses. The mirror is a nicety; the display is
 * the product.
 */
/**
 * Which tiles each paint sent, and when each finished (ms from the first
 * send). Written to paint.log by the hub. Diagnostic for the tile-by-tile
 * rollout: tells "we sent four" apart from "we sent two, the glasses drew four".
 */
function paintLog(entry: Record<string, unknown>): void {
  void fetch(`${config.serverUrl}/paintlog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...entry, version: __APP_VERSION__ }),
  }).catch(() => {})
}

function mirror(content: string): void {
  void fetch(`${config.serverUrl}/screen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: content }),
  }).catch(() => {})
}

/**
 * Display asleep.
 *
 * Not an exit. Exiting would drop us back to the glasses OS, and getting back
 * in means digging the private build out of the phone's menu — so the app
 * stays running with nothing on the panel, and the next input brings it back.
 *
 * Kept out of UiState because no screen renders differently for it: sleep is
 * something paint() does instead of rendering, not a screen of its own.
 */
let asleep = false

/** Blank panel: no content, and the firmware's own fully-dim level. */
const SLEEP_CONTENT = ' '
const BRIGHT = 4
const DIM = 0
let compactFailures = 0
/** Hash of what each tile currently shows; null means "unknown, send it". */
let tileHashes: Array<number | null> = IMAGE_CONTAINER_IDS.map(() => null)
/** The event-capture text layer only needs blanking once, not every paint. */
let textLayerBlank = false
let painting = false
let repaintQueued = false

/** Move the clock out of the compact content; the right rail owns it now. */
function dashboardContent(content: string): string {
  const lines = content.split('\n')
  if (/\d{1,2}:\d{2}[ap]\s+v\d/i.test(lines[0] ?? '')) lines.shift()
  return lines.join('\n')
}

function timerClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const tail = String(seconds % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`
}

function dashboardTimers(now = Date.now()): Array<{ label: string; value: string; sortAt: number }> {
  const timers: Array<{ label: string; value: string; sortAt: number }> = []
  for (const run of state.snapshot?.checklists?.active ?? []) {
    if (run.complete || run.space !== state.space) continue
    for (const item of run.items) {
      if (item.done) continue
      if (item.stepKind === 'wait' && item.endsAt !== null) {
        const remaining = Math.ceil((item.endsAt - now) / 1000)
        timers.push({
          label: item.label,
          value: remaining >= 0 ? `${timerClock(remaining)} left` : `${timerClock(-remaining)} overdue`,
          sortAt: item.endsAt,
        })
      } else if (item.running && item.startedAt !== null) {
        timers.push({
          label: item.label,
          value: `${timerClock((now - item.startedAt) / 1000)} running`,
          sortAt: item.startedAt,
        })
      }
    }
  }
  return timers.sort((a, b) => a.sortAt - b.sortAt)
}

function dashboardRail() {
  const now = new Date()
  const hour24 = now.getHours()
  const hour = hour24 % 12 || 12
  const time = `${hour}:${String(now.getMinutes()).padStart(2, '0')} ${hour24 < 12 ? 'AM' : 'PM'}`
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase()
  const calendar = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase()
  const connection = state.fromCache ? 'CACHED' : state.error ? 'OFFLINE' : 'SYNCED'
  const status = state.coachSession?.active
    ? `MIC ACTIVE - ${state.coachSession.modeName}`
    : state.assistantRecording
      ? 'MIC ACTIVE - Assistant message'
      : state.space === 'life' ? 'Personal dashboard' : 'Operations dashboard'
  return {
    time,
    weekday,
    date: calendar,
    connection,
    status,
    version: `v${__APP_VERSION__}`,
    timers: dashboardTimers(now.getTime()),
  }
}

/**
 * One paint at a time. Four tile sends can take most of a second, and the 1 s
 * Listen loop would otherwise start a second paint in the middle of the first.
 * A paint asked for while one runs is folded into one more pass at the end.
 */
async function paint(): Promise<void> {
  if (painting) {
    repaintQueued = true
    return
  }
  painting = true
  try {
    do {
      repaintQueued = false
      await paintNow()
    } while (repaintQueued)
  } finally {
    painting = false
  }
}

async function paintNow(): Promise<void> {
  try {
    // Rendered once, used twice: the glasses and the mirror must never be
    // able to show different frames.
    const content = asleep ? SLEEP_CONTENT : render(state)
    // The mirror shows what the glasses show, sleep included — an iPad still
    // lit while the glasses are dark is two devices disagreeing about state.
    mirror(content)

    // The SDK's native text renderer has one fixed size. Draw the same frame
    // into a smaller centred image so it occupies less of the visual field,
    // while the full-screen text container remains available for ring input.
    // A failed image transfer falls through to native text for this frame, so
    // compact rendering can never turn a working screen into a blank one.
    if (compactFailures < 3) {
      const board = asleep ? null : listenBoard(state)
      const frame = asleep
        ? textFrame(content)
        : board
          ? listenFrame(board)
          : dashboardFrame(dashboardContent(content), dashboardRail())
      const tiles = splitTiles(frame)
      const updates = tiles.flatMap((tile, index) => {
        // Only tiles whose pixels changed are sent: each send is ~100 ms of
        // fixed cost, so an unchanged tile is pure waste.
        const hash = hashTile(tile)
        return tileHashes[index] === hash ? [] : [{ index, tile, hash }]
      })

      // The SDK has no multi-image transaction. Starting every changed tile
      // together gives the phone/firmware all four writes at once instead of
      // making the user watch this loop await each quadrant in turn. The
      // outer paint lock still prevents frames from overlapping.
      // Raw speech belongs to the bottom-right Listen tile, so it wins every
      // multi-tile race. Ordinary dashboard screens still send left content
      // before the slower-changing rail.
      const sendOrder = board ? LISTEN_TILE_SEND_ORDER : DASHBOARD_TILE_SEND_ORDER
      updates.sort((a, b) => sendOrder.indexOf(a.index) - sendOrder.indexOf(b.index))
      const sendStart = performance.now()
      const doneAt: number[] = []
      const results = await Promise.allSettled(
        updates.map(({ index, tile }, order) => bridge.updateImageRawData(
          new ImageRawDataUpdate({
            containerID: IMAGE_CONTAINER_IDS[index],
            containerName: IMAGE_CONTAINER_NAMES[index],
            imageData: tile,
          }),
        ).finally(() => { doneAt[order] = Math.round(performance.now() - sendStart) })),
      )
      if (updates.length > 0) {
        paintLog({
          view: state.view.kind,
          asleep,
          sent: updates.map(({ index }) => IMAGE_CONTAINER_NAMES[index]),
          doneMs: doneAt,
          failed: results.flatMap((result, resultIndex) =>
            result.status === 'fulfilled' && ImageRawDataUpdateResult.isSuccess(result.value)
              ? []
              : [IMAGE_CONTAINER_NAMES[updates[resultIndex].index]]),
        })
      }
      let compactOk = true
      results.forEach((result, resultIndex) => {
        const { index, hash } = updates[resultIndex]
        if (result.status === 'fulfilled' && ImageRawDataUpdateResult.isSuccess(result.value)) {
          tileHashes[index] = hash
          return
        }
        compactOk = false
        tileHashes[index] = null
        const reason = result.status === 'fulfilled' ? result.value : result.reason
        console.warn('[paint] tile image failed:', IMAGE_CONTAINER_NAMES[index], reason)
      })
      if (compactOk) {
        compactFailures = 0
        if (!textLayerBlank) {
          await bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: CONTAINER_ID,
              containerName: CONTAINER_NAME,
              content: SLEEP_CONTENT,
              textColor: DIM,
            }),
          )
          textLayerBlank = true
        }
        return
      }
      compactFailures += 1
    }

    textLayerBlank = false

    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        content,
        // Omitting this would keep whatever brightness the container has, so
        // it has to be set explicitly in both directions.
        textColor: asleep ? DIM : BRIGHT,
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

function clearArmedConfirms(): void {
  state.armedTaskId = null
  state.armedNoteId = null
  if (state.view.kind === 'cue') state.view.startArmed = false
}

async function sleepDisplay(): Promise<void> {
  if (asleep) return
  asleep = true
  // An armed confirm must not survive the nap. Waking and tapping once should
  // never complete something you armed before you put them down.
  clearArmedConfirms()
  await paint()
}

/**
 * Wake on any input, and swallow that input.
 *
 * The gesture that wakes the screen must not also do something on it: waking
 * into a tap that ticked off a step is how you lose trust in the thing.
 * Returns true when the event was spent waking up.
 */
async function wakeDisplay(): Promise<boolean> {
  if (!asleep) return false
  asleep = false
  await refresh()
  if (!inFlight) await paint()
  return true
}

async function refresh(): Promise<void> {
  // The poll timer and a menu Refresh can land together; a second concurrent
  // fetch would only race to write the same state.
  if (inFlight) return
  // Nothing to update while the OS owns the screen. The foreground-enter
  // handler calls this directly, so waking is still immediate.
  if (!state.foreground && state.view.kind !== 'pong') return
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
    if (state.view.kind === 'plan' || state.view.kind === 'notes' || state.view.kind === 'note') {
      const plan = await fetchPlan(state.space)
      if (plan.ok) {
        state.plan = plan.plan
        state.planError = null
      } else if (state.view.kind === 'plan') {
        state.planError = plan.error
      }
    }
    state.loading = false
    // Keep polling while the game is up — you want current data the moment
    // you quit — but do not repaint over the field. Asleep, keep fetching and
    // send nothing: a dark panel repainted every fifteen seconds is BLE spent
    // on a frame nobody can see.
    if (state.view.kind !== 'pong' && !asleep) await paint()
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

async function openNotes(cursor = 0): Promise<void> {
  state.noteTranscript = null
  state.view = { kind: 'notes', cursor }
  state.scrollTop = Math.max(0, cursor)
  const plan = await fetchPlan(state.space)
  if (plan.ok) state.plan = plan.plan
  else state.error = plan.error
  clampCursor()
  await paint()
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
  // Same rule as refresh(): an automatic cue poll while the OS has the screen
  // is work nobody can see. A deliberate Coach/Listen open still passes.
  if (auto && !state.foreground) return

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
  await refreshCoachSession()
  await refreshCoachCue(false)
  state.cueReturn = state.view.kind === 'cue' ? state.cueReturn : copyView(state.view)
  state.view = { kind: 'cue' }
  state.scrollTop = 0
  await paint()
}

async function refreshCoachSession(): Promise<void> {
  const result = await fetchCoachSession(state.space)
  if (result.ok) {
    state.coachSession = result.session
    state.coachModes = result.modes ?? state.coachModes
    state.coachModeId = result.mode.id
    if (!result.session?.active) state.listenReviewing = false
    if (!result.session && state.assistantReviewing) state.assistantReviewing = false
    if (result.cue && (!state.cue || result.cue.createdAt >= state.cue.createdAt)) state.cue = result.cue
    state.error = null
  } else {
    state.error = result.error
  }
}

function refreshTranscriptAfterChunk(): void {
  window.setTimeout(() => {
    if (state.view.kind !== 'cue' || !state.coachSession?.active || !state.foreground || asleep) return
    void refreshCoachSession().then(() => paint())
  }, Math.max(250, Math.min(1_500, Math.floor(config.listenPollMs * 0.7))))
}

function localCoachCue(title: string, lines: string[]): void {
  const now = Date.now()
  state.cue = {
    id: `local-${now.toString(36)}`,
    title,
    lines,
    kind: 'recap',
    priority: 0,
    quiet: false,
    createdAt: now,
    expiresAt: now + config.cueMs,
    nextAfterMs: config.cueMs,
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function audioRms(bytes: Uint8Array): number {
  let sum = 0
  let samples = 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
    const sample = view.getInt16(i, true)
    sum += sample * sample
    samples += 1
  }
  return samples ? Math.sqrt(sum / samples) : 0
}

async function startAudioCapture(sessionId: string): Promise<void> {
  audioFrames = []
  audioBytes = 0
  audioChunkStartedAt = 0
  audioSessionId = sessionId
  audioUploading = false

  const opened = await bridge.audioControl(true, AudioInputSource.Glasses).catch(err => {
    console.error('[audio] open', err)
    return false
  })
  audioOpen = opened === true
  state.audio = { open: audioOpen, frames: 0, chunks: 0, sent: 0, rejected: 0, lastRms: 0, kind: '-', raw: 0, error: audioOpen ? null : 'audioControl false' }
  if (!audioOpen) {
    localCoachCue('Mic did not open', ['Glasses audioControl returned false.'])
  }
}

async function stopAudioCapture(): Promise<void> {
  const sessionId = audioSessionId
  audioSessionId = null
  // A click can land while the previous chunk is still in flight. Wait for it
  // before flushing the tail; clearing the buffers immediately used to drop
  // the final few words of a voice turn at exactly the moment Send was tapped.
  for (let waited = 0; audioUploading && waited < 5_000; waited += 50) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (sessionId && audioFrames.length) await flushAudioChunk(sessionId, true)
  if (audioOpen) await bridge.audioControl(false).catch(() => false)
  audioOpen = false
  state.audio.open = false
  audioFrames = []
  audioBytes = 0
  audioChunkStartedAt = 0
  audioUploading = false
}

async function flushAudioChunk(sessionId = audioSessionId, force = false): Promise<void> {
  if (!sessionId || audioUploading || audioBytes === 0) return

  const elapsed = audioChunkStartedAt ? Date.now() - audioChunkStartedAt : 0
  if (!force && elapsed < config.audioChunkMs) return

  const combined = new Uint8Array(audioBytes)
  let offset = 0
  for (const frame of audioFrames) {
    combined.set(frame, offset)
    offset += frame.length
  }
  audioFrames = []
  audioBytes = 0
  audioChunkStartedAt = 0

  const rms = audioRms(combined)
  state.audio.lastRms = Math.round(rms)
  state.audio.chunks += 1
  if (rms < config.audioMinRms) {
    // Dropped as silence. Counted, because a threshold set too high looks
    // exactly like a microphone that is not working.
    state.audio.rejected += 1
    return
  }

  audioUploading = true
  // Stamped before the send, not after: this marks "heard speech", and the
  // indicator should light while the chunk is in flight rather than after the
  // hub has answered.
  state.lastAudioAt = Date.now()
  const result = await sendCoachAudio(sessionId, {
    pcmBase64: bytesToBase64(combined),
    sampleRate: config.audioSampleRate,
    channels: 1,
    source: AudioInputSource.Glasses,
    speakerRole: audioLastRole,
    direction: audioLastDirection,
    clientId: `aud-${Date.now().toString(36)}`,
    at: Date.now(),
  })
  audioUploading = false
  if (result.ok) {
    state.audio.sent += 1
    refreshTranscriptAfterChunk()
  } else {
    state.audio.error = String(result.error ?? 'send failed').slice(0, 24)
  }

  if (!result.ok) {
    localCoachCue('Transcription off', [result.error])
    if (state.view.kind === 'cue') await paint()
    return
  }

  if (result.transcription?.text) {
    await refreshCoachSession()
    await refreshCoachCue(false)
    if (state.view.kind === 'cue') await paint()
  }
}

/**
 * Get bytes out of whatever the host actually sent.
 *
 * The SDK is explicit that `audioPcm` arrives as a Uint8Array, a plain
 * number[], or a base64 STRING depending on the host — and a string passes a
 * `.length` check, survives `.slice()`, and then produces nonsense when read as
 * PCM. That reads as permanent silence rather than as an error, which is the
 * worst way for this to fail. `kind` records which shape turned up so the Coach
 * screen can say.
 */
function toBytes(frame: unknown): Uint8Array | null {
  if (frame instanceof Uint8Array) {
    state.audio.kind = 'u8'
    // Copy. The host may hand back the same buffer every frame, in which case
    // keeping the reference means every frame in a chunk aliases the last one
    // — which reads as noise, then as silence. 0.53.0 dropped this .slice()
    // and that is when the microphone stopped working.
    return frame.slice()
  }
  if (Array.isArray(frame)) {
    state.audio.kind = 'arr'
    return Uint8Array.from(frame as number[])
  }
  if (typeof frame === 'string') {
    state.audio.kind = 'b64'
    try {
      const binary = atob(frame)
      const out = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
      return out
    } catch {
      state.audio.error = 'bad base64'
      return null
    }
  }
  if (frame && typeof (frame as { byteLength?: number }).byteLength === 'number') {
    state.audio.kind = 'buf'
    return new Uint8Array(frame as ArrayBuffer)
  }
  state.audio.kind = typeof frame
  return null
}

function handleAudio(audio: AudioEvent): void {
  // Take the session from state when the local copy has been cleared. The two
  // drifted apart — stop clears `audioSessionId` and then awaits, and a start
  // that lands in between leaves the mic open with no id to post against, so
  // every frame was dropped with "no session id" while audio kept arriving.
  // The live session is the truth; the local copy is only a cache.
  const sessionId =
    audioSessionId ?? (state.coachSession?.active ? state.coachSession.id : null)
  if (!audioOpen || !sessionId) {
    state.audio.error = !audioOpen ? 'mic not open' : 'no session id'
    return
  }
  if (!audioSessionId) audioSessionId = sessionId
  audioLastRole = audio.speakerRole || AudioSpeakerRole.Unknown
  audioLastDirection = audio.direction ?? null

  // Read the PCM carrier-agnostically.
  //
  // `event.audioEvent` is whatever the host serialised, not necessarily an
  // AudioEvent instance, so the field may not be `audioPcm` at all. This is the
  // same trap as taps arriving on `sysEvent` rather than `textEvent`: the type
  // says one thing and the wire says another, and the failure is silent. When
  // nothing matches, the object's own keys are recorded so the Coach screen can
  // name the field we should be reading.
  const raw = audio as unknown as Record<string, unknown>
  const candidate =
    raw.audioPcm ?? raw.audio_pcm ?? raw.pcm ?? raw.audioData ?? raw.data ?? raw.bytes
  const frame = toBytes(candidate)
  if (!frame?.length) {
    if (state.audio.kind === '-' || !state.audio.kind.startsWith('?')) {
      state.audio.kind = `?${Object.keys(raw).join(',').slice(0, 28)}`
    }
    return
  }
  if (!audioChunkStartedAt) audioChunkStartedAt = Date.now()
  audioFrames.push(frame)
  state.audio.frames += 1
  audioBytes += frame.length

  void flushAudioChunk()
}

async function syncAudioToCoachSession(): Promise<void> {
  // Only ever stops. Opening the microphone is something you ask for with
  // Listen, never something a poll decides on your behalf: a session left
  // active on the hub meant the glasses started recording the moment the app
  // launched, and the first thing it captured was wind. Nothing that listens
  // should start itself.
  if (state.coachSession?.active) {
    if (audioSessionId && audioSessionId !== state.coachSession.id) await stopAudioCapture()
    return
  }
  if (audioSessionId || audioOpen) await stopAudioCapture()
}

/**
 * Listen, from the menu, only ever opens the Listen screen.
 *
 * It used to start a session when none was running, which made opening the
 * screen to look at it the same gesture as recording — so checking on it while
 * stopped started it, and the only way back out was to open the menu again and
 * pick Listen a second time to cancel. Menu opens; the first click on this
 * screen arms the microphone, and the second starts it. One gesture, one
 * meaning, with a visible cancel point in between.
 */
async function openListening(context: ListenContext = null): Promise<void> {
  const current = await fetchCoachSession(state.space)
  if (current.ok) {
    state.coachSession = current.session
    state.coachModes = current.modes ?? state.coachModes
    state.coachModeId = current.mode.id
    if (!current.session?.active) state.listenReviewing = false
  }
  else state.error = current.error

  if (state.view.kind !== 'cue') {
    state.cueReturn = copyView(state.view)
    listenContext = context
  }
  const activeIndex = state.coachModes.findIndex(mode => mode.id === state.coachModeId)
  state.view = { kind: 'cue', modeCursor: Math.max(0, activeIndex) }
  state.scrollTop = 0
  await paint()
}

/**
 * What a captured line is about.
 *
 * General Listen is intentionally unbound and lands in Captured notes. A
 * subject is only sent by explicit "Note on this task/list" rows; menu Listen
 * must not silently file a car note under Dishes just because that row was
 * selected.
 */
type ListenContext = { taskId?: string; choreId?: string; label: string } | null

let listenContext: ListenContext = null

/**
 * Open Listen for something, from wherever you are.
 *
 * The subject travels with the session rather than being worked out later from
 * what you said: standing inside Laundry and saying "the dryer takes longer
 * than we thought" is about laundry, and nothing in the sentence says so.
 *
 * Opening never starts the microphone. It lands on the mode picker with this
 * subject retained; only a confirmed click begins recording. Clicking an
 * active contextual Listen still stops the existing session.
 */
async function talkAbout(context: ListenContext): Promise<void> {
  if (state.coachSession?.active) {
    await openListening()
    await activate()
    return
  }
  await openListening(context)
}

/** Start recording. Only ever from a click on the Listen screen. */
async function beginListening(): Promise<void> {
  const started = await startCoachSession(state.space, listenContext, state.coachModeId)
  if (!started.ok) {
    state.error = started.error
    await paint()
    return
  }
  state.coachSession = started.session
  state.coachModeId = started.session.modeId
  state.listenReviewing = false
  await startAudioCapture(started.session.id)
  if (!audioOpen) localCoachCue('Mic did not open', ['Glasses audioControl returned false.'])
  state.error = null
  await paint()
}

async function refreshAssistant(provider: AssistantProvider): Promise<void> {
  const result = await fetchAssistantChat(state.space, provider)
  if (result.ok) {
    state.assistantThreads[provider] = result.chat
    state.assistantChat = result.chat
    state.error = null
  } else state.error = result.error
}

async function refreshAssistantSummaries(): Promise<void> {
  const results = await Promise.all(ASSISTANT_PROVIDERS.map(provider => fetchAssistantChat(state.space, provider)))
  results.forEach((result, index) => {
    if (result.ok) state.assistantThreads[ASSISTANT_PROVIDERS[index]] = result.chat
  })
}

async function openAssistant(): Promise<void> {
  state.assistantRecording = false
  state.assistantReviewing = false
  state.assistantSending = false
  state.assistantChat = null
  state.view = { kind: 'assistant', phase: 'providers', cursor: 0 }
  await paint()
  await refresh()
  await refreshAssistantSummaries()
  await paint()
}

async function startAssistantCapture(provider: AssistantProvider): Promise<void> {
  await refreshCoachSession()
  if (state.coachSession?.active) {
    state.error = 'Stop Listen before starting Chat'
    await paint()
    return
  }
  const started = await startCoachSession(
    state.space,
    { taskId: '__assistant__', label: provider === 'claude' ? 'Claude chat' : 'ChatGPT chat' },
    'conversation',
  )
  if (!started.ok) {
    state.error = started.error
    await paint()
    return
  }
  state.coachSession = started.session
  state.assistantRecording = true
  state.assistantReviewing = false
  state.assistantSending = false
  state.error = null
  await startAudioCapture(started.session.id)
  await paint()
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitForTranscriptionsToDrain(): Promise<void> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const snapshot = await fetchSnapshot()
    if (snapshot.ok) state.snapshot = snapshot.snapshot
    if ((state.snapshot?.stt?.pending ?? 0) <= 0) return
    await wait(500)
  }
}

async function reviewListeningSession(): Promise<void> {
  const sessionId = state.coachSession?.id
  if (!sessionId) return

  state.listenReviewing = true
  await stopAudioCapture()
  await paint()
  await waitForTranscriptionsToDrain()
  await refreshCoachSession()
  state.listenReviewing = state.coachSession?.id === sessionId && state.coachSession.active
  await paint()
}

async function saveReviewedListeningSession(): Promise<void> {
  const sessionId = state.coachSession?.id
  if (!sessionId) {
    state.listenReviewing = false
    await paint()
    return
  }

  state.listenReviewing = false
  const stopped = await endCoachSession(sessionId)
  if (stopped.ok) state.coachSession = stopped.session
  else state.error = stopped.error
  await paint()

  const summary = await fetchSessionSummary(sessionId)
  if (summary && state.view.kind === 'cue') {
    localCoachCue(summary.title, summary.lines)
    await paint()
  }
}

/** Leave Listen safely: retain real speech, but do not create an empty note. */
async function preserveListeningAndLeave(): Promise<void> {
  const sessionId = state.coachSession?.id
  if (!sessionId) {
    dismissCue()
    await paint()
    return
  }

  await stopAudioCapture()
  await waitForTranscriptionsToDrain()
  await refreshCoachSession()

  const session = state.coachSession?.id === sessionId ? state.coachSession : null
  const hasWords = Boolean(session?.recentSegments.some(segment => segment.text.trim()))
  if (hasWords) {
    const stopped = await endCoachSession(sessionId)
    if (!stopped.ok) {
      state.error = stopped.error
      await paint()
      return
    }
    state.coachSession = stopped.session
  } else {
    const discarded = await discardCoachSession(sessionId)
    if (!discarded.ok) {
      state.error = discarded.error
      await paint()
      return
    }
    state.coachSession = null
  }

  state.listenReviewing = false
  state.error = null
  dismissCue()
  await paint()
}

async function discardListeningSession(): Promise<void> {
  const sessionId = state.coachSession?.id
  await stopAudioCapture()
  state.listenReviewing = false
  if (sessionId) {
    const discarded = await discardCoachSession(sessionId)
    if (!discarded.ok) {
      state.error = discarded.error
      await paint()
      return
    }
  }
  state.coachSession = null
  state.cue = null
  state.error = null
  dismissCue()
  await paint()
}

async function reviewAssistantCapture(): Promise<void> {
  const sessionId = state.coachSession?.id
  if (!sessionId) {
    state.assistantRecording = false
    state.error = 'No recording to review'
    await paint()
    return
  }

  state.assistantRecording = false
  state.assistantReviewing = true
  await stopAudioCapture()
  await paint()
  await waitForTranscriptionsToDrain()
  await refreshCoachSession()
  state.assistantReviewing = state.coachSession?.id === sessionId
  await paint()
}

async function finishAssistantCapture(provider: AssistantProvider): Promise<void> {
  const sessionId = state.coachSession?.id
  if (!sessionId) {
    state.assistantRecording = false
    state.error = 'No recording to send'
    await paint()
    return
  }

  state.assistantRecording = false
  state.assistantReviewing = false
  state.assistantSending = true
  await paint()

  await waitForTranscriptionsToDrain()
  let sent: Awaited<ReturnType<typeof sendAssistantSession>> | null = null
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const snapshot = await fetchSnapshot()
    if (snapshot.ok) state.snapshot = snapshot.snapshot
    if ((state.snapshot?.stt?.pending ?? 0) > 0) {
      await wait(500)
      continue
    }
    sent = await sendAssistantSession(state.space, provider, sessionId)
    if (!sent.ok && sent.pending) {
      await wait(500)
      continue
    }
    break
  }

  const stopped = await endCoachSession(sessionId)
  state.coachSession = null
  state.assistantSending = false
  if (sent?.ok) {
    state.assistantChat = sent.chat
    state.assistantThreads[provider] = sent.chat
    state.error = null
  } else state.error = sent?.error ?? 'Transcription timed out'
  if (!stopped.ok && !state.error) state.error = stopped.error
  await paint()
}

async function cancelAssistantCapture(): Promise<void> {
  const sessionId = state.coachSession?.id
  await stopAudioCapture()
  if (sessionId) {
    const discarded = await discardCoachSession(sessionId)
    if (!discarded.ok) state.error = discarded.error
    else state.error = null
  }
  if (!state.error) state.coachSession = null
  state.assistantRecording = false
  state.assistantReviewing = false
  state.assistantSending = false
}

async function openNote(row: ReturnType<typeof noteRows>[number]): Promise<void> {
  state.armedNoteId = null
  state.noteTranscript = null
  state.view = {
    kind: 'note',
    subjectKind: row.subject.kind,
    subjectId: row.subject.id,
    noteId: row.note.id,
    cursor: 0,
  }
  state.scrollTop = 0
  await paint()

  const transcript = await fetchNoteTranscript(row.note.id)
  if (state.view.kind === 'note' && state.view.noteId === row.note.id) {
    state.noteTranscript = transcript
    clampCursor()
    await paint()
  }
}

function removeLocalNote(row: ReturnType<typeof noteRows>[number]): void {
  if (row.subject.kind === 'task') {
    const task = state.plan?.tasks.find(item => item.taskId === row.subject.id)
    if (task) task.notes = task.notes.filter(note => note.id !== row.note.id)
    return
  }
  const notes = state.snapshot?.checklists?.notes
  if (notes && state.snapshot?.checklists) {
    state.snapshot.checklists.notes = notes.filter(note => note.id !== row.note.id)
  }
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
    case 'chores':
      return choreRows(state).length
    case 'checklist': {
      const run = findRun(state, state.view.runId)
      // +1: the "note on this list" row that follows the last step.
      return run ? run.items.length + 1 : 0
    }
    case 'picker':
      return startable(state).length
    case 'inbox':
      return inboxItems(state, state.view.group).length
    case 'notes':
      return noteRows(state).length
    case 'capture':
      return captureRows().length
    case 'note':
      return noteDetailActions(
        state,
        findNoteRow(state, state.view.subjectKind, state.view.subjectId, state.view.noteId),
      ).length
    case 'assistant':
      return state.view.phase === 'providers' ? 2 : 0
    case 'cue':
    case 'transcript':
    case 'pong':
    case 'fonttest':
      return 0
  }
}

function clampCursor(): void {
  const view = state.view
  if (
    view.kind === 'pong' ||
    view.kind === 'fonttest' ||
    view.kind === 'cue' ||
    view.kind === 'transcript' ||
    (view.kind === 'assistant' && view.phase === 'chat')
  ) return
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
    view.startArmed = false
    if (!state.coachSession && state.coachModes.length > 0) {
      view.modeCursor = Math.max(
        0,
        Math.min(state.coachModes.length - 1, (view.modeCursor ?? 0) + delta),
      )
      return
    }
    // Scroll winds back through the transcript. It used to dismiss the screen,
    // which made reading back through what was said impossible: the gesture
    // for "let me see more" was the gesture for "close this".
    //
    // With nothing captured there is nothing to wind through, so a plain cue
    // popup keeps the old flick-to-dismiss.
    const captured = (state.coachSession?.recentSegments ?? []).length
    if (captured === 0) {
      dismissCue()
      return
    }
    // Up (negative) goes back in time, clamped to the end of the transcript.
    // Letting it run past meant the number kept climbing on a screen that had
    // stopped moving, and getting back to live took as many flicks as you had
    // wasted going the other way.
    const max = transcriptScrollMax(state)
    view.scroll = Math.max(0, Math.min(max, (view.scroll ?? 0) - delta))
    return
  }

  if (view.kind === 'assistant') {
    if (view.phase === 'providers') {
      view.cursor = Math.max(0, Math.min(1, view.cursor + delta))
    } else if (!state.assistantRecording) {
      const max = assistantScrollMax(state)
      view.scroll = Math.max(0, Math.min(max, (view.scroll ?? 0) - delta))
    }
    return
  }

  if (view.kind === 'transcript') {
    const max = noteTranscriptScrollMax(state)
    view.scroll = Math.max(0, Math.min(max, (view.scroll ?? 0) + delta))
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
  if (view.kind === 'task') {
    const rows = taskDetailRows(state, view.taskId)
    const step = delta >= 0 ? 1 : -1
    while (rows[next]?.kind === 'space' && next > 0 && next < count - 1) next += step
    if (rows[next]?.kind === 'space') next = view.cursor
  }

  view.cursor = next
  // Moving off a row cancels its pending confirm. An armed task that stayed
  // armed while you scrolled away would fire on the next tap somewhere else.
  state.armedTaskId = null
  state.armedNoteId = null
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

    // Nothing starts on its own. Completing a step used to begin the next
    // one's clock, and every version of "which one is next" is wrong when you
    // work a list out of order — it started a wash cycle for a wash already
    // done. A timer starts when he clicks the step, and never otherwise.
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
  // Nowhere to switch to. Callers are the root double-tap and the menu item;
  // the menu item is not built while Ops is off, and the double-tap has its
  // own Life-only destination, so this is belt and braces.
  if (!config.ops) return
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

/**
 * Start or complete a step without leaving the running order.
 *
 * The run is created on demand: clicking a step is a statement that you are
 * doing it, so there is no separate "begin this chore" gesture to forget.
 * Nothing else is started — the same rule as inside a checklist.
 */
async function stepFromPlan(choreId: string, stepId: string): Promise<void> {
  let run = state.snapshot?.checklists?.active.find(r => r.checklistId === choreId && !r.complete)

  if (!run) {
    const started = await startChecklist(choreId)
    if (!started.ok) {
      state.error = started.error
      await paint()
      return
    }
    if (state.snapshot) state.snapshot.checklists = started.checklists
    run = started.checklists.active.find(r => r.checklistId === choreId && !r.complete)
  }

  const item = run?.items.find(i => i.id === stepId)
  if (!run || !item) {
    state.error = 'step is gone'
    await paint()
    return
  }

  const armed = item.running || (item.stepKind === 'wait' && item.endsAt !== null)
  const result = item.done || armed
    ? await checkItem(run.runId, item.id, !item.done)
    : await beginStep(run.runId, item.id)

  if (result.ok) {
    if (state.snapshot) state.snapshot.checklists = result.checklists
    state.error = null
  } else {
    state.error = result.error
  }

  // The plan is recomputed from what is running, so it has to be refetched
  // rather than patched — starting a wait changes every total below it.
  const plan = await fetchPlan(state.space)
  if (plan.ok) state.plan = plan.plan
  clampCursor()
  await paint()
}

async function openPlan(): Promise<void> {
  // Arriving at the page is what "leave it and come back" means. Ticked daily
  // steps stay put while you are here and are gone the next time you look.
  state.stickyDone.clear()
  state.view = { kind: 'plan', cursor: 0 }
  state.scrollTop = 0
  state.planLoading = true
  await paint()
  const result = await fetchPlan(state.space)
  state.planLoading = false
  if (result.ok) {
    state.plan = result.plan
    state.planError = null
    state.error = null
  } else {
    state.planError = result.error
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

  if (view.kind === 'assistant') {
    if (view.phase === 'providers') {
      const provider: AssistantProvider = view.cursor === 1 ? 'claude' : 'chatgpt'
      if (state.snapshot?.assistant?.[provider] !== true) {
        state.error = `${provider === 'claude' ? 'Claude' : 'ChatGPT'} setup needed on Mac`
        await paint()
        return
      }
      state.view = { kind: 'assistant', phase: 'chat', provider, scroll: 0 }
      state.assistantChat = state.assistantThreads[provider] ?? null
      await paint()
      await refreshAssistant(provider)
      await paint()
      return
    }
    if (state.assistantSending || state.assistantChat?.busy) {
      await refreshAssistant(view.provider)
      await paint()
      return
    }
    if (state.assistantRecording) await reviewAssistantCapture()
    else if (state.assistantReviewing) await finishAssistantCapture(view.provider)
    else await startAssistantCapture(view.provider)
    return
  }

  if (view.kind === 'cue') {
    // Click here stops the microphone first, then asks for a deliberate save.
    // A live transcript can be visibly wrong; stopping must leave a way out
    // before those words are filed as a note.
    if (state.coachSession?.active) {
      if (state.listenReviewing) await saveReviewedListeningSession()
      else await reviewListeningSession()
      return
    }
    if (!state.coachSession && state.coachModes.length > 0) {
      const cursor = view.modeCursor ?? 0
      const mode = state.coachModes[cursor]
      if (mode) {
        if (!view.startArmed) {
          view.startArmed = true
          await paint()
          return
        }
        view.startArmed = false
        const activated = await activateCoachMode(state.space, mode.id)
        if (activated.ok) {
          state.coachModeId = activated.mode.id
          state.error = null
          await beginListening()
        } else {
          state.error = activated.error
          await paint()
        }
        return
      }
    }
    // Stopped: first click arms, second click starts. Leaving is the double-tap,
    // same as every other screen; movement also disarms.
    if (!view.startArmed) {
      view.startArmed = true
      await paint()
      return
    }
    view.startArmed = false
    await beginListening()
    return
  }

  if (view.kind === 'capture') {
    const row = captureRows()[view.cursor]
    if (row?.kind === 'listen') {
      await talkAbout(null)
      return
    }
    await openNotes()
    return
  }

  if (view.kind === 'board') {
    // Nothing to open on a metric; the cursor is for reading long boards.
    await paint()
    return
  }

  if (view.kind === 'transcript') {
    // Ring scroll reads; double-tap returns to the note.
    await paint()
    return
  }

  if (view.kind === 'notes') {
    const row = noteRows(state)[view.cursor]
    if (!row) return
    await openNote(row)
    return
  }

  if (view.kind === 'note') {
    const row = findNoteRow(state, view.subjectKind, view.subjectId, view.noteId)
    const action = noteDetailActions(state, row)[view.cursor]
    if (!row || !action) return

    if (action === 'transcript') {
      if (state.noteTranscript?.noteId !== row.note.id) {
        state.noteTranscript = await fetchNoteTranscript(row.note.id)
      }
      if (!state.noteTranscript) {
        state.error = 'transcript unavailable'
        await paint()
        return
      }
      state.error = null
      state.view = {
        kind: 'transcript',
        subjectKind: row.subject.kind,
        subjectId: row.subject.id,
        noteId: row.note.id,
        scroll: 0,
      }
      await paint()
      return
    }

    const key = `${row.subject.kind}:${row.subject.id}:${row.note.id}`
    if (state.armedNoteId !== key) {
      state.armedNoteId = key
      await paint()
      return
    }
    state.armedNoteId = null
    const deleted = await deleteNote(row.subject.kind, row.subject.id, row.note.id)
    if (!deleted.ok) {
      state.error = deleted.error
      await paint()
      return
    }
    state.error = null
    removeLocalNote(row)
    state.noteTranscript = null
    state.view = { kind: 'notes', cursor: 0 }
    state.scrollTop = 0
    clampCursor()
    await paint()
    return
  }

  if (view.kind === 'checklist') {
    const run = findRun(state, view.runId)
    if (run && view.cursor === run.items.length) {
      await talkAbout({ choreId: run.checklistId, label: run.name })
      return
    }
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

    // First click starts the step's clock; the second completes it. Two
    // clicks, both deliberate, and the same gesture for every kind of step.
    //
    // Waits used to skip this and go straight to done on the first click, so
    // clicking "Wash cycle" ticked it off instead of starting the countdown —
    // no timer, no reminder, and no record of how long it actually took.
    // A `check` step ticks on the first click and records when. There is no
    // clock to start, because there is no clock you would come back and stop —
    // nobody reopens the list wet to end the shower, and a step left running
    // all day is worse than one that was never timed.
    const armed =
      item.stepKind === 'check' ||
      item.running ||
      (item.stepKind === 'wait' && item.endsAt !== null)
    if (!item.done && !armed) {
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
    if (row?.kind === 'listen') {
      const task = state.plan?.tasks?.find(t => t.taskId === view.taskId)
      await talkAbout(task ? { taskId: task.taskId, label: task.label } : null)
      return
    }
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

  if (view.kind === 'chores') {
    // One level down: the chore's own steps. This is the drill-down the
    // running order deliberately is not — there you act on whatever fits the
    // gap you have; here you work a single chore through.
    const row = choreRows(state)[view.cursor]
    if (row?.kind === 'run' && row.run.complete) {
      // Arm, then confirm. Resetting is not destructive — the finished run
      // stays in history and keeps feeding the medians — but starting a fresh
      // laundry by accident is noise you would have to undo step by step.
      if (state.armedTaskId !== row.run.runId) {
        state.armedTaskId = row.run.runId
        await paint()
        return
      }
      state.armedTaskId = null
      // A run only leaves `active` once finished, so a reset is finish-then-
      // start; starting alone would hand back the same completed run.
      await finishChecklist(row.run.runId)
      const fresh = await startChecklist(row.run.checklistId)
      if (fresh.ok && state.snapshot) state.snapshot.checklists = fresh.checklists
      else if (!fresh.ok) state.error = fresh.error
      const plan = await fetchPlan(state.space)
      if (plan.ok) state.plan = plan.plan
      clampCursor()
      await paint()
      return
    }
    if (row?.kind === 'run') {
      await enterChecklist(row.run.runId)
      return
    }
    if (row?.kind === 'start') {
      await openChecklist(row.list.id)
      return
    }
    await paint()
    return
  }

  if (view.kind === 'plan') {
    const row = planRows(state)[view.cursor]

    // The LIFE line. Two things live behind it — talk, or read back what you
    // already said — so it opens the pair rather than picking one for you.
    if (row?.kind === 'listen') {
      state.view = { kind: 'capture', cursor: 0 }
      state.scrollTop = 0
      clampCursor()
      await paint()
      return
    }

    // A required-today step, ticked from the page you were already on.
    //
    // Arm, then confirm. One click used to finish it, and the row vanished
    // under your finger the same instant — no confirmation, no evidence, and
    // no way back from a misclick. Ticking something off is cheap to ask twice
    // for and expensive to get wrong.
    if (row?.kind === 'daily') {
      const key = `${row.runId}:${row.item.id}`
      if (row.item.done) {
        state.stickyDone.delete(key)
        await toggle(row.runId, row.item.id)
        return
      }
      if (state.armedTaskId !== key) {
        state.armedTaskId = key
        await paint()
        return
      }
      state.armedTaskId = null
      // Held on screen, ticked, until you leave the page.
      state.stickyDone.add(key)
      await toggle(row.runId, row.item.id)
      return
    }

    // Start it from here. Going into the chore to click the same step you were
    // already looking at was navigation for its own sake — on the running
    // order you can see the step, so clicking it should be what starts it.
    // Same two-click rule as everywhere: first starts, second completes.
    if (row?.kind === 'chores') {
      state.view = { kind: 'chores', cursor: 0 }
      state.scrollTop = 0
      clampCursor()
      await paint()
      return
    }

    // Arm, then confirm: the same gate as the required-today rows above.
    // First click asks "[?] Start ...?" / "[?] Finish ...?", the second acts,
    // and scrolling away cancels (the cursor move clears armedTaskId).
    if (row?.kind === 'agenda' && row.row.kind === 'do') {
      const key = `step:${row.row.choreId}:${row.row.stepId}`
      if (state.armedTaskId !== key) {
        state.armedTaskId = key
        await paint()
        return
      }
      state.armedTaskId = null
      await stepFromPlan(row.row.choreId, row.row.stepId)
      return
    }

    // Clicking something already done puts it back. The undo for a misclick,
    // and the only one available from the glasses.
    if (row?.kind === 'agenda' && row.row.kind === 'done') {
      const undone = await checkItem(row.row.runId, row.row.stepId, false)
      if (undone.ok && state.snapshot) state.snapshot.checklists = undone.checklists
      else if (!undone.ok) state.error = undone.error
      const plan = await fetchPlan(state.space)
      if (plan.ok) state.plan = plan.plan
      clampCursor()
      await paint()
      return
    }

    if (row?.kind === 'task') {
      // Captured notes is the same collection exposed by the Notes menu, not
      // an ordinary task with a competing detail screen.
      if (row.task.taskId === CAPTURE_TASK_ID) {
        await openNotes()
        return
      }
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
  state.armedNoteId = null
  if (state.view.kind === 'transcript') {
    const { subjectKind, subjectId, noteId } = state.view
    state.view = { kind: 'note', subjectKind, subjectId, noteId, cursor: 0 }
    state.scrollTop = 0
    clampCursor()
    await paint()
    return
  }

  if (state.view.kind === 'note') {
    const { subjectKind, subjectId, noteId } = state.view
    const cursor = noteRows(state).findIndex(row =>
      row.subject.kind === subjectKind && row.subject.id === subjectId && row.note.id === noteId,
    )
    state.view = { kind: 'notes', cursor: Math.max(0, cursor) }
    state.scrollTop = Math.max(0, cursor)
    clampCursor()
    await paint()
    return
  }

  if (state.view.kind === 'assistant') {
    if (state.assistantRecording || state.assistantReviewing || state.assistantSending) {
      await cancelAssistantCapture()
      if (state.error) {
        await paint()
        return
      }
    }
    if (state.view.phase === 'chat') {
      state.assistantChat = null
      state.view = { kind: 'assistant', phase: 'providers', cursor: 0 }
      await paint()
      await refreshAssistantSummaries()
      await paint()
      return
    }
    state.view = homeView()
    state.scrollTop = 0
    clampCursor()
    await paint()
    return
  }

  if (state.view.kind === 'cue') {
    if (!state.listenReviewing && state.coachSession?.active) {
      await preserveListeningAndLeave()
      return
    }
    if (state.listenReviewing && state.coachSession?.active) {
      await discardListeningSession()
      return
    }
    dismissCue()
    await paint()
    return
  }

  if (state.view.kind === 'pong') {
    stopPong()
    state.view = homeView()
    state.scrollTop = 0
    clampCursor()
    await refresh()
    return
  }

  // In Life the running order is home: it is what the screen is for, and there
  // is no index behind it any more. Going "back" from it means leaving.
  if (
    state.view.kind === 'task' ||
    state.view.kind === 'chores' ||
    state.view.kind === 'notes' ||
    state.view.kind === 'capture'
  ) {
    await openPlan()
    return
  }

  // Double-tap at the Life root switches to Ops rather than exiting. Getting
  // back in means the phone's private-build menu, so the one gesture you make
  // by accident must not be the one that ends the session. The glasses OS
  // system menu still has close and display-off.
  //
  // Note for a future store submission: QA expects shutDownPageContainer(1)
  // from the root page. This deliberately does not.
  if (state.view.kind === 'plan' && state.space === 'life' && config.ops) {
    await switchSpace()
    return
  }

  if (state.view.kind === 'checklist' && state.space === 'life') {
    state.view = { kind: 'chores', cursor: 0 }
    state.scrollTop = 0
    clampCursor()
    await paint()
    return
  }

  if (state.view.kind !== 'index' && !atHome()) {
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

  if (config.ops && state.view.kind === 'index') {
    // Ops root: switch rather than exit.
    await switchSpace()
    return
  }

  // Home, with nothing behind it. Sleep, the way the stock dashboard does:
  // double-tap your way to the top, double-tap once more and the display goes
  // dark; the next input wakes it.
  //
  // This is the LAST line of back() on purpose. Every screen that adds itself
  // later falls through to here whether or not anyone remembers to wire it up,
  // so the gesture means the same thing everywhere — which is the only way a
  // gesture you make without looking is safe to make. Screens used to dead-end
  // instead: pong and the index both went somewhere whose own back was a
  // no-op with Ops off, so double-tap did nothing at all and the display
  // could not be put out from there.
  //
  // Exiting is not on the table: getting back into a private build means the
  // phone's menu. Note for a future store submission: QA expects
  // shutDownPageContainer(1) from the root page. This deliberately does not.
  await sleepDisplay()
}

/** Is this the screen the app opens on — the one with nothing behind it? */
function atHome(): boolean {
  const home = homeView()
  return state.view.kind === home.kind
}

async function onMenu(itemID: number): Promise<void> {
  // Picking something off the long-press menu is a decision, not a wake-up
  // tap: bring the screen back and then do what was asked.
  asleep = false
  switch (itemID) {
    case MENU.SWITCH:
      await switchSpace()
      break
    case MENU.REFRESH:
      await refresh()
      await refreshCoachSession()
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
        state.view.kind !== 'cue' &&
        state.view.kind !== 'transcript' &&
        state.view.kind !== 'assistant'
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
      // In Life this is the Chores drill-down — one row per chore with its
      // progress bar. It used to open the old index here, which is the screen
      // with "Start a list" and "The running order" on it: rows that either
      // duplicate the running order or lead back to it. In Ops the index IS
      // the home screen, so there it stays what it was.
      if (state.space === 'life') {
        state.view = { kind: 'chores', cursor: 0 }
      } else {
        state.view = { kind: 'index', cursor: 0 }
        await refreshCoachCue(false)
      }
      state.scrollTop = 0
      clampCursor()
      await paint()
      break
    case MENU.NOTES:
      await openNotes()
      break
    case MENU.COACH:
      await openCoachCue()
      break
    case MENU.LISTEN:
      await openListening()
      break
    case MENU.CHAT:
      await openAssistant()
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
  containerTotalNum: 5,
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
      // This transparent full-panel layer owns input. paint() fills the image
      // below it, or restores native text here if image transfer fails.
      content: SLEEP_CONTENT,
      textColor: DIM,
      isEventCapture: 1,
      zOrderIndex: 5,
    }),
  ],
  imageObject: [
    ...IMAGE_CONTAINER_IDS.map((containerID, index) =>
      new ImageContainerProperty({
        xPosition: TILES[index].x,
        yPosition: TILES[index].y,
        width: TILE_W,
        height: TILE_H,
        containerID,
        containerName: IMAGE_CONTAINER_NAMES[index],
        zOrderIndex: index + 1,
      }),
    ),
  ],
  menuObject: new MenuContainerProperty({
    menuItems: [
      // The first item's label cannot change after create, so the first item
      // is the one whose meaning will not change: capture.
      //
      // Ops is off (config.ts `ops`), so the space switch is gone from here.
      // Its handler survives — turning the flag on puts the item back.
      ...(config.ops
        ? [new MenuItemProperty({ itemName: 'Ops / Life', itemID: MENU.SWITCH })]
        : []),
      // Five. Everything cut had a shorter way to reach it: Running order is
      // where double-tap lands from anywhere, Refresh is what the fifteen
      // second poll already does, Coach and the rest were build-time scaffolding.
      // The handlers all survive, so putting one back is one line.
      new MenuItemProperty({ itemName: 'Listen', itemID: MENU.LISTEN }),
      new MenuItemProperty({ itemName: 'Chat', itemID: MENU.CHAT }),
      new MenuItemProperty({ itemName: 'Notes', itemID: MENU.NOTES }),
      new MenuItemProperty({ itemName: 'Lists', itemID: MENU.LISTS }),
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
await paint()

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

function onHubEvent(event: EvenHubEvent): void {
  state.events += 1

  // Any event at all means the glasses are showing us, whatever we last
  // believed. A missed FOREGROUND_ENTER would otherwise leave polling off for
  // good, which surfaces as a permanent !OLD and numbers that never move.
  if (event.sysEvent?.eventType !== OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    state.foreground = true
  }

  if (event.audioEvent) {
    // Counted here, ahead of every check of ours. If this stays at zero the
    // host is not delivering audio at all and nothing downstream matters; if
    // it climbs while `frames` does not, we are the ones throwing it away.
    state.audio.raw += 1
    const audio = event.audioEvent
    const now = Date.now()
    if (now - audioLogLastAt > 5_000) {
      audioLogLastAt = now
      console.log('[audio]', JSON.stringify({
        bytes: audio.audioPcm?.length ?? 0,
        source: audio.source,
        direction: audio.direction,
        speakerRole: audio.speakerRole,
      }))
    }
    state.lastEvent = `aud:${audio.audioPcm?.length ?? 0}`
    handleAudio(audio)
    return
  }

  // Keep logging non-audio input shapes: this is how the sysEvent behaviour
  // below was found in the first place, and the next surprise will show up too.
  console.log('[event]', JSON.stringify(event))

  lastInputAt = Date.now()

  // ---- wake ------------------------------------------------------------
  // Before anything is dispatched. A sleeping WAM accepts exactly one input:
  // double-click. Single clicks and scrolls are too easy to trigger by bumping
  // the glasses, and a contextual-menu selection should not bypass the lock.
  // The wake double-click is spent here and never reaches back(). Lifecycle
  // events still fall through so foreground/background state stays accurate.
  if (asleep) {
    const sys = event.sysEvent?.eventType
    const lifecycle =
      sys === OsEventTypeList.FOREGROUND_ENTER_EVENT ||
      sys === OsEventTypeList.FOREGROUND_EXIT_EVENT ||
      sys === OsEventTypeList.SYSTEM_EXIT_EVENT ||
      sys === OsEventTypeList.ABNORMAL_EXIT_EVENT ||
      sys === OsEventTypeList.IMU_DATA_REPORT
    if (!lifecycle) {
      const source = event.textEvent ?? event.listEvent ?? event.sysEvent
      const type = normaliseEventType(source?.eventType)
      if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        state.lastEvent = 'wake-double'
        void wakeDisplay()
      } else {
        state.lastEvent = 'sleep-ignore'
      }
      return
    }
  }

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
    // Back on your face. Refresh immediately rather than waiting out the poll
    // interval — the first thing you see should not be the last thing from
    // before you looked away.
    state.foreground = true
    // Preserve WAM's own blank-screen state. The OS can foreground the app
    // after a bump; only the explicit double-click above is allowed to wake it.
    state.lastEvent = 'fg-in'
    void refresh()
      .then(() => refreshCoachSession())
      .then(() => syncAudioToCoachSession())
      .then(() => refreshCoachCue(false))
    return
  }
  if (
    sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT ||
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    // The OS has taken the screen back. Go quiet: no fetches, no paints. An
    // armed confirm does not survive the trip — coming back to a row already
    // asking "done?" is one tap from ticking off something you never did.
    state.foreground = false
    clearArmedConfirms()
    state.lastEvent = `sys${sysType}`
    void stopAudioCapture()
    return
  }

  if (sysType === OsEventTypeList.IMU_DATA_REPORT) {
    state.lastEvent = 'imu'
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
}

bridge.onEvenHubEvent(onHubEvent)
// Keys pressed on the hub's /mirror page arrive as the same events.
startRemoteInput(onHubEvent)

bridge.onLaunchSource(source => console.log('[boot] launched from', source))

await refresh()
await refreshCoachSession()
await syncAudioToCoachSession()
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

// The dashboard clock and timers are computed locally from authoritative end
// timestamps. Repaint once per second while a timer is live; tile hashing means
// only the bottom-right timer tile crosses to the glasses. With no timer, only
// the top-right clock tile changes, once per minute.
let dashboardMinute = -1
setInterval(() => {
  if (!state.foreground || asleep || listenBoard(state)) return
  const minute = Math.floor(Date.now() / 60_000)
  const timersLive = dashboardTimers().length > 0
  if (!timersLive && minute === dashboardMinute) return
  dashboardMinute = minute
  void paint()
}, 1_000)

/**
 * Repaint the Coach screen while a session is live.
 *
 * Its numbers change every couple of seconds and nothing else repaints it, so
 * it sat frozen for the whole session — which reads as "the microphone is
 * doing nothing" whether or not it is.
 */
setInterval(() => {
  const liveListen = state.view.kind === 'cue'
  const liveAssistant = state.view.kind === 'assistant' && state.view.phase === 'chat' && state.assistantRecording
  if ((!liveListen && !liveAssistant) || !state.coachSession?.active || !state.foreground || asleep) return
  // Refetch, not just repaint. The counters are local so they moved, but the
  // transcript lines live on the hub and nothing was asking for them — so the
  // screen said "Nothing heard yet" no matter what the hub had transcribed.
  void refreshCoachSession().then(() => paint())
}, config.listenPollMs)

setInterval(() => {
  const view = state.view
  if (
    view.kind !== 'assistant' ||
    view.phase !== 'chat' ||
    state.assistantRecording ||
    state.assistantSending ||
    !state.foreground ||
    asleep
  ) return
  void refreshAssistant(view.provider).then(() => paint())
}, config.listenPollMs)
