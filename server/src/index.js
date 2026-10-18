import http from 'node:http'
import crypto from 'node:crypto'
import { appendFileSync, createReadStream, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { Store } from './state.js'
import { Checklists } from './checklists.js'
import { agenda, planBlock, reach } from './plan.js'
import { Inbox } from './inbox.js'
// The household rules live in WAM Home (private repo), synced by tools/sync-wam-home.mjs.
import { parseListSpeech } from './vendor/wam-home/listVoice.js'
import { applyListSpeech, relinkAfterUndo } from './vendor/wam-home/householdList.js'
import { routeHouseholdSpeech } from './vendor/wam-home/householdRouter.js'
import { Tasks, matchOpenTask, linkedCompletionEvidence } from './tasks.js'
import { Followups, daysBetween, reminderText } from './followups.js'
import { Triage, sweepInbox } from './triage.js'
import { Jobs, JOB } from './jobs.js'
import { composeListenSummary, fallbackListenSummary, sessionRecap } from './listenSummary.js'
import { distillNote } from './distill.js'
import { Notifier, sweepWaits } from './notify.js'
import { computeGame, gameSummary, GameAnnouncer } from './game.js'
import { cleanEatOut, loadEatOut, saveEatOut } from './eatOut.js'
import { applyMessage, verifySignature, startSocketMode } from './slack.js'
import { buildCue } from './cues.js'
import { Coach } from './coach.js'
import { transcribePcm, transcriberInfo } from './stt.js'
import { AssistantChat } from './assistant.js'
import { coalesceTranscriptSegments, isNonSpeechText, mergeRawSegments, parseTaskCommand, transcriptText } from './transcript.js'
import { handleRemoteInput } from './remoteinput.js'
import { MorningBrief } from './morningBrief.js'
import { Recordings } from './recordings.js'
import { SpokenWork, spokenWorkProgress } from './spokenWork.js'
import { compareSpokenCoverage, legacySpokenInventory } from './spokenWorkImport.js'
import { ingestCoachCapture, reconcileRecentCaptures } from './spokenWorkCapture.js'
import { applySpokenModelResult, scheduleSpokenExtraction } from './spokenWorkExtraction.js'
import { linkExistingSpokenTask, materializeSpokenWork, previewSpokenTaskUpdate, promoteSpokenResource, promoteSpokenTask, updateSpokenTask } from './spokenWorkReview.js'
import { transcribeSession } from './sessionTranscript.js'
import { remainingPlanSteps } from './planRows.js'
import { refreshWeatherBrief, weatherRefreshDelayMs } from './sources/weather.js'
import { refreshMailBrief, mailRefreshDelayMs } from './sources/mail.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0'
const INGEST_TOKEN = process.env.INGEST_TOKEN || ''
const READ_TOKEN = process.env.READ_TOKEN || ''
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || ''
const PERSIST = process.env.PERSIST_PATH || join(HERE, '..', 'data', 'values.json')
const CONFIG_PATH = process.env.CONFIG_PATH || join(HERE, 'boards.config.json')
const SPOKEN_RULES_PATH = process.env.SPOKEN_RULES_PATH || join(HERE, 'spoken-work.rules.json')

const CHECKLISTS_PATH = process.env.CHECKLISTS_PATH || join(HERE, 'checklists.config.json')
const DATA_DIR = process.env.DATA_DIR || join(HERE, '..', 'data')
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || join(HERE, '..', 'downloads')
const PHONE_PACKAGE_PATH = process.env.PHONE_PACKAGE_PATH || join(DOWNLOADS_DIR, 'wam-latest.ehpk')
const AI_CUE_INTERVAL_MS = Math.max(30_000, Number(process.env.AI_CUE_INTERVAL_MS || 2 * 60_000))
const AI_CUE_LULL_MS = Math.max(3_000, Number(process.env.AI_CUE_LULL_MS || 8_000))
// Longest the Listen board waits for fresh topics/summary while people keep
// talking. The lull timer alone never fires during steady speech (v0.103.0).
const AI_NOTE_MAX_WAIT_MS = Math.max(8_000, Number(process.env.AI_NOTE_MAX_WAIT_MS || 15_000))
const AI_CUE_NOTIFY = process.env.AI_CUE_NOTIFY === '1'
// Life is the active product scope. Ops remains fully implemented and can be
// re-enabled explicitly with AI_CUE_SPACES=ops (or ops,life).
const AI_CUE_SPACES = (process.env.AI_CUE_SPACES || 'life')
  .split(',')
  .map(s => s.trim())
  .filter(s => s === 'ops' || s === 'life')

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
const store = new Store(config, PERSIST)

const checklistConfig = JSON.parse(readFileSync(CHECKLISTS_PATH, 'utf8'))
const checklists = new Checklists(checklistConfig, {
  runsPath: join(DATA_DIR, 'runs.json'),
  logPath: join(DATA_DIR, 'checks.jsonl'),
  summaryPath: join(DATA_DIR, 'summaries'),
})

const notifier = new Notifier()

// ---- life game -----------------------------------------------------------
// Scored by fixed rules in game.config.json from the checklist runs; no AI.
// Recomputed on every read, so there is no stored score to drift.
const GAME_CONFIG_PATH = process.env.GAME_CONFIG_PATH || join(HERE, 'game.config.json')
const gameConfig = JSON.parse(readFileSync(GAME_CONFIG_PATH, 'utf8'))
const gameAnnouncer = new GameAnnouncer({
  statePath: join(DATA_DIR, 'game-state.json'),
  notifier,
  config: gameConfig,
})
// The ledger feed's weekly eating-out totals (facts only, no merchants); the
// latest push replaces the last, since bank data can still be revised.
const EAT_OUT_PATH = join(DATA_DIR, 'ledger-eatout.json')
let ledgerEatOut = loadEatOut(EAT_OUT_PATH)
function gameState(now = Date.now(), historyDays = 60) {
  const taskInfo = {}
  for (const t of tasks.taskDefs()) {
    taskInfo[t.id] = { label: t.label, doneAt: tasks.done.get(t.id)?.doneAt ?? null, completedOn: tasks.done.get(t.id)?.completedOn ?? null }
  }
  return computeGame({
    runs: [...checklists.runs.values()],
    templates: checklists.templates,
    config: gameConfig,
    today: checklists.dayKey(now),
    historyDays,
    commitments: checklists.commitments(),
    taskInfo,
    dayKeyOf: ts => checklists.dayKey(ts),
    eatOut: ledgerEatOut,
  })
}
function announceGame() {
  gameAnnouncer.observe(gameState()).catch(err => console.warn(`[game] ping: ${err.message}`))
}

const inbox = new Inbox({
  storePath: join(DATA_DIR, 'inbox.json'),
  logPath: join(DATA_DIR, 'inbox.jsonl'),
})

// ---- household list (v0.171.0, docs/SHOPPING-LIST-SPEC.md) ----------------
// An urgent list item is also a Home task; finishing either finishes both.
// Pinned to today without starting the day, so Start Day still shows.
function openUrgentTask(item) {
  const created = tasks.addTask({
    label: `Get ${Inbox.label(item)} (urgent)`.slice(0, 80),
    space: 'life',
    window: 'anytime',
    by: 'list',
    clientId: `list-urgent:${item.id}`,
  })
  if (!created.ok) return null
  // Flagged urgent again after being un-flagged: the same task comes back open.
  if (created.duplicate) tasks.complete(created.task.id, false)
  checklists.commitTasks('life', [created.task.id], Date.now(), { startDay: false })
  return created.task.id
}
function closeTask(taskId) {
  try { tasks.complete(taskId, true) } catch (err) { console.warn(`[list] close task: ${err.message}`) }
}
/** A Home task that was an urgent list item: checking it off checks the item off. */
function closeLinkedListItem(taskId, by = 'home') {
  for (const item of inbox.active(500)) {
    if (item.taskId === taskId) inbox.complete(item.id, true, { by })
  }
}
function reopenTask(taskId) {
  try { tasks.complete(taskId, false) } catch (err) { console.warn(`[list] reopen task: ${err.message}`) }
}
const listDeps = () => ({ inbox, openUrgentTask, closeTask, reopenTask })
/** Names for the kiosk chips. Private data (server/data/household.json), never in git. */
function householdMembers() {
  try {
    const raw = JSON.parse(readFileSync(join(DATA_DIR, 'household.json'), 'utf8'))
    return Array.isArray(raw.members) ? raw.members.map(name => String(name).slice(0, 24)).filter(Boolean) : []
  } catch {
    return []
  }
}
const listReplies = new Map()
// v0.172.0: one kiosk utterance can add to the list, start a routine and add a
// task. Each change id remembers the runs and tasks it made so Undo takes all
// of it back; every /list change is registered so a spoken "undo" takes back
// the most recent one, whoever made it.
const householdChanges = new Map()
function rememberChange(changeId, { runIds = [], taskIds = [] } = {}) {
  if (!changeId) return
  householdChanges.set(changeId, { runIds, taskIds, at: Date.now() })
  if (householdChanges.size > 50) householdChanges.delete(householdChanges.keys().next().value)
}
function undoHouseholdChange(changeId) {
  const extra = householdChanges.get(changeId) ?? { runIds: [], taskIds: [] }
  householdChanges.delete(changeId)
  let undone = 0
  const fromList = inbox.undo(changeId)
  if (fromList.ok) {
    relinkAfterUndo(fromList.restored, { closeTask, reopenTask })
    undone += 1
  }
  for (const runId of extra.runIds) if (checklists.cancelRun(runId).ok) undone += 1
  for (const taskId of extra.taskIds) {
    if (tasks.removeTask(taskId).ok) {
      checklists.uncommitTask(taskId)
      undone += 1
    }
  }
  return undone > 0
}
/**
 * Today's household routines for the kiosk: every step with its state and
 * timer, so each one can be done or undone from the iPad (v0.175.0). A routine
 * finished in the last ten minutes stays, so its last tap can be taken back.
 */
const KIOSK_DONE_GRACE_MS = 10 * 60_000
function kioskRoutines(now = Date.now()) {
  return checklists.snapshot(now).active
    .filter(run => run.space === 'life' && run.kind === 'ondemand')
    .filter(run => !run.complete || (run.lastAt && now - run.lastAt < KIOSK_DONE_GRACE_MS))
    .map(run => ({
      runId: run.runId,
      name: run.name,
      done: run.done,
      total: run.total,
      complete: run.complete,
      currentItemId: run.currentItemId,
      steps: run.items.map(item => ({
        id: item.id,
        label: item.label,
        stepKind: item.stepKind,
        done: item.done,
        at: item.at,
        estimateMinutes: item.estimateMinutes,
        waitMinutes: item.waitMinutes,
        endsAt: item.endsAt,
        running: item.running,
      })),
    }))
}
function listToday() {
  const committed = new Set(checklists.committedTaskIds('life'))
  return {
    routines: kioskRoutines(),
    tasks: tasks.list()
      .filter(task => task.space !== 'ops' && committed.has(task.id))
      .map(task => {
        const last = task.notes?.at(-1)
        return {
          id: task.id,
          label: task.label,
          note: task.note,
          estimateMinutes: task.estimateMs ? Math.round(task.estimateMs / 60_000) : null,
          window: task.window,
          open: task.open,
          opensLabel: task.opensLabel,
          lastNote: last ? { text: String(last.text).slice(0, 160), at: last.at } : null,
          noteCount: task.notes?.length ?? 0,
        }
      }),
    followups: followups.visible(checklists.dayKey(), 'life'),
  }
}
const joinNames = names => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)
const triage = new Triage()

let probeText = ''
let screenFrame = { text: '', at: 0 }

const tasks = new Tasks(
  JSON.parse(readFileSync(process.env.TASKS_PATH || join(HERE, 'tasks.config.json'), 'utf8')),
  { storePath: join(DATA_DIR, 'tasks.json'), logPath: join(DATA_DIR, 'tasks.jsonl') },
)

const jobs = new Jobs({
  storePath: join(DATA_DIR, 'jobs.json'),
  logPath: join(DATA_DIR, 'jobs.jsonl'),
})

function commandReady(command) {
  return spawnSync('/bin/sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' }).status === 0
}

const assistant = new AssistantChat({
  storePath: join(DATA_DIR, 'assistant.json'),
  providerReady: {
    chatgpt: commandReady('codex'),
    claude: commandReady('claude'),
  },
})

const coach = new Coach({
  storePath: join(DATA_DIR, 'coach.json'),
  logPath: join(DATA_DIR, 'coach.jsonl'),
})

// Dated follow-ups (v0.170.0): shown on Home from 7 days before their day.
const followups = new Followups({
  storePath: join(DATA_DIR, 'followups.json'),
  logPath: join(DATA_DIR, 'followups.jsonl'),
})

const recordings = new Recordings({
  rootPath: join(DATA_DIR, 'recordings'),
})

const spokenWork = new SpokenWork({
  logPath: join(DATA_DIR, 'spoken-work.jsonl'),
  indexPath: join(DATA_DIR, 'spoken-work.json'),
})
try {
  const recovery = reconcileRecentCaptures({ store: spokenWork, inventory: legacySpokenInventory(DATA_DIR), recordings })
  if (recovery.imported || recovery.failures.length) console.warn(`[spoken-work] recovered ${recovery.imported} recent captures; ${recovery.failures.length} failed`)
  for (const failure of recovery.failures) console.warn(`[spoken-work] could not recover ${failure.sourceKey}: ${failure.error}`)
} catch (error) { console.warn(`[spoken-work] recent capture recovery failed: ${error.message}`) }
for (const day of checklists.dayStarts.values()) {
  for (const commit of day.draftCommits || []) {
    try { spokenWork.linkStartDayCommit(commit.id, commit.sourceLinks) }
    catch (error) { console.warn(`[spoken-work] could not reconcile Start Day ${commit.id}: ${error.message}`) }
  }
}

const morningBrief = new MorningBrief({
  storePath: join(DATA_DIR, 'morning-brief.json'),
  timezone: checklists.timezone,
})

async function refreshMorningWeather(reason = 'poll') {
  const result = await refreshWeatherBrief({
    morningBrief,
    env: process.env,
    logger: console,
  })
  if (!result.ok) console.warn(`[weather] ${reason}: ${result.error}`)
}

function scheduleMorningWeather(delayMs = 0) {
  setTimeout(() => {
    refreshMorningWeather('poll')
      .catch(err => console.warn(`[weather] poll: ${err.message}`))
      .finally(() => {
        scheduleMorningWeather(weatherRefreshDelayMs({
          now: new Date(),
          timeZone: checklists.timezone,
          env: process.env,
        }))
      })
  }, delayMs)
}

async function refreshMorningMail(reason = 'poll') {
  const result = await refreshMailBrief({
    morningBrief,
    env: process.env,
    logger: console,
  })
  if (!result.ok) console.warn(`[mail] ${reason}: ${result.error}`)
}

function scheduleMorningMail(delayMs = 0) {
  setTimeout(() => {
    refreshMorningMail('poll')
      .catch(err => console.warn(`[mail] poll: ${err.message}`))
      .finally(() => {
        scheduleMorningMail(mailRefreshDelayMs({
          now: new Date(),
          timeZone: checklists.timezone,
          env: process.env,
        }))
      })
  }, delayMs)
}

// Apply replies that landed just before a restart and resume any persisted
// per-provider backlog without waiting for the glasses to open Chat.
assistant.syncAll(jobs)

const restoredCoachSessions = ['ops', 'life']
  .map(space => coach.currentSession(space)?.id)
  .filter(Boolean)
const staleCoachJobs = jobs.discardStaleCoachCues(restoredCoachSessions)
if (staleCoachJobs) console.log(`[jobs] discarded ${staleCoachJobs} stale Coach cue(s)`)

const AGENT_TOKEN = process.env.AGENT_TOKEN || ''
if (!AGENT_TOKEN) {
  console.warn('[warn] AGENT_TOKEN is empty — the job queue is unauthenticated.')
}

/**
 * How the hub decides work needs doing.
 *
 * It only ever *creates* jobs; it never does them. Whether anything gets
 * processed depends on an agent being alive somewhere, which is normally the
 * Mac at home. If nothing is running, raw items are still on the glasses —
 * processing is a second lane, not the critical path.
 */
function enqueueTriage() {
  const pending = inbox.pending()
  if (pending.length === 0) return

  // One job per batch, not per item: the thinking is cheaper in bulk, and a
  // batch is still small enough that one bad line cannot strand twenty.
  const open = [...jobs.jobs.values()].find(
    j => j.capability === 'triage' && [JOB.QUEUED, JOB.CLAIMED].includes(j.status),
  )
  if (open) return

  jobs.create({
    capability: 'triage',
    input: { items: pending.slice(0, 20).map(i => ({ id: i.id, text: i.text, by: i.by })) },
    idempotencyKey: `triage:${pending[0].id}:${pending.length}`,
  })
}

function enqueueListLabels() {
  const seen = new Set()
  for (const item of inbox.active(300)) {
    if (item.kind !== 'shopping' || item.list !== 'Groceries' || item.raw) continue
    const name = String(item.name || item.text || '').trim()
    const key = name.toLocaleLowerCase('en-US').replace(/\s+/g, ' ')
    if (!key || seen.has(key) || inbox.labelFor(name)) continue
    seen.add(key)
    const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
    jobs.create({
      capability: 'list.label',
      input: { name },
      idempotencyKey: `list.label:${hash}:${new Date().toISOString().slice(0, 10)}`,
    })
  }
}

/** Apply a triage job's result back onto the inbox. */
function applyTriageResult(result) {
  const rows = Array.isArray(result) ? result : result?.items
  if (!Array.isArray(rows)) return 0
  let applied = 0
  for (const row of rows) {
    const id = row.itemId ?? row.id
    if (!id) continue
    const out = inbox.sort(id, {
      kind: row.kind,
      list: row.list,
      parts: Array.isArray(row.parts) ? row.parts : null,
      note: row.note ?? null,
    })
    if (out.ok) applied += 1
  }
  return applied
}

const WEB_DIR = join(HERE, 'web')
/** Glasses paint diagnostics, next to hub.log (gitignored). */
const PAINT_LOG = join(HERE, '..', '..', 'paint.log')

/**
 * Turn checklist stats into planner input, folding in whatever is already
 * underway: a wash with twelve minutes left means that chore cannot be touched
 * for twelve minutes, and planning as if it were fresh would be a lie.
 */
function choresForPlan(requestedIds, space, now = Date.now()) {
  const active = checklists.snapshot(now).active
  const stats = checklists.allStats()

  return stats
    .filter(s => s.plan.length > 0)
    // One space at a time. Without this the running order was every checklist
    // in the config, so Storm Prep and Vendor Walk sat at the bottom of the
    // Life list — work lists on the screen you look at to decide whether you
    // have time to load the dishwasher.
    .filter(s => !space || (s.space ?? 'ops') === space)
    // Chores whose steps all have durations can be scheduled. The rest are
    // still returned — they are listed after the schedule with no time rather
    // than hidden, because "call the plumber" is exactly the kind of thing
    // that needs to stay in front of you.
    .map(s => ({ ...s, schedulable: s.plan.every(step => step.hasDuration) }))
    .filter(s => requestedIds.length === 0 || requestedIds.includes(s.checklistId))
    .map(s => {
      // A partial Start Day run can be complete even though it intentionally
      // contains only the named tail of a routine. Keep using that run as the
      // source of included/done step IDs. Ignoring it here rebuilt the whole
      // template immediately after its last included step was checked, so
      // "Vacuum" followed by "Empty canister" came straight back again.
      const run = active.find(r => r.checklistId === s.checklistId)

      // Drop every completed step individually, rather than slicing from a
      // cursor. The cursor model assumed you work top to bottom; Mike works a
      // list out of order by design, so a step finished early stayed in the
      // running order and kept adding its minutes to every total below it.
      // What is left is what is left, whatever order it got done in.
      let steps = remainingPlanSteps(s.plan, run)
        .map((step, i, remaining) => ({ ...step, position: i + 1, total: remaining.length }))

      let readyAt = 0

      // A wait already running blocks this chore until it finishes, and is not
      // work you have to come back and do — so it comes out of the list and
      // becomes a delay on whatever follows it.
      const first = steps[0]
      if (first && first.stepKind === 'wait') {
        const item = run?.items.find(i => i.id === first.id)
        if (item && item.remainingSeconds !== null && item.endsAt) {
          readyAt = Math.max(0, item.remainingSeconds * 1000)
          steps = steps.slice(1)
        }
      }

      return {
        id: s.checklistId,
        name: s.name,
        space: s.space,
        steps,
        startIndex: 0,
        readyAt,
        schedulable: steps.every(step => step.hasDuration),
      }
    })
}

/**
 * Big-ticket tasks, as their own list.
 *
 * They were briefly folded into the agenda so the glasses needed no new view,
 * and the running total ran straight through them. That was wrong twice over:
 * these are not things you slot into a spare twenty minutes, and counting an
 * hour of tyre-fitting into the total made the number beside the dishwasher
 * useless for the one question it exists to answer.
 *
 * So: separate list, no cumulative column, different shape on screen.
 */
function taskRows(space) {
  return tasks
    .list()
    .filter(t => !space || t.space === space)
    .map(t => ({
    kind: 'task',
    taskId: t.id,
    label: t.label,
    note: t.note ?? '',
    ms: t.estimateMs,
    open: t.open,
    weight: t.weight,
    opensLabel: t.opensLabel,
    needsPlan: t.needsPlan === true,
    notes: t.notes,
  }))
}

/**
 * The running total down the chore list.
 *
 * Read down the column until it passes the time you have; everything above
 * the line is what you can get done. Big-ticket tasks are deliberately not in
 * it — they live above the list, not in it.
 */
/**
 * What you have already done, kept on screen.
 *
 * Completed steps leave the schedule — their time is off the totals — but they
 * do not leave the page. Two reasons, both from use: an accidental click has
 * to be undoable, and a list that only ever shrinks gives you no evidence you
 * did anything. These rows are that evidence, with the time each one actually
 * took.
 *
 * They sit at the bottom, because this is a look back and the work is what you
 * came to the screen for.
 */
function doneRows(space, now = Date.now()) {
  const rows = []
  for (const run of checklists.snapshot(now).active) {
    if (space && (run.space ?? 'ops') !== space) continue
    for (const item of run.items) {
      if (!item.done || !item.at) continue
      // Today only. Yesterday's dishes are history, not progress.
      if (now - item.at > 16 * 3600_000) continue
      rows.push({
        kind: 'done',
        chore: run.name,
        choreId: run.checklistId,
        runId: run.runId,
        step: item.label,
        stepId: item.id,
        at: item.at,
        ms: item.tookMs ?? null,
        cumulativeBusyMs: null,
        cumulativeWallMs: null,
      })
    }
  }
  return rows.sort((a, b) => a.at - b.at)
}

function withRunningTotal(rows) {
  let busy = 0
  for (const row of rows) {
    if (row.kind === 'gap') {
      // A gap adds real time and no work. Both columns still get filled: a
      // blank row in the middle of the two totals breaks the scan down the
      // page, which is the only thing the columns are for.
      row.cumulativeBusyMs = busy
      row.cumulativeWallMs = row.at + row.ms
      continue
    }
    if (typeof row.ms === 'number') {
      busy += row.ms
      row.cumulativeBusyMs = busy
    } else {
      row.cumulativeBusyMs = null
    }
    // Wall clock: how long you have to actually be here to reach this step,
    // waits included. The busy total says you can put the laundry away after
    // 30 minutes of work; this says you will still be in the house at 1h40,
    // because the washer has to run. Both are true and they answer different
    // questions — "is this worth starting" and "can I leave".
    row.cumulativeWallMs = typeof row.endsAt === 'number' ? row.endsAt : null
  }
  return rows
}

/**
 * Put finished steps back where they belong.
 *
 * They were appended at the bottom, which meant undoing a misclick was a long
 * scroll away and the step reappeared somewhere unrelated to where it sat in
 * the chore. A done step goes immediately before the first remaining step of
 * its own chore, so the list still reads as that chore's sequence. A chore
 * with nothing left goes at the end, because there is nothing for it to sit
 * in front of.
 */
function withDoneInline(rows, done) {
  const out = [...rows]
  for (const row of done) {
    const at = out.findIndex(r => r.kind === 'do' && r.choreId === row.choreId)
    if (at === -1) out.push(row)
    else out.splice(at, 0, row)
  }
  return out
}

function buildPlan(minutes, requestedIds, space) {
  const rawDay = space ? checklists.dayStatus(space) : null
  const openTaskIds = space
    ? new Set(taskRows(space).map(task => task.taskId))
    : new Set()
  const carriedTaskIds = space
    ? checklists.committedTaskIds(space).filter(id => openTaskIds.has(id))
    : []
  // A committed one-off remains on Home until it is done, even after the
  // operational day changes. The persisted day record stays untouched; this
  // merged view is only the plan contract consumed by the glasses.
  const day = rawDay
    ? { ...rawDay, taskIds: [...new Set([...(rawDay.taskIds ?? []), ...carriedTaskIds])] }
    : null
  let selectedIds = requestedIds
  if (space === 'life' && requestedIds.length === 0) {
    const activeIds = checklists.snapshot().active
      .filter(run => run.kind === 'ondemand' && run.space === 'life' && !run.complete)
      .map(run => run.checklistId)
    selectedIds = [...new Set([...(day?.checklistIds ?? []), ...activeIds])]
    // An empty array means "all" to choresForPlan. Before Start Day it must
    // mean the opposite: no chores have been chosen yet.
    if (selectedIds.length === 0) selectedIds = ['__no_daily_chores_selected__']
  }

  const all = choresForPlan(selectedIds, space)
  const chores = all.filter(c => c.schedulable)
  const unestimated = all.filter(c => !c.schedulable)
  const plan = planBlock(chores, minutes)
  return {
    ...plan,
    day,
    morningBrief: space
      ? morningBrief.snapshot({ space, dayStatus: day })
      : null,
    // Tasks lead the screen, but as their own section above the list rather
    // than as rows in it. Scheduling by efficiency would bury every one of
    // them behind a dishwasher; folding them into the total corrupts it.
    tasks: taskRows(space),
    // Dated follow-ups due within the week (or overdue): one-click rows on Home.
    followups: space ? followups.visible(checklists.dayKey(), space) : [],
    agenda: withDoneInline(withRunningTotal(agenda(plan, unestimated)), doneRows(space)),
    // Solo reach per chore, so the "what fits" screen can answer
    // "how far do I get with just this one" without a second request.
    reach: chores.map(c => ({ choreId: c.id, name: c.name, ...reach(c, minutes) })),
  }
}

function cueSpace(value) {
  return value === 'life' ? 'life' : 'ops'
}

function queuedNote(kind, subjectId, noteId) {
  if (kind === 'task') {
    const note = tasks.notes(subjectId).find(row => row.id === noteId)
    const task = tasks.taskDefs().find(row => row.id === subjectId)
    return note ? { note, label: task?.label || 'Captured note' } : null
  }
  if (kind === 'chore') {
    const note = checklists.notes(subjectId).find(row => row.id === noteId)
    const checklist = checklists.templates.get(subjectId)
    return note ? { note, label: checklist?.name || 'Chore note' } : null
  }
  return null
}

function queuedNoteText(found) {
  const parts = [
    'Work this item from my WAM Notes queue as my next message.',
    `Subject: ${found.label}`,
    '',
    found.note.text,
  ]
  if (found.note.id.endsWith(':note')) {
    const sessionId = found.note.id.slice(0, -':note'.length)
    const session = coach.session(sessionId)
    const transcript = transcriptText(session?.segments ?? [], 2_800)
    if (transcript && !found.note.text.includes(transcript)) {
      parts.push('', 'Original spoken context:', transcript)
    }
  }
  parts.push('', 'If this is actionable, do the requested work. If it is reference only, return the useful conclusion and next concrete step without inventing one.')
  return parts.join('\n').slice(0, 4_000)
}

function latestCoachModelCueForSession(space, sessionId, now = Date.now(), freshOnly = true, finalOnly = false) {
  if (!sessionId) return null

  const freshMs = Math.max(AI_CUE_INTERVAL_MS * 4, 2 * 60_000)
  return [...jobs.jobs.values()]
    .filter(job => job.capability === 'coach.cue' && job.status === JOB.DONE)
    .filter(job => job.input?.space === space && job.input?.sessionId === sessionId)
    .filter(job => !finalOnly || job.input?.finalNote)
    .filter(job => !freshOnly || job.updatedAt >= now - freshMs)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(job => ({
      ...job.result,
      sourceJobId: job.id,
      jobUpdatedAt: job.updatedAt,
      sourceSegmentCount: job.input?.session?.segmentCount ?? null,
    }))
    .find(result => result && typeof result === 'object') ?? null
}

function latestCoachModelCue(space, coachSnapshot, now = Date.now()) {
  return latestCoachModelCueForSession(space, coachSnapshot.session?.id, now)
}

function coachAiState(session) {
  if (!session) return null
  const segmentCount = Number(session.segmentCount) || 0
  const latest = [...jobs.jobs.values()]
    .filter(job => job.capability === 'coach.cue' && job.input?.sessionId === session.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]

  if (!latest) return { status: 'listening', segmentCount: 0, updatedAt: null }
  const sourceSegmentCount = Number(latest.input?.session?.segmentCount) || 0
  if (sourceSegmentCount < segmentCount) {
    return { status: 'listening', segmentCount: sourceSegmentCount, updatedAt: latest.updatedAt }
  }
  if ([JOB.QUEUED, JOB.CLAIMED].includes(latest.status)) {
    return { status: 'thinking', segmentCount: sourceSegmentCount, updatedAt: latest.updatedAt }
  }
  if (latest.status === JOB.FAILED) {
    return { status: 'error', segmentCount: sourceSegmentCount, updatedAt: latest.updatedAt }
  }
  return {
    status: latest.result?.quiet === true ? 'quiet' : 'cue',
    segmentCount: sourceSegmentCount,
    updatedAt: latest.updatedAt,
  }
}

function modelRunningNote(modelResult, fallback = null) {
  const raw = modelResult?.runningNote
  const sourceLines = Array.isArray(raw?.lines)
    ? raw.lines
    : [raw?.thread && `Thread: ${raw.thread}`, raw?.now && `Now: ${raw.now}`, raw?.hold && `Hold: ${raw.hold}`]
  const lines = sourceLines
    .map(line => String(line || '').replace(/\s+/g, ' ').trim().slice(0, 42))
    .filter(Boolean)
    .slice(0, 3)

  if (lines.length === 0) return fallback
  const sourceSegmentCount = Number(modelResult.sourceSegmentCount) || 0
  return {
    title: 'Conversation compass',
    lines,
    updatedAt: modelResult.jobUpdatedAt || Date.now(),
    segmentCount: sourceSegmentCount,
  }
}

/**
 * The Listen board's topics and condensed points (v0.103.0), passed through
 * from the newest model result. Older worker results have no board: null.
 */
function modelBoard(modelResult) {
  const raw = modelResult?.board
  if (!raw || typeof raw !== 'object') return null
  const clean = (list, max, chars) => (Array.isArray(list) ? list : [])
    .map(line => String(line || '').replace(/\s+/g, ' ').trim().slice(0, chars))
    .filter(Boolean)
    .slice(-max)
  const topics = clean(raw.topics, 8, 60)
  const points = clean(raw.points, 5, 140)
  const overallTopic = String(raw.overallTopic || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const sections = clean(raw.sections, 7, 60)
  const currentSummary = clean(raw.currentSummary, 6, 160)
  if (topics.length === 0 && points.length === 0 && !overallTopic && sections.length === 0 && currentSummary.length === 0) return null
  return {
    topics,
    points,
    overallTopic,
    sections,
    currentSummary,
    updatedAt: modelResult.jobUpdatedAt || Date.now(),
    segmentCount: Number(modelResult.sourceSegmentCount) || 0,
  }
}

function coachSnapshotWithModel(space, now = Date.now()) {
  const snapshot = coach.snapshot(space)
  const modelCue = latestCoachModelCue(space, snapshot, now)
  if (snapshot.session) {
    snapshot.session = {
      ...snapshot.session,
      runningNote: modelRunningNote(modelCue, snapshot.session.runningNote),
      board: modelBoard(modelCue),
      aiState: coachAiState(snapshot.session),
    }
  }
  return { snapshot, modelCue }
}

function publicCoachModelCue(modelCue) {
  const lines = Array.isArray(modelCue?.lines)
    ? modelCue.lines.map(line => String(line || '').trim()).filter(Boolean).slice(0, 3)
    : []
  if (!modelCue || modelCue.quiet === true || lines.length === 0) return null
  return {
    id: `model-${modelCue.sourceJobId}`,
    title: String(modelCue.title || 'Coach').slice(0, 30),
    lines,
    kind: modelCue.kind || 'thought',
    priority: Number(modelCue.priority) || 0,
    quiet: false,
    createdAt: modelCue.jobUpdatedAt,
    expiresAt: modelCue.jobUpdatedAt + Math.max(AI_CUE_INTERVAL_MS * 4, 2 * 60_000),
    nextAfterMs: AI_CUE_INTERVAL_MS,
  }
}

function modelNoteSummary(modelResult) {
  const board = modelBoard(modelResult)
  const recapLines = modelResult?.kind === 'recap' && Array.isArray(modelResult.lines)
    ? modelResult.lines
    : []
  const note = modelRunningNote(modelResult)
  return composeListenSummary(board, recapLines, note?.lines)
}

function applyFinalListenSummary(job, modelResult) {
  const target = job?.input?.finalNote
  if (!target?.subjectId || !target?.noteId) return { ok: false, error: 'no final note target' }
  const summary = modelNoteSummary(modelResult)
  if (!summary) return { ok: false, error: 'model returned no summary' }
  if (target.kind === 'chore') {
    return checklists.updateNote(target.subjectId, target.noteId, summary, 'listen-ai')
  }
  return tasks.updateNote(target.subjectId, target.noteId, summary, 'listen-ai')
}

function upgradeListenNoteSummaries() {
  let upgraded = 0
  for (const task of tasks.taskDefs()) {
    for (const note of tasks.notes(task.id)) {
      if (!['listen', 'listen-ai'].includes(note.by) || !note.id?.endsWith(':note')) continue
      const sessionId = note.id.slice(0, -':note'.length)
      const session = coach.session(sessionId)
      if (!session) continue
      const modelResult = latestCoachModelCueForSession(cueSpace(session.space), sessionId, Date.now(), false, true)
      // A model summary when there is one; otherwise clean up the raw text
      // that was saved while no worker was running. The newline test is what
      // stops this running twice over the same note: a distilled note already
      // has its title on the first line.
      const summary = modelNoteSummary(modelResult)
        || (note.by === 'listen' && !note.text.includes('\n') ? distillNote(note.text) : null)
      if (!summary || summary === note.text) continue
      const modelBacked = Boolean(modelNoteSummary(modelResult))
      const result = tasks.updateNote(task.id, note.id, summary, modelBacked ? 'listen-ai' : 'listen')
      if (result.ok) upgraded += 1
    }
  }
  return upgraded
}

const upgradedListenNotes = upgradeListenNoteSummaries()
if (upgradedListenNotes) console.log(`[coach] upgraded ${upgradedListenNotes} Listen note summar${upgradedListenNotes === 1 ? 'y' : 'ies'}`)

const coachCueTimers = new Map()
/** When each session last asked the model for a fresh read. */
const coachQueuedAt = new Map()

function scheduleCoachCue(session) {
  if (!session?.active || session.context?.taskId === '__assistant__') return
  const prior = coachCueTimers.get(session.id)
  if (prior) clearTimeout(prior)
  const expectedCount = session.segmentCount

  // Steady speech: every new segment resets the lull timer below, so without
  // this the board would not update until someone paused.
  const now = Date.now()
  const last = coachQueuedAt.get(session.id)
  if (last === undefined) {
    coachQueuedAt.set(session.id, now)
  } else if (now - last >= AI_NOTE_MAX_WAIT_MS) {
    coachQueuedAt.set(session.id, now)
    queueCoachCue(session.space, { reason: 'speech-steady' })
  }

  const timer = setTimeout(() => {
    coachCueTimers.delete(session.id)
    coachQueuedAt.set(session.id, Date.now())
    const current = coach.currentSession(session.space)
    if (!current || current.id !== session.id || current.segments.length !== expectedCount) return
    queueCoachCue(session.space, { reason: 'speech-lull' })
  }, AI_CUE_LULL_MS)
  coachCueTimers.set(session.id, timer)
}

function createCoachCueJob(session, {
  reason = 'poll',
  priority = 'normal',
  finalNote = null,
  fullTranscript = '',
  previousRunningNote = null,
  previousBoard = null,
} = {}) {
  if (!session) return null
  const safeSpace = cueSpace(session.space)
  const mode = coach.getMode(session.modeId) ?? coach.activeMode(safeSpace)
  const transcriptWindow = finalNote ? undefined : mode.id === 'notes' ? -96 : -32
  const sourceSegments = finalNote
    ? fullTranscript
      ? [{ id: `${session.id}:full`, at: session.endedAt || Date.now(), speaker: 'me', text: fullTranscript }]
      : mergeRawSegments(session.segments, recordings.transcript(session.id))
    : session.segments ?? session.recentSegments
  const recentSegments = coalesceTranscriptSegments(sourceSegments)
    .slice(transcriptWindow)
    // Solo Notes is one person thinking aloud. Direction-based speaker guesses
    // can split one sentence into a fake conversation and distort summaries.
    .map(segment => mode.id === 'notes' ? { ...segment, speaker: 'me' } : segment)
  if (recentSegments.length === 0) return null
  const segmentCount = session.segments?.length ?? session.segmentCount ?? recentSegments.length
  return jobs.create({
    capability: 'coach.cue',
    input: {
      space: safeSpace,
      reason,
      mode,
      sessionId: session.id,
      session: {
        id: session.id,
        title: session.title,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        segmentCount,
      },
      recentSegments,
      previousRunningNote,
      previousBoard,
      ...(finalNote ? { finalNote } : {}),
      constraints: {
        titleChars: 30,
        // Cues have a whole 288x144 tile on the Listen board now (v0.103.0).
        lineChars: 90,
        maxLines: 3,
        noteLineChars: 42,
        boardTopics: 8,
        boardTopicChars: 44,
        boardPoints: 4,
        boardPointChars: 120,
        overallTopicChars: 60,
        boardSections: 7,
        boardSectionChars: 44,
        currentSummaryPoints: 6,
        currentSummaryChars: 120,
        allowedKinds: ['answer', 'followup', 'factcheck', 'advice', 'thought', 'recap'],
      },
    },
    // A transcript revision is the unit of thought. Audio ingestion debounces
    // this until a lull, and deliberate polls dedupe against the same revision.
    idempotencyKey: finalNote
      ? `coach.cue:${session.id}:final:${segmentCount}`
      : `coach.cue:${session.id}:segments:${segmentCount}`,
    priority,
    replaceQueued: true,
  })
}

function queueCoachCue(space, { reason = 'poll', priority = 'normal' } = {}) {
  const safeSpace = cueSpace(space)
  const now = Date.now()
  const { snapshot, modelCue } = coachSnapshotWithModel(safeSpace, now)
  const session = snapshot.session
  const sourceSession = coach.currentSession(safeSpace)
  if (!session?.active || !sourceSession) return null
  return createCoachCueJob(sourceSession, {
    reason,
    priority,
    previousRunningNote: modelRunningNote(modelCue, session.runningNote),
    previousBoard: modelBoard(modelCue),
  })
}

function buildCurrentCue(space, now = Date.now()) {
  const safeSpace = cueSpace(space)
  const checklistsState = checklists.snapshot(now)
  const { snapshot: coachSnapshot, modelCue } = coachSnapshotWithModel(safeSpace, now)
  return buildCue({
    space: safeSpace,
    snapshot: store.snapshot(now),
    plan: buildPlan(720, [], safeSpace),
    checklistsState,
    inboxGroups: inbox.grouped(),
    dueWaits: checklists.dueWaits(now),
    jobsSummary: jobs.summary(now),
    coach: coachSnapshot,
    modelCue,
    now,
    intervalMs: AI_CUE_INTERVAL_MS,
  })
}

const CAPTURE_TASK_ID = 'captured-notes'
const ROUTE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'about',
  'add',
  'for',
  'make',
  'me',
  'note',
  'on',
  'the',
  'to',
])

function normalizeRouteText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function routeTokens(value) {
  return normalizeRouteText(value)
    .split(' ')
    .filter(token => token.length > 1 && !ROUTE_STOP_WORDS.has(token))
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function taskAliases(task) {
  return [
    task.id,
    String(task.id || '').replace(/-/g, ' '),
    task.label,
    task.note,
  ]
    .map(normalizeRouteText)
    .filter(Boolean)
}

function findTaskForText(text, space = null) {
  const query = normalizeRouteText(text)
  const words = new Set(routeTokens(query))
  if (!query || words.size === 0) return null

  let best = null
  let bestScore = 0
  for (const task of tasks.taskDefs()) {
    if (space && (task.space ?? 'life') !== space) continue
    let score = 0
    for (const alias of taskAliases(task)) {
      if (alias && query.includes(alias)) score = Math.max(score, 10 + alias.length / 100)
    }
    const taskWords = new Set(routeTokens(`${task.id} ${task.label} ${task.note ?? ''}`))
    let common = 0
    for (const word of taskWords) if (words.has(word)) common += 1
    if (common) score = Math.max(score, common)
    if (score > bestScore) {
      best = task
      bestScore = score
    }
  }
  return bestScore >= 1 ? best : null
}

function stripTargetFromNote(rest, task) {
  const aliases = taskAliases(task).sort((a, b) => b.length - a.length)
  for (const alias of aliases) {
    const pattern = new RegExp(`\\b${alias.split(' ').map(regexEscape).join('\\W+')}\\b\\s*(?:that\\s+)?`, 'i')
    const match = String(rest).match(pattern)
    if (!match) continue
    const note = String(rest).slice((match.index ?? 0) + match[0].length).trim()
    if (note) return note
  }
  return null
}

function parseNoteCommand(text, space) {
  const raw = String(text || '').trim()
  const match = raw.match(/^(?:(?:make|add|save|take)\s+)?(?:a\s+)?note\s+(?:on|for|about|to)\s+(.+)$/i)
  if (!match) return null

  const rest = match[1].trim()
  const splitters = [/\s+that\s+/i, /\s+saying\s+/i, /\s+to say\s+/i, /\s+-\s+/, /\s*:\s*/]
  for (const splitter of splitters) {
    const parts = rest.split(splitter)
    if (parts.length < 2) continue
    const target = findTaskForText(parts[0], space)
    const note = parts.slice(1).join(' ').trim()
    if (target && note) return { task: target, text: note }
  }

  const task = findTaskForText(rest, space)
  if (!task) return null
  return { task, text: stripTargetFromNote(rest, task) || raw }
}

function ensureCaptureTask(space, at = Date.now()) {
  return tasks.ensureTask(
    {
      id: CAPTURE_TASK_ID,
      label: 'Captured notes',
      weight: 'normal',
      window: 'anytime',
      space,
      note: 'Unsorted Listen captures',
      by: 'listen',
      clientId: `system:${CAPTURE_TASK_ID}`,
    },
    at,
  )
}

function consolidatedSessionNote(session, fullText = '') {
  const max = session?.context?.taskId === '__day_start__'
    ? 4_000
    : session?.modeId === 'notes'
      ? 8_000
      : 4_000
  return String(fullText || '').trim().slice(0, max) || transcriptText(mergeRawSegments(session?.segments, recordings.transcript(session?.id)), max)
}

function soundsLikePlan(label) {
  return /\b(?:build|create|design|organize|sort out|clean out|set up|prepare|plan|project|renovate|move|apply for (?:\w+\s+)?(?:jobs|positions))\b/i.test(label)
}

function routeCoachSession(session, at = Date.now(), fullText = '') {
  const rawText = consolidatedSessionNote(session, fullText)
  if (!rawText) return { kind: 'empty', result: { ok: true } }
  if (session.context?.reviewItemId) return { kind: 'amendment', result: { ok: true } }
  const noteId = `${session.id}:note`
  const space = cueSpace(session.space)

  if (session.context?.taskId === '__day_start__') {
    // Ending the recording creates a durable proposal only. Nothing reaches
    // the real list until the wearer reviews it and confirms Use this list.
    const result = checklists.draftDay(rawText, space, session.id, at, tasks.list(at).filter(task => task.space === space).map(task => task.label))
    return { kind: 'day-draft', result }
  }

  const dayRow = String(session.context?.taskId || '').match(/^__day_(label|note)__:(.+)$/)
  if (dayRow) {
    const value = dayRow[1] === 'label'
      ? rawText.replace(/^(?:no[, ]+|i meant |change (?:it|that) to |call it )/i, '').trim()
      : rawText
    const result = checklists.reviseDayDraftItem(space, dayRow[2], { [dayRow[1]]: value }, at)
    return { kind: 'day-draft', result: result.ok ? { ...result, sourceItemIds: [dayRow[2]] } : result }
  }

  // Classification happens once, after the complete recording exists. A
  // fixed-duration STT chunk is not an utterance and must never create state.
  const taskText = parseTaskCommand(rawText)
  if (taskText) {
    const result = tasks.addTask({
      label: taskText,
      space,
      window: 'anytime',
      weight: 'big',
      firstNote: rawText,
      by: 'listen',
      clientId: `${session.id}:task`,
    }, at)
    return { kind: 'task', result }
  }

  const explicit = parseNoteCommand(rawText, space)
  if (explicit?.task?.id) {
    const result = tasks.addNote(explicit.task.id, explicit.text, 'listen', noteId, at)
    return { kind: 'note', taskId: explicit.task.id, result }
  }

  const fullSegments = mergeRawSegments(session.segments, recordings.transcript(session.id))
  const noteText = fullText || fallbackListenSummary(fullSegments) || rawText
  const noteBy = 'listen'

  const contextTaskId = session.context?.taskId
  if (contextTaskId && tasks.has(contextTaskId)) {
    const result = tasks.addNote(contextTaskId, noteText, noteBy, noteId, at)
    return {
      kind: 'task',
      taskId: contextTaskId,
      result,
      summaryTarget: { kind: 'task', subjectId: contextTaskId, noteId },
    }
  }

  const contextChoreId = session.context?.choreId
  if (contextChoreId && checklists.templates.has(contextChoreId)) {
    const result = checklists.addNote(contextChoreId, noteText, noteBy, noteId, at)
    return {
      kind: 'chore',
      choreId: contextChoreId,
      result,
      summaryTarget: { kind: 'chore', subjectId: contextChoreId, noteId },
    }
  }

  const capture = ensureCaptureTask(space, at)
  const taskId = capture.task?.id || CAPTURE_TASK_ID
  const result = tasks.addNote(taskId, noteText, noteBy, noteId, at)
  return {
    kind: 'capture',
    taskId,
    result,
    summaryTarget: { kind: 'task', subjectId: taskId, noteId },
  }
}

if (!INGEST_TOKEN) {
  console.warn('[warn] INGEST_TOKEN is empty — /ingest is unauthenticated. Set one before this leaves your bench.')
}

/**
 * CORS. The WebView enforces it regardless of the app.json whitelist, so both
 * gates have to pass. `*` is fine while READ_TOKEN is empty and the server is
 * on your LAN; set ALLOWED_ORIGIN once you know the plugin's origin.
 */
/**
 * One transcription at a time.
 *
 * whisper.cpp is CPU-bound, and a handful of chunks arriving together would
 * otherwise launch a handful of processes and make every one of them slower.
 * A queue of one keeps the Mac usable while it listens.
 */
const transcribeQueue = []
let transcribing = false

function pendingTranscriptions() {
  return transcribeQueue.length + (transcribing ? 1 : 0)
}

/**
 * What the transcriber has actually been doing.
 *
 * The glasses can prove audio left the building; without this there was no way
 * to see what happened to it after, short of reading the server's terminal.
 */
const sttStats = {
  queued: 0,
  ok: 0,
  empty: 0,
  failed: 0,
  lastError: null,
  lastText: null,
  lastMs: 0,
  lastDebugFile: null,
}

/**
 * Transcribe one clip and hand the text straight back.
 *
 * The iPad's record button is a person standing there waiting, not an ambient
 * stream — but it must not start a second whisper process alongside a live
 * coaching session, so it takes its turn in the same single-file queue and the
 * caller awaits it.
 */
function transcribeClip(pcm, body = {}) {
  return new Promise(resolve => {
    transcribeQueue.push({ sessionId: null, pcm, body, resolve })
    sttStats.queued += 1
    void drainTranscriptions()
  })
}

function waitForTranscriptions() {
  return new Promise(resolve => {
    transcribeQueue.push({ barrier: true, resolve })
    void drainTranscriptions()
  })
}

function enqueueTranscription(sessionId, pcm, body) {
  // A backlog means the model is slower than the speech. Dropping the oldest
  // is better than falling further behind for the rest of the conversation.
  if (transcribeQueue.length > 8) {
    const oldestChunk = transcribeQueue.findIndex(item => !item.resolve && !item.barrier)
    if (oldestChunk >= 0) transcribeQueue.splice(oldestChunk, 1)
  }
  transcribeQueue.push({ sessionId, pcm, body })
  sttStats.queued += 1
  void drainTranscriptions()
}

async function drainTranscriptions() {
  if (transcribing) return
  transcribing = true
  try {
    while (transcribeQueue.length) {
      const { sessionId, pcm, body, resolve, barrier } = transcribeQueue.shift()
      if (barrier) { resolve(); continue }
      const startedAt = Date.now()
      try {
        const out = await transcribePcm(pcm, {
          sampleRate: body.sampleRate,
          channels: body.channels,
          sessionId,
          clientId: body.clientId,
        })
        sttStats.lastMs = Date.now() - startedAt
        sttStats.lastDebugFile = out.debugPath || sttStats.lastDebugFile
        if (!out.ok) {
          sttStats.failed += 1
          sttStats.lastError = String(out.error || 'failed').slice(0, 60)
          console.warn(`[stt] ${out.error}`)
          resolve?.({ ok: false, error: out.error })
          continue
        }
        const text = String(out.text || '').trim()
        if (!text) {
          sttStats.empty += 1
          resolve?.({ ok: true, text: '' })
          continue
        }
        sttStats.ok += 1
        sttStats.lastText = text.slice(0, 60)
        // Ambient labels are diagnostics, not conversation. Persisting them
        // kept resetting the lull timer and buried speech under fake turns.
        // A one-shot clip is answered here and never becomes a coach segment,
        // so it cannot reset a lull timer or schedule a cue.
        if (resolve) {
          resolve({ ok: true, text: isNonSpeechText(text) ? '' : text })
          continue
        }
        if (isNonSpeechText(text)) continue
        const result = coach.addSegment(sessionId, {
          text,
          speaker: body.speakerRole === 'self' ? 'me' : body.speaker || 'someone',
          final: true,
          clientId: body.clientId,
          at: body.at,
        })
        if (result.ok && !result.duplicate) {
          const archived = recordings.addTranscriptSegment(sessionId, result.segment)
          if (!archived.ok) console.warn(`[recording] transcript: ${archived.error}`)
          if (result.session.context?.taskId !== '__assistant__' && !result.session.context?.reviewItemId) {
            scheduleCoachCue(result.session)
          }
        }
      } catch (err) {
        sttStats.failed += 1
        sttStats.lastError = String(err.message || err).slice(0, 60)
        console.warn(`[stt] ${err.message}`)
        resolve?.({ ok: false, error: err.message })
      }
    }
  } finally {
    transcribing = false
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, HEAD, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match')
  res.setHeader('Access-Control-Max-Age', '86400')
}

function json(res, code, body) {
  const payload = JSON.stringify(body)
  cors(res)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function phonePackageName() {
  try {
    const app = JSON.parse(readFileSync(join(HERE, '..', '..', 'glasses', 'app.json'), 'utf8'))
    return `wam-${app.version || 'latest'}.ehpk`
  } catch {
    return 'wam-latest.ehpk'
  }
}

function servePhonePackage(req, res) {
  let stats
  try {
    stats = statSync(PHONE_PACKAGE_PATH)
  } catch {
    return json(res, 404, {
      error: 'no phone package yet',
      hint: 'run npm run pack:private from glasses/',
    })
  }

  if (!stats.isFile()) return json(res, 404, { error: 'phone package path is not a file' })

  cors(res)
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stats.size,
    'Content-Disposition': `attachment; filename="${phonePackageName()}"`,
    'Cache-Control': 'no-store',
  })
  if (req.method === 'HEAD') return res.end()

  const stream = createReadStream(PHONE_PACKAGE_PATH)
  stream.on('error', err => {
    if (!res.headersSent) return json(res, 500, { error: err.message })
    res.destroy(err)
  })
  return stream.pipe(res)
}

function serveRecording(req, res, sessionId) {
  const wav = recordings.wav(sessionId)
  if (!wav) return json(res, 404, { error: 'recording not found' })

  const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/)
  let start = 0
  let end = wav.length - 1
  let status = 200
  if (range) {
    start = range[1] ? Number(range[1]) : 0
    end = range[2] ? Number(range[2]) : end
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= wav.length) {
      cors(res)
      res.writeHead(416, { 'Content-Range': `bytes */${wav.length}` })
      return res.end()
    }
    end = Math.min(end, wav.length - 1)
    status = 206
  }

  const body = wav.subarray(start, end + 1)
  cors(res)
  res.writeHead(status, {
    'Content-Type': 'audio/wav',
    'Content-Length': body.length,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `inline; filename="wam-${sessionId}.wav"`,
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}),
  })
  if (req.method === 'HEAD') return res.end()
  return res.end(body)
}

function readBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Constant-time bearer check. */
function authorized(req, expected) {
  if (!expected) return true
  const header = req.headers.authorization || ''
  const given = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(given.padEnd(expected.length).slice(0, expected.length))
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b) && given.length === expected.length
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204)
    res.end()
    return
  }

  if ((req.method === 'GET' || req.method === 'HEAD')
    && (url.pathname === '/downloads/latest' || url.pathname === '/downloads/latest.ehpk')) {
    return servePhonePackage(req, res)
  }

  // ---- the capture page -------------------------------------------------
  // Deliberately unauthenticated: it is reachable only on your own network,
  // and a login screen between someone and adding "milk" is exactly the
  // friction that stops a shared list being used. Put it behind a tunnel or
  // your LAN, not behind a password.
  // Font measurement harness. Dev-only: holds one string for the probe page
  // to render so widths can be read off the simulator's pixels.
  if (url.pathname === '/probe') {
    if (req.method === 'POST') {
      const raw = await readBody(req)
      try {
        probeText = JSON.parse(raw).text ?? ''
      } catch {
        probeText = raw
      }
      return json(res, 200, { ok: true })
    }
    return json(res, 200, { text: probeText })
  }

  // Keys pressed on /mirror, long-polled by the app on the glasses.
  if (await handleRemoteInput(req, res, url, { json, readBody })) return

  /**
   * Mirror of whatever is on the glasses.
   *
   * The hub cannot know what the display shows — the rendering happens in the
   * app — so the app posts each frame here and this hands it back. One string,
   * no second renderer to drift out of sync with the first.
   */
  // Diagnostic: one line per glasses paint that sent tiles (v0.113.0).
  if (req.method === 'POST' && url.pathname === '/paintlog') {
    const raw = await readBody(req)
    try {
      const entry = JSON.parse(raw)
      appendFileSync(PAINT_LOG, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`)
    } catch {}
    return json(res, 200, { ok: true })
  }

  if (url.pathname === '/screen') {
    if (req.method === 'POST') {
      const raw = await readBody(req)
      try {
        screenFrame = { text: String(JSON.parse(raw).text ?? ''), at: Date.now() }
      } catch {
        screenFrame = { text: raw, at: Date.now() }
      }
      return json(res, 200, { ok: true })
    }
    return json(res, 200, screenFrame)
  }

  // The chat screen's words, shared by the glasses and the WAM Home iPad app
  // (v0.177.0). One file, read where the glasses build it from.
  if (req.method === 'GET' && url.pathname === '/shared/chattext.js') {
    try {
      const js = readFileSync(join(HERE, '..', '..', 'glasses', 'src', 'chattext.js'))
      cors(res)
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(js)
    } catch {
      return json(res, 404, { error: 'not found' })
    }
  }

  if (req.method === 'GET' && url.pathname === '/mirror') {
    try {
      const html = readFileSync(join(WEB_DIR, 'mirror.html'))
      cors(res)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(html)
    } catch {
      return json(res, 404, { error: 'not found' })
    }
  }

  if (req.method === 'GET' && url.pathname === '/notes') {
    try {
      const html = readFileSync(join(WEB_DIR, 'tasks.html'))
      cors(res)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(html)
    } catch {
      return json(res, 404, { error: 'not found' })
    }
  }

  if (req.method === 'GET' && url.pathname === '/review') {
    try {
      const html = readFileSync(join(WEB_DIR, 'review.html'))
      cors(res)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(html)
    } catch {
      return json(res, 404, { error: 'not found' })
    }
  }

  if (req.method === 'GET' && (url.pathname === '/spoken-work' || url.pathname.startsWith('/spoken-work/'))) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    const inventory = legacySpokenInventory(DATA_DIR)
    if (url.pathname === '/spoken-work/inventory') {
      return json(res, 200, { ok: true, counts: inventory.counts,
        coverage: compareSpokenCoverage(inventory, spokenWork.all()), exceptions: inventory.exceptions })
    }
    if (url.pathname === '/spoken-work/resources') {
      return json(res, 200, { ok: true, resources: spokenWork.allResources(url.searchParams.get('kind')) })
    }
    const resourceMatch = url.pathname.match(/^\/spoken-work\/resources\/(.+)$/)
    if (resourceMatch) {
      const resource = spokenWork.resource(decodeURIComponent(resourceMatch[1]))
      return resource ? json(res, 200, { ok: true, resource }) : json(res, 404, { error: 'unknown review destination' })
    }
    const canonical = spokenWork.all()
    const bySource = new Map(inventory.items.map(item => [item.sourceKey, item]))
    for (const item of canonical) bySource.set(item.sourceKey, item)
    const all = [...bySource.values()].sort((left, right) => right.capturedAt - left.capturedAt || left.id.localeCompare(right.id))
    if (url.pathname !== '/spoken-work') {
      const destinationPreview = url.pathname.match(/^\/spoken-work\/([^/]+)\/destinations\/(task|project|idea|memory)\/preview$/)
      if (destinationPreview) {
        const id = decodeURIComponent(destinationPreview[1])
        const kind = destinationPreview[2]
        const result = kind === 'task' ? previewSpokenTaskUpdate({ store: spokenWork, tasks, itemId: id })
          : spokenWork.previewResourceUpdate(id, kind)
        return json(res, result.ok ? 200 : result.code || 400, result)
      }
      const eventMatch = url.pathname.match(/^\/spoken-work\/([^/]+)\/events$/)
      if (eventMatch) {
        const id = decodeURIComponent(eventMatch[1])
        return json(res, 200, { ok: true, events: spokenWork.history(id) })
      }
      const id = decodeURIComponent(url.pathname.slice('/spoken-work/'.length))
      const item = all.find(row => row.id === id)
      return item ? json(res, 200, { ok: true, item, events: spokenWork.history(id) }) : json(res, 404, { error: 'unknown spoken work item' })
    }
    const state = url.searchParams.get('state') || 'active'
    const query = String(url.searchParams.get('q') || '').trim().toLocaleLowerCase().slice(0, 120)
    const filtered = all.filter(item => state === 'all' || (state === 'active'
      ? item.reviewState === 'unreviewed' || item.reviewState === 'needs_clarification'
      : item.reviewState === state)).filter(item => !query || [item.title, item.summary,
        item.cleanedTranscript, item.rawTranscript?.text, item.sourceType, item.sourceKey,
        Number.isFinite(Number(item.capturedAt)) ? new Date(item.capturedAt).toISOString().slice(0, 10) : '']
        .some(value => String(value || '').toLocaleLowerCase().includes(query)))
    const cursor = Math.max(0, Number(url.searchParams.get('cursor')) || 0)
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50))
    const items = filtered.slice(cursor, cursor + limit)
    const progress = spokenWorkProgress(all)
    return json(res, 200, { ok: true, items, total: filtered.length, progress,
      nextCursor: cursor + items.length < filtered.length ? cursor + items.length : null,
      needsReviewCount: progress.needsReview })
  }

  const spokenMutation = url.pathname.match(/^\/spoken-work\/([^/]+)(?:\/(actions|split|merge|extract|destination-sync|amend))?$/)
  if (spokenMutation && (req.method === 'PATCH' || req.method === 'POST')) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    if (req.method === 'POST' && !spokenMutation[2]) return json(res, 405, { error: 'method not allowed' })
    if (req.method === 'PATCH' && spokenMutation[2]) return json(res, 405, { error: 'method not allowed' })
    let body
    try { body = JSON.parse((await readBody(req)) || '{}') } catch (error) { return json(res, 400, { error: `bad body: ${error.message}` }) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'object body required' })
    const commandId = String(body.commandId || '').trim()
    const revision = Number(String(req.headers['if-match'] || '').replace(/^"|"$/g, ''))
    if (!commandId || commandId.length > 120 || !Number.isInteger(revision) || revision < 1) {
      return json(res, 400, { error: 'commandId and If-Match revision required' })
    }
    if (req.method === 'PATCH' && (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch))) {
      return json(res, 400, { error: 'patch object required' })
    }
    if (spokenMutation[2] === 'actions' && !['task', 'link-task', 'project', 'idea', 'memory', 'restore', 'ignored', 'done', 'reviewed', 'unreviewed', 'needs_clarification'].includes(body.action)) {
      return json(res, 400, { error: 'unknown review action' })
    }
    const id = decodeURIComponent(spokenMutation[1])
    const current = spokenWork.get(id)
    const preview = current ? null : legacySpokenInventory(DATA_DIR).items.find(item => item.id === id)
    if (!current && !preview) return json(res, 404, { error: 'unknown spoken work item' })
    if (preview && revision !== preview.revision) return json(res, 409, { error: 'item changed', item: preview })
    const materialized = current ? { ok: true, item: current } : materializeSpokenWork(spokenWork, preview)
    if (!materialized.ok) return json(res, materialized.code || 400, materialized)
    let result
    if (req.method === 'PATCH') {
      result = spokenWork.update(id, body.patch || {}, { revision, commandId })
    } else if (spokenMutation[2] === 'amend') {
      const parentId = materialized.item.parentId
      if (parentId && !spokenWork.get(parentId)) {
        const parentPreview = legacySpokenInventory(DATA_DIR).items.find(item => item.id === parentId)
        if (parentPreview) materializeSpokenWork(spokenWork, parentPreview)
      }
      result = spokenWork.applyAmendment(id, { revision, commandId })
    } else if (spokenMutation[2] === 'destination-sync') {
      result = body.kind === 'task' ? updateSpokenTask({ store: spokenWork, tasks, itemId: id, revision, commandId })
        : ['project', 'idea', 'memory'].includes(body.kind)
          ? spokenWork.updateResource(id, body.kind, { revision, commandId })
          : { ok: false, code: 400, error: 'invalid destination kind' }
    } else if (spokenMutation[2] === 'extract') {
      if (materialized.item.revision !== revision && materialized.item.extraction?.state === 'processing') {
        result = { ok: true, duplicate: true, item: materialized.item }
      } else if (materialized.item.revision !== revision) {
        result = { ok: false, code: 409, error: 'item changed', item: materialized.item }
      } else {
        result = scheduleSpokenExtraction({ store: spokenWork, jobs, itemId: id, rulesPath: SPOKEN_RULES_PATH,
          retry: true, retryToken: commandId })
      }
    } else if (spokenMutation[2] === 'split') {
      result = spokenWork.split(id, body.parts, { revision, commandId })
    } else if (spokenMutation[2] === 'merge') {
      const sourceId = String(body.sourceId || '')
      const sourceRevision = Number(body.sourceRevision)
      const source = spokenWork.get(sourceId)
      const sourcePreview = source ? null : legacySpokenInventory(DATA_DIR).items.find(item => item.id === sourceId)
      if (!source && !sourcePreview) result = { ok: false, code: 404, error: 'unknown source item' }
      else if (!spokenWork.hasCommand(id, commandId) && (!Number.isInteger(sourceRevision) || sourceRevision !== (source || sourcePreview).revision)) {
        result = { ok: false, code: 409, error: 'source item changed', item: source || sourcePreview }
      } else {
        const sourceReady = source ? { ok: true } : materializeSpokenWork(spokenWork, sourcePreview)
        result = sourceReady.ok ? spokenWork.merge(id, sourceId, { revision, sourceRevision, commandId }) : sourceReady
      }
    } else if (body.action === 'task') {
      result = promoteSpokenTask({ store: spokenWork, tasks, checklists, itemId: id, revision, commandId, candidateId: body.candidateId || null })
    } else if (body.action === 'link-task') {
      result = linkExistingSpokenTask({ store: spokenWork, tasks, itemId: id, taskId: String(body.taskId || ''), revision, commandId })
    } else if (['project', 'idea', 'memory'].includes(body.action)) {
      result = promoteSpokenResource({ store: spokenWork, recordings, itemId: id, kind: body.action, revision, commandId,
        title: String(body.title || '').trim() || null })
    } else if (body.action === 'restore') {
      result = ['ignored', 'done'].includes(materialized.item.reviewState)
        ? spokenWork.action(id, 'unreviewed', { revision, commandId })
        : { ok: false, code: 400, error: 'only ignored or done items can be restored' }
    } else if (['ignored', 'done', 'reviewed', 'unreviewed', 'needs_clarification'].includes(body.action)) {
      result = spokenWork.action(id, body.action, { revision, commandId })
    } else {
      result = { ok: false, code: 400, error: 'unknown review action' }
    }
    return json(res, result.ok ? 200 : result.code || 400, result)
  }

  if (req.method === 'GET' && url.pathname === '/coach') {
    try {
      const html = readFileSync(join(WEB_DIR, 'coach.html'))
      cors(res)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(html)
    } catch {
      return json(res, 404, { error: 'not found' })
    }
  }

  if (req.method === 'GET' && url.pathname === '/recordings') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    return json(res, 200, { ok: true, recordings: recordings.list() })
  }

  // The iPad controller. The glasses are glanceable; this is the surface the
  // system is actually driven from, with room for the columns nine lines has
  // to compress.
  if (req.method === 'GET' && url.pathname === '/pad') {
    try {
      // ?kiosk=1 is the walk-up household list (v0.171.0), now WAM Home's page
      // (synced into vendor/, v0.173.0); plain /pad is unchanged.
      const html = url.searchParams.get('kiosk') === '1'
        ? readFileSync(join(HERE, 'vendor', 'wam-home', 'web', 'kiosk.html'))
        : readFileSync(join(WEB_DIR, 'pad.html'))
      cors(res)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(html)
    } catch {
      return json(res, 404, { error: 'not found' })
    }
  }

  // ---- life game ----------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/game/state') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    const days = Math.max(1, Math.min(400, Number(url.searchParams.get('days')) || 60))
    return json(res, 200, { ...gameState(Date.now(), days), rules: gameConfig })
  }
  if (req.method === 'GET' && url.pathname === '/game') {
    try {
      const html = readFileSync(join(WEB_DIR, 'game.html'))
      cors(res)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(html)
    } catch {
      return json(res, 404, { error: 'not found' })
    }
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    try {
      const html = readFileSync(join(WEB_DIR, 'status.html'))
      cors(res)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(html)
    } catch {
      return json(res, 404, { error: 'not found' })
    }
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard' || url.pathname === '/index.html')) {
    try {
      const html = readFileSync(join(WEB_DIR, 'index.html'))
      cors(res)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
      return res.end(html)
    } catch (err) {
      return json(res, 500, { error: `page missing: ${err.message}` })
    }
  }

  if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
    cors(res)
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' })
    return res.end(
      JSON.stringify({
        name: 'The List',
        short_name: 'List',
        start_url: '/',
        display: 'standalone',
        background_color: '#111417',
        theme_color: '#111417',
      }),
    )
  }

  // ---- coach modes and listening sessions -------------------------------
  if (url.pathname === '/coach/modes' || url.pathname.startsWith('/coach/modes/')) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })

    if (req.method === 'GET' && url.pathname === '/coach/modes') {
      return json(res, 200, {
        ok: true,
        modes: coach.listModes(),
        activeModeBySpace: coach.activeModeBySpace,
      })
    }

    const modeMatch = url.pathname.match(/^\/coach\/modes\/([^/]+)(?:\/activate)?$/)
    if (req.method === 'POST' && modeMatch) {
      const modeId = decodeURIComponent(modeMatch[1])
      let body = {}
      try {
        const raw = await readBody(req)
        if (raw) body = JSON.parse(raw)
      } catch (err) {
        return json(res, 400, { error: `bad body: ${err.message}` })
      }

      if (url.pathname.endsWith('/activate')) {
        const result = coach.activateMode(cueSpace(body.space), modeId)
        return json(res, result.ok ? 200 : 404, result)
      }

      const result = coach.saveMode(modeId, body)
      return json(res, result.ok ? 200 : 404, result)
    }

    return json(res, 404, { error: 'not found' })
  }

  if (req.method === 'GET' && url.pathname === '/coach/session/current') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    const space = cueSpace(url.searchParams.get('space'))
    const { snapshot, modelCue } = coachSnapshotWithModel(space)
    return json(res, 200, { ok: true, ...snapshot, cue: publicCoachModelCue(modelCue) })
  }

  if (req.method === 'POST' && url.pathname === '/coach/session/start') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    let body = {}
    try {
      const raw = await readBody(req)
      if (raw) body = JSON.parse(raw)
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }

    let reviewParent = null
    if (body.context?.reviewItemId) {
      reviewParent = spokenWork.get(String(body.context.reviewItemId)) ||
        legacySpokenInventory(DATA_DIR).items.find(item => item.id === body.context.reviewItemId)
      if (!reviewParent || reviewParent.revision !== body.context.reviewRevision || ['merged', 'split'].includes(reviewParent.reviewState)) {
        return json(res, 409, { error: 'review item changed; reopen it before recording' })
      }
    }
    const result = coach.startSession({
      space: cueSpace(body.space),
      modeId: body.modeId,
      title: body.title,
      context: body.context,
      clientId: body.clientId,
      at: body.at,
    })
    return json(res, result.ok ? 200 : 400, result)
  }

  const coachSummaryMatch = url.pathname.match(/^\/coach\/session\/([^/]+)\/summary$/)
  if (req.method === 'GET' && coachSummaryMatch) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    const session = coach.session(decodeURIComponent(coachSummaryMatch[1]))
    if (!session) return json(res, 404, { error: 'unknown session' })
    return json(res, 200, sessionRecap({ ...session, segments: mergeRawSegments(session.segments, recordings.transcript(session.id)) }))
  }

  const coachTranscriptMatch = url.pathname.match(/^\/coach\/session\/([^/]+)\/transcript$/)
  if (req.method === 'GET' && coachTranscriptMatch) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    const id = decodeURIComponent(coachTranscriptMatch[1])
    const session = coach.session(id)
    const archived = recordings.transcript(id)
    if (!session && archived.length === 0) return json(res, 404, { error: 'unknown session' })
    const merged = [...(session?.segments ?? []), ...archived]
      .filter(segment => segment.final !== false)
      .sort((a, b) => a.at - b.at)
    const seen = new Set()
    const rawSegments = merged.filter(segment => {
      const key = segment.clientId || segment.id || `${segment.at}:${segment.text}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return json(res, 200, {
      ok: true,
      id,
      title: session?.title || 'Listen recording',
      startedAt: session?.startedAt || recordings.summary(id)?.createdAt || null,
      endedAt: session?.endedAt || recordings.summary(id)?.endedAt || null,
      context: session?.context ?? null,
      // Readers get speech-sized blocks; diagnostics retain every exact STT
      // transport chunk without forcing the glasses to display those chunks.
      segments: coalesceTranscriptSegments(rawSegments),
      rawSegments,
      recording: recordings.summary(id),
    })
  }

  const coachRecordingMatch = url.pathname.match(/^\/coach\/session\/([^/]+)\/recording\.wav$/)
  if ((req.method === 'GET' || req.method === 'HEAD') && coachRecordingMatch) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    return serveRecording(req, res, decodeURIComponent(coachRecordingMatch[1]))
  }

  const coachRecordingKeepMatch = url.pathname.match(/^\/coach\/session\/([^/]+)\/recording\/keep$/)
  if (req.method === 'POST' && coachRecordingKeepMatch) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    let body = {}
    try {
      const raw = await readBody(req)
      if (raw) body = JSON.parse(raw)
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }
    const recordingId = decodeURIComponent(coachRecordingKeepMatch[1])
    if (body.keep !== true && spokenWork.all().some(item => item.audio?.sessionId === recordingId)) {
      return json(res, 409, { error: 'review recording stays kept until an explicit source purge' })
    }
    const result = recordings.setKeep(recordingId, body.keep === true)
    return json(res, result.ok ? 200 : 404, {
      ...result,
      ...(result.recording ? { recording: recordings.summary(result.recording.sessionId) } : {}),
    })
  }

  const coachSessionMatch = url.pathname.match(/^\/coach\/session\/([^/]+)\/(segment|audio|end|discard)$/)
  if (req.method === 'POST' && coachSessionMatch) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    const [, sessionId, action] = coachSessionMatch
    let body = {}
    try {
      const raw = await readBody(req, action === 'audio' ? 1024 * 1024 : 256 * 1024)
      if (raw) body = JSON.parse(raw)
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }

    if (action === 'discard') {
      const id = decodeURIComponent(sessionId)
      const timer = coachCueTimers.get(id)
      if (timer) clearTimeout(timer)
      coachCueTimers.delete(id)
      recordings.finalize(id, body.at)
      const result = coach.removeSession(id)
      if (result.ok) jobs.removeForCoachSession(id)
      return json(res, result.ok ? 200 : 404, result)
    }

    if (action === 'end') {
      const id = decodeURIComponent(sessionId)
      await waitForTranscriptions()
      const result = coach.endSession(id, body.at)
      if (result.ok) recordings.finalize(id, result.session?.endedAt || body.at)
      const timer = coachCueTimers.get(id)
      if (timer) clearTimeout(timer)
      coachCueTimers.delete(id)
      const session = result.ok ? coach.session(id) : null
      let full = null
      if (session) {
        const archivedText = recordings.fullTranscript(id)
        if (archivedText) full = { ok: true, text: archivedText, source: 'full-recording' }
        else {
          try { full = await transcribeSession(join(DATA_DIR, 'recordings'), id, transcribeClip) }
          catch (error) { full = { ok: false, error: String(error.message || error) } }
          if (full?.ok && full.text) recordings.saveFullTranscript(id, full.text)
        }
      }
      let note = null
      if (session) {
        const amendmentParent = session.context?.reviewItemId
          ? spokenWork.get(session.context.reviewItemId) || legacySpokenInventory(DATA_DIR).items.find(item => item.id === session.context.reviewItemId)
          : null
        const captured = ingestCoachCapture({ store: spokenWork, recordings, session, fullText: full?.ok ? full.text : '', amendmentParent })
        if (!captured.ok) return json(res, captured.code || 500, captured)
        if (captured.item.sourceType !== 'amendment' && captured.item.rawTranscript.text &&
          (!captured.existing || captured.item.extraction?.state === 'stale')) {
          scheduleSpokenExtraction({ store: spokenWork, jobs, itemId: captured.item.id, rulesPath: SPOKEN_RULES_PATH })
        }
        if (session.context?.taskId !== '__assistant__') {
          note = routeCoachSession(session, body.at, full?.ok ? full.text : '')
          if (note) {
            const linked = ingestCoachCapture({ store: spokenWork, recordings, session, fullText: full?.ok ? full.text : '', note, amendmentParent })
            if (!linked.ok) return json(res, linked.code || 500, linked)
          }
        }
        jobs.discardQueuedCoachCuesForSession(session.id)
        if (note?.result?.ok && note.summaryTarget) {
          const prior = latestCoachModelCueForSession(cueSpace(session.space), session.id, Date.now(), false)
          createCoachCueJob(session, {
            reason: 'session-end',
            priority: 'now',
            finalNote: note.summaryTarget,
            fullTranscript: full?.ok ? full.text : '',
            previousRunningNote: modelRunningNote(prior),
            previousBoard: modelBoard(prior),
          })
        }
      }
      return json(res, result.ok ? 200 : 404, { ...result, note })
    }

    if (action === 'audio') {
      const encoded = String(body.pcmBase64 || body.audioPcm || '').replace(/^data:.*?;base64,/, '')
      if (!encoded) return json(res, 400, { error: 'pcmBase64 required' })

      let pcm
      try {
        pcm = Buffer.from(encoded, 'base64')
      } catch {
        return json(res, 400, { error: 'bad audio' })
      }
      const recording = recordings.addChunk(decodeURIComponent(sessionId), pcm, {
        sampleRate: body.sampleRate,
        channels: body.channels,
        clientId: body.clientId,
        at: body.at,
      })
      if (!recording.ok) console.warn(`[recording] ${recording.error}`)
      if (pcm.length < 1600) return json(res, 200, { ok: true, skipped: true, reason: 'too short' })

      // Accept now, transcribe after.
      //
      // This used to await the transcription before replying, which was
      // tolerable against a cloud API and is not against local whisper: every
      // chunk froze the glasses for as long as the model took, and the app sat
      // there unresponsive with an empty cue screen. The device should never
      // wait on inference. Queue it, answer immediately, and let the segment
      // appear when it appears.
      enqueueTranscription(decodeURIComponent(sessionId), pcm, body)
      return json(res, 202, { ok: true, queued: true })
    }

    const result = coach.addSegment(decodeURIComponent(sessionId), {
      text: body.text,
      speaker: body.speaker,
      final: body.final,
      clientId: body.clientId,
      at: body.at,
    })
    if (result.ok && !result.duplicate) {
      if (!['__assistant__', '__day_start__'].includes(result.session.context?.taskId) && !result.session.context?.reviewItemId) {
        scheduleCoachCue(result.session)
      }
    }
    return json(res, result.ok ? 200 : 400, result)
  }

  // ---- inbox ------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/inbox') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }
    const result = inbox.add(body.text, { by: body.by, clientId: body.clientId, at: body.at })
    // Queue the work immediately — creating a job costs nothing. How often it
    // actually runs is the agent's decision, which is where you want the cost
    // dial to live.
    if (result.ok && !result.duplicate) enqueueTriage()
    return json(res, result.ok ? 200 : 400, result)
  }

  /*
   * One-shot voice capture — the iPad's record button.
   *
   * Same contract as the typed box: capture never fails and never asks a
   * question, so the transcript lands in the inbox as a raw line and triage
   * sorts it later. The audio is transcribed and dropped; only the transcript
   * is kept, and neither ever leaves the machine.
   */
  // ---- household list (v0.171.0) -----------------------------------------
  if (req.method === 'GET' && url.pathname === '/household') {
    return json(res, 200, { ok: true, members: householdMembers(), fallback: 'Household' })
  }
  if (req.method === 'GET' && url.pathname === '/list') {
    const items = inbox.active(300).map(item => ({ ...item, by: null, label: Inbox.label(item) }))
    return json(res, 200, { ok: true, items, today: listToday() })
  }
  if (req.method === 'POST' && url.pathname.startsWith('/list/')) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    let body = {}
    try { body = JSON.parse((await readBody(req, 4 * 1024 * 1024)) || '{}') } catch (err) { return json(res, 400, { error: `bad body: ${err.message}` }) }
    const by = String(body.by || 'Household').slice(0, 24)
    const listing = () => inbox.active(300).map(item => ({ ...item, by: null, label: Inbox.label(item) }))

    if (url.pathname === '/list/voice') {
      // A retried utterance returns the first answer instead of applying twice.
      if (body.clientId && listReplies.has(body.clientId)) return json(res, 200, listReplies.get(body.clientId))
      let heard = String(body.text || '').trim()
      if (!heard && body.pcmBase64) {
        let pcm
        try { pcm = Buffer.from(String(body.pcmBase64).replace(/^data:.*?;base64,/, ''), 'base64') } catch { return json(res, 400, { error: 'bad audio' }) }
        if (pcm.length < 1600) return json(res, 200, { ok: true, heard: '', applied: [], say: 'I did not hear anything.', items: listing() })
        // The whole clip in one pass: chunk transcripts mishear (SPOKEN-WORK-DECISIONS §4).
        const out = await transcribeClip(pcm, { sampleRate: body.sampleRate, channels: body.channels, clientId: body.clientId })
        if (!out.ok) return json(res, 503, { ok: false, error: String(out.error || 'transcription failed') })
        heard = String(out.text || '').trim()
      }
      if (!heard) return json(res, 200, { ok: true, heard: '', applied: [], say: 'I did not hear anything.', items: listing() })

      // Routed like the Start Day walk (householdRouter.js): carrots go on the
      // list, "vacuum" starts the Vacuum routine with its steps and timers,
      // "call the vet" is a task on today's Home.
      const routed = routeHouseholdSpeech(heard, { routines: checklists.routineTemplates('life'), items: inbox.active(300) })
      const now = Date.now()
      const changeId = `chg-${crypto.randomUUID()}`
      const says = []
      const applied = []
      if (routed.listOps.some(op => op.type === 'undo')) {
        const last = [...householdChanges.keys()].pop()
        const ok = last ? undoHouseholdChange(last) : false
        applied.push(ok ? { type: 'undo', label: 'last change' } : { type: 'missing', label: 'anything to undo' })
        says.push(ok ? 'Undone.' : 'Nothing to undo.')
      }
      const listOps = routed.listOps.filter(op => op.type !== 'undo')
      if (listOps.length) {
        const result = applyListSpeech(listOps, { ...listDeps(), by, via: body.pcmBase64 ? 'kiosk-voice' : 'kiosk-text', changeId })
        applied.push(...result.applied)
        if (result.say) says.push(result.say)
        enqueueListLabels()
      }
      const runIds = []
      const started = []
      const already = []
      for (const routine of routed.routines) {
        const out = checklists.start(routine.checklistId, now, { startIndex: routine.startIndex })
        if (!out.ok) continue
        if (out.existing) already.push(routine.name)
        else { started.push(routine.name); runIds.push(out.run.runId) }
        applied.push({ type: 'routine', label: routine.name, runId: out.run.runId, existing: Boolean(out.existing) })
      }
      if (started.length) says.push(`Started ${joinNames(started)}.`)
      if (already.length) says.push(`${joinNames(already)} ${already.length > 1 ? 'are' : 'is'} already going.`)
      // A routine started here is on today's list but is not a Start Day
      // commitment: it closes overnight like any on-demand run and never costs
      // game points (anyone in the house can start one).
      const taskIds = []
      for (const [index, task] of routed.tasks.entries()) {
        const created = tasks.addTask({
          label: task.label, space: 'life', window: 'anytime', by,
          clientId: body.clientId ? `list-task:${body.clientId}:${index}` : undefined,
        })
        if (!created.ok) continue
        if (!created.duplicate) {
          checklists.commitTasks('life', [created.task.id], now, { startDay: false })
          taskIds.push(created.task.id)
        }
        applied.push({ type: 'task', label: created.task.label, taskId: created.task.id })
      }
      if (routed.tasks.length) says.push(`Added to today: ${joinNames(routed.tasks.map(task => task.label))}.`)
      rememberChange(changeId, { runIds, taskIds })
      if (runIds.length) announceGame()
      const reply = {
        ok: true, heard, changeId, applied,
        say: says.join(' ') || 'I did not catch that.',
        items: listing(), today: listToday(),
      }
      if (body.clientId) {
        listReplies.set(body.clientId, reply)
        if (listReplies.size > 200) listReplies.delete(listReplies.keys().next().value)
      }
      return json(res, 200, reply)
    }
    if (url.pathname === '/list/undo') {
      // A kiosk Undo names its own change, so a change someone else made in
      // between is never the one undone.
      if (body.changeId) {
        const ok = undoHouseholdChange(String(body.changeId))
        return json(res, 200, { ok, say: ok ? 'Undone.' : 'Nothing to undo.', items: listing(), today: listToday() })
      }
      const result = applyListSpeech([{ type: 'undo' }], { ...listDeps(), by })
      return json(res, 200, { ok: true, ...result, items: listing() })
    }
    if (url.pathname === '/list/clear') {
      if (body.confirm !== true) return json(res, 400, { ok: false, error: 'clear needs confirm: true' })
      const changeId = `chg-clear-${Date.now()}`
      rememberChange(changeId)
      for (const item of inbox.active(500)) {
        inbox.complete(item.id, true, { by, changeId })
        if (item.taskId) closeTask(item.taskId)
      }
      return json(res, 200, { ok: true, changeId, say: 'Cleared the list.', items: listing() })
    }
    const one = url.pathname.match(/^\/list\/([^/]+)\/(done|undone|urgent|remove|edit|label)$/)
    if (one) {
      const id = decodeURIComponent(one[1])
      const item = inbox.items.get(id)
      if (!item) return json(res, 404, { ok: false, error: 'unknown item' })
      if (one[2] === 'edit' && (typeof body.name !== 'string' || !body.name.trim())) return json(res, 400, { ok: false, error: 'name required' })
      if (one[2] === 'label') {
        const result = inbox.classifyLabel(item.name || item.text, body.label)
        return json(res, result.ok ? 200 : 400, { ...result, items: listing() })
      }
      const changeId = `chg-${one[2]}-${Date.now()}`
      rememberChange(changeId)
      let say = ''
      if (one[2] === 'edit') {
        const result = inbox.update(id, { name: body.name }, { changeId })
        if (!result.ok) return json(res, 400, result)
        enqueueListLabels()
        say = `Updated ${result.item.name}.`
      } else if (one[2] === 'done') {
        inbox.complete(id, true, { by, changeId })
        if (item.taskId) closeTask(item.taskId)
        say = `Checked off ${item.name || item.text}.`
      } else if (one[2] === 'undone') {
        // Tapped again on the kiosk: back on the list (and its urgent task back open).
        inbox.complete(id, false, { by, changeId })
        if (item.taskId) reopenTask(item.taskId)
        say = `Back on the list: ${item.name || item.text}.`
      } else if (one[2] === 'remove') {
        inbox.remove(id, { by, changeId })
        if (item.taskId) closeTask(item.taskId)
        say = `Removed ${item.name || item.text}.`
      } else {
        const urgent = body.urgent !== false
        inbox.update(id, { urgent }, { changeId })
        if (urgent && !item.taskId) {
          const taskId = openUrgentTask(item)
          if (taskId) inbox.update(id, { taskId }, { changeId })
        } else if (!urgent && item.taskId) {
          closeTask(item.taskId)
          inbox.update(id, { taskId: null }, { changeId })
        }
        say = urgent ? `${item.name || item.text} is urgent.` : `${item.name || item.text} is not urgent.`
      }
      return json(res, 200, { ok: true, changeId, say: say.charAt(0).toUpperCase() + say.slice(1), items: listing() })
    }
    return json(res, 404, { error: 'not found' })
  }

  if (req.method === 'POST' && url.pathname === '/capture/audio') {
    let body
    try {
      // ~90s of 16k mono PCM, base64. The page stops recording well before this.
      body = JSON.parse(await readBody(req, 4 * 1024 * 1024))
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }

    const encoded = String(body.pcmBase64 || body.audioPcm || '').replace(/^data:.*?;base64,/, '')
    if (!encoded) return json(res, 400, { error: 'pcmBase64 required' })

    let pcm
    try {
      pcm = Buffer.from(encoded, 'base64')
    } catch {
      return json(res, 400, { error: 'bad audio' })
    }
    if (pcm.length < 1600) return json(res, 200, { ok: true, empty: true, reason: 'too short' })

    const out = await transcribeClip(pcm, {
      sampleRate: body.sampleRate,
      channels: body.channels,
      clientId: body.clientId,
    })
    if (!out.ok) return json(res, 503, { ok: false, error: String(out.error || 'transcription failed') })

    const text = String(out.text || '').trim()
    if (!text) return json(res, 200, { ok: true, empty: true })

    // Only an unmistakable command becomes a task on its own. Everything else
    // is a raw line — guessing here is how the list fills with things nobody
    // said.
    const label = parseTaskCommand(text)
    if (label) {
      const created = tasks.addTask({ label, space: body.space === 'ops' ? 'ops' : 'life', clientId: body.clientId })
      if (created.ok) return json(res, 200, { ok: true, text, task: created.task, tasks: tasks.list() })
    }

    const result = inbox.add(text, { by: body.by, clientId: body.clientId })
    if (result.ok && !result.duplicate) enqueueTriage()
    return json(res, result.ok ? 200 : 400, { ...result, text })
  }

  if (req.method === 'GET' && url.pathname === '/inbox') {
    const items = inbox.active().map(item => ({ ...item, by: null, label: Inbox.label(item) }))
    return json(res, 200, { items, pending: inbox.pending().length })
  }

  if (req.method === 'POST' && url.pathname === '/tasks') {
    let body = {}
    try {
      const raw = await readBody(req)
      if (raw) body = JSON.parse(raw)
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }
    const result = tasks.addTask(body)
    return json(res, result.ok ? 200 : 400, { ...result, tasks: tasks.list() })
  }

  const completionDateMatch = url.pathname.match(/^\/task\/([^/]+)\/completion-date$/)
  if (req.method === 'POST' && completionDateMatch) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { error: 'bad body' }) }
    const id = decodeURIComponent(completionDateMatch[1])
    const day = String(body.day || '')
    const noteId = String(body.noteId || '')
    const dayKeyOf = timestamp => checklists.dayKey(timestamp)
    const linkedEvidence = linkedCompletionEvidence(spokenWork.all(), id).find(row => row.id === noteId) ?? null
    const result = body.action === 'preview'
      ? tasks.previewCompletionDate(id, day, noteId, dayKeyOf, Date.now(), linkedEvidence)
      : body.action === 'confirm'
        ? tasks.correctCompletionDate(id, day, noteId, String(body.reviewKey || ''), dayKeyOf, Date.now(), linkedEvidence)
        : { ok: false, error: 'unknown action' }
    return json(res, result.ok ? 200 : 400, result)
  }

  // ---- dated follow-ups (v0.170.0) ---------------------------------------
  if (url.pathname === '/followups' || url.pathname.startsWith('/followups/') || /^\/task\/[^/]+\/followup$/.test(url.pathname)) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    const today = checklists.dayKey()
    const listing = () => followups.list().map(item => ({ ...item, daysLeft: daysBetween(today, item.dueDay) }))
    if (req.method === 'GET' && url.pathname === '/followups') return json(res, 200, { ok: true, today, items: listing() })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

    let body = {}
    try {
      const raw = await readBody(req)
      if (raw) body = JSON.parse(raw)
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }

    // Done with the task, but a dated step remains: tick the task and keep
    // the follow-up, in one request so a retry cannot do half of it.
    const fromTask = url.pathname.match(/^\/task\/([^/]+)\/followup$/)
    if (fromTask) {
      const taskId = decodeURIComponent(fromTask[1])
      const task = tasks.taskDefs().find(row => row.id === taskId)
      if (!task) return json(res, 404, { error: 'unknown task' })
      const added = followups.add({
        label: body.label || `Follow up: ${task.label}`,
        dueDay: body.dueDay,
        taskId,
        space: task.space === 'ops' ? 'ops' : 'life',
        clientId: body.clientId,
      })
      if (!added.ok) return json(res, 400, added)
      const done = tasks.complete(taskId, true)
      if (done.ok) closeLinkedListItem(taskId)
      return json(res, 200, { ...added, taskDone: done.ok, tasks: tasks.list(), items: listing() })
    }

    if (url.pathname === '/followups') {
      const added = followups.add({ label: body.label, dueDay: body.dueDay, space: body.space, clientId: body.clientId })
      return json(res, added.ok ? 200 : 400, { ...added, items: listing() })
    }
    const one = url.pathname.match(/^\/followups\/([^/]+)(?:\/(done|delete))?$/)
    if (!one) return json(res, 404, { error: 'not found' })
    const id = decodeURIComponent(one[1])
    const result = one[2] === 'done'
      ? followups.setDone(id, body.done !== false, today)
      : one[2] === 'delete'
        ? followups.remove(id)
        : followups.update(id, { label: body.label, dueDay: body.dueDay })
    return json(res, result.ok ? 200 : 404, { ...result, items: listing() })
  }

  const taskMatch = url.pathname.match(/^\/task\/([^/]+)\/(done|reopen|note)$/)
  if (req.method === 'POST' && taskMatch) {
    const id = decodeURIComponent(taskMatch[1])
    const action = taskMatch[2]

    if (action === 'note') {
      let body = {}
      try {
        const raw = await readBody(req)
        if (raw) body = JSON.parse(raw)
      } catch (err) {
        return json(res, 400, { error: `bad body: ${err.message}` })
      }
      const result = tasks.addNote(id, body.text, body.by, body.clientId)
      return json(res, result.ok ? 200 : 400, { ...result, tasks: tasks.list() })
    }

    const result = tasks.complete(id, action === 'done')
    if (result.ok && action === 'done') closeLinkedListItem(id)
    return json(res, result.ok ? 200 : 404, { ...result, tasks: tasks.list() })
  }

  const taskNoteMatch = url.pathname.match(/^\/task\/([^/]+)\/note\/([^/]+)$/)
  if (req.method === 'POST' && taskNoteMatch) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    let body = {}
    try {
      const raw = await readBody(req)
      if (raw) body = JSON.parse(raw)
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }
    const result = tasks.updateNote(
      decodeURIComponent(taskNoteMatch[1]),
      decodeURIComponent(taskNoteMatch[2]),
      body.text,
      body.by,
    )
    return json(res, result.ok ? 200 : 404, { ...result, tasks: tasks.list() })
  }

  if (req.method === 'POST' && url.pathname === '/day/commitments/tasks') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    let body = {}
    try {
      const raw = await readBody(req)
      if (raw) body = JSON.parse(raw)
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }
    const requested = Array.isArray(body.taskIds) ? body.taskIds : []
    const unknown = requested.filter(id => !tasks.has(id))
    if (unknown.length) return json(res, 400, { ok: false, error: `unknown tasks: ${unknown.join(', ')}` })
    const space = cueSpace(body.space)
    const result = checklists.setCommittedTasks(space, requested)
    return json(res, result.ok ? 200 : 400, { ...result, day: checklists.dayStatus(space) })
  }

  if (req.method === 'GET' && url.pathname === '/tasks') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    if (url.searchParams.get('includeDone') !== '1') return json(res, 200, { tasks: tasks.list() })
    const spokenItems = spokenWork.all()
    return json(res, 200, { tasks: tasks.list(),
      completedTasks: tasks.completed().map(task => ({ ...task, voiceEvidence: [
        ...task.notes.filter(note => String(note.by).startsWith('listen')).map(note => ({ id: note.id, text: note.text, by: note.by })),
        ...linkedCompletionEvidence(spokenItems, task.id),
      ] })),
    })
  }

  // ---- assistant chat --------------------------------------------------
  if (
    url.pathname === '/assistant/chat' ||
    url.pathname === '/assistant/chat/from-session' ||
    url.pathname === '/assistant/queue-note' ||
    url.pathname === '/assistant/transcribe'
  ) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    const querySpace = cueSpace(url.searchParams.get('space'))
    const queryProvider = url.searchParams.get('provider') === 'claude' ? 'claude' : 'chatgpt'

    if (req.method === 'GET' && url.pathname === '/assistant/chat') {
      return json(res, 200, { ok: true, chat: assistant.snapshot(querySpace, queryProvider, jobs) })
    }

    let body = {}
    try {
      // A spoken turn from the iPad is up to ~90 s of 16 kHz PCM, base64.
      const raw = await readBody(req, url.pathname === '/assistant/transcribe' ? 4 * 1024 * 1024 : undefined)
      if (raw) body = JSON.parse(raw)
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }

    // The iPad's spoken chat turn (v0.177.0): words only, nothing is sent. The
    // iPad shows them for review first, as the glasses do, then posts the
    // (possibly edited) text to /assistant/chat.
    if (req.method === 'POST' && url.pathname === '/assistant/transcribe') {
      let pcm
      try { pcm = Buffer.from(String(body.pcmBase64 || '').replace(/^data:.*?;base64,/, ''), 'base64') } catch { return json(res, 400, { error: 'bad audio' }) }
      if (pcm.length < 1600) return json(res, 200, { ok: true, text: '' })
      const out = await transcribeClip(pcm, { sampleRate: body.sampleRate, channels: body.channels, clientId: body.clientId })
      if (!out.ok) return json(res, 503, { ok: false, error: String(out.error || 'transcription failed') })
      return json(res, 200, { ok: true, text: String(out.text || '').trim() })
    }

    if (req.method === 'POST' && url.pathname === '/assistant/chat/from-session') {
      const pending = pendingTranscriptions()
      if (pending > 0) {
        return json(res, 409, { ok: false, pending: true, error: 'transcription still processing' })
      }
      const session = coach.session(String(body.sessionId || ''))
      if (!session) return json(res, 404, { ok: false, error: 'unknown recording' })
      const text = session.segments
        .filter(segment => segment.final !== false)
        .map(segment => String(segment.text || '').trim())
        .filter(Boolean)
        .join(' ')
      const result = assistant.addTurn({
        space: body.space ?? session.space,
        provider: body.provider,
        text,
        clientId: body.clientId || `session:${session.id}`,
      }, jobs)
      return json(res, result.ok ? 202 : result.code || 400, result)
    }

    if (req.method === 'POST' && url.pathname === '/assistant/queue-note') {
      const kind = body.kind === 'chore' ? 'chore' : body.kind === 'task' ? 'task' : null
      const subjectId = String(body.subjectId || '')
      const noteId = String(body.noteId || '')
      if (!kind || !subjectId || !noteId) {
        return json(res, 400, { ok: false, error: 'kind, subjectId and noteId required' })
      }
      const found = queuedNote(kind, subjectId, noteId)
      if (!found) return json(res, 404, { ok: false, error: 'unknown note' })
      const provider = body.provider === 'claude' ? 'claude' : 'chatgpt'
      const result = assistant.queueTurn({
        space: body.space,
        provider,
        text: queuedNoteText(found),
        clientId: `note:${kind}:${subjectId}:${noteId}:${provider}`,
        source: {
          kind: 'note',
          clientId: `note:${kind}:${subjectId}:${noteId}:${provider}`,
          noteId,
          subjectId,
          label: found.label,
        },
      }, jobs)
      return json(res, result.ok ? 202 : result.code || 400, result)
    }

    if (req.method === 'POST' && url.pathname === '/assistant/chat') {
      if (body.clear === true) {
        const result = assistant.clear(body.space, body.provider)
        return json(res, result.ok ? 200 : result.code || 400, result)
      }
      const result = assistant.addTurn(body, jobs)
      return json(res, result.ok ? 202 : result.code || 400, result)
    }

    return json(res, 405, { error: 'method not allowed' })
  }

  if (req.method === 'POST' && url.pathname === '/note/promote') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    let body = {}
    try {
      const raw = await readBody(req)
      if (raw) body = JSON.parse(raw)
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }

    const subjectId = String(body.subjectId || '')
    const noteId = String(body.noteId || '')
    if (body.kind !== 'task' || subjectId !== CAPTURE_TASK_ID || !noteId) {
      return json(res, 400, { ok: false, error: 'only captured notes can become Home tasks' })
    }
    const found = queuedNote('task', subjectId, noteId)
    if (!found) return json(res, 404, { ok: false, error: 'unknown note' })

    const at = Date.now()
    const space = cueSpace(body.space)
    const firstLine = String(found.note.text || '').split('\n').map(line => line.trim()).find(Boolean) || 'Captured task'
    const label = firstLine.slice(0, 80)
    const existing = matchOpenTask(label, tasks.list(at).filter(task => task.space === space))
    const created = existing
      ? { ok: true, task: existing, existing: true }
      : tasks.addTask({
          label,
          space,
          window: 'anytime',
          weight: 'big',
          needsPlan: soundsLikePlan(label),
          by: 'notes-review',
          clientId: `promote:${noteId}`,
        }, at)
    if (!created.ok) return json(res, 400, created)

    const attached = tasks.addNote(created.task.id, found.note.text, found.note.by, noteId, at)
    if (!attached.ok) return json(res, 400, attached)
    tasks.removeNote(CAPTURE_TASK_ID, noteId)
    checklists.commitTasks(space, [created.task.id], at)
    return json(res, 200, {
      ok: true,
      task: created.task,
      day: checklists.dayStatus(space),
      tasks: tasks.list(at),
      checklists: checklists.snapshot(at),
    })
  }

  if (req.method === 'POST' && url.pathname === '/note/delete') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    let body = {}
    try {
      const raw = await readBody(req)
      if (raw) body = JSON.parse(raw)
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }

    const subjectId = String(body.subjectId || '')
    const noteId = String(body.noteId || '')
    if (!subjectId || !noteId) return json(res, 400, { error: 'subjectId and noteId required' })
    const result = body.kind === 'chore'
      ? checklists.removeNote(subjectId, noteId)
      : body.kind === 'task'
        ? tasks.removeNote(subjectId, noteId)
        : { ok: false, error: 'kind must be task or chore' }
    if (result.ok && noteId.endsWith(':note')) {
      const sessionId = noteId.slice(0, -':note'.length)
      coach.removeSession(sessionId)
      jobs.removeForCoachSession(sessionId)
    }
    return json(res, result.ok ? 200 : 404, result)
  }

  const doneMatch = url.pathname.match(/^\/inbox\/([^/]+)\/done$/)
  if (req.method === 'POST' && doneMatch) {
    const result = inbox.complete(decodeURIComponent(doneMatch[1]))
    return json(res, result.ok ? 200 : 404, result)
  }

  // ---- job queue --------------------------------------------------------
  // Agents pull work from here. Nothing in this process ever does the work.
  if (url.pathname === '/jobs' || url.pathname.startsWith('/jobs/')) {
    if (!authorized(req, AGENT_TOKEN)) return json(res, 401, { error: 'unauthorized' })

    if (req.method === 'GET' && url.pathname === '/jobs') {
      const capability = url.searchParams.get('capability')
      const provider = url.searchParams.get('provider')
      let available = capability === 'coach.cue'
        ? jobs.availableCoachCues([
            coach.currentSession('ops')?.id,
            coach.currentSession('life')?.id,
          ])
        : jobs.available(capability)
      if (capability === 'list.label') available = available.filter(job => !inbox.labelFor(job.input?.name))
      if (capability === 'assistant.chat' && (provider === 'chatgpt' || provider === 'claude')) {
        available = available.filter(job => job.input?.provider === provider)
      }
      return json(res, 200, { jobs: available, summary: jobs.summary() })
    }

    if (req.method === 'POST' && url.pathname === '/jobs') {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch (err) {
        return json(res, 400, { error: `bad body: ${err.message}` })
      }
      const result = jobs.create(body)
      return json(res, result.ok ? 200 : 400, result)
    }

    const match = url.pathname.match(/^\/jobs\/([^/]+)\/(claim|heartbeat|result|fail)$/)
    if (req.method === 'POST' && match) {
      const [, id, action] = match
      let body = {}
      try {
        const raw = await readBody(req)
        if (raw) body = JSON.parse(raw)
      } catch (err) {
        return json(res, 400, { error: `bad body: ${err.message}` })
      }

      const agent = String(body.agent || '').slice(0, 40)
      let result
      const job = jobs.get(id)

      if (action === 'claim') {
        result = jobs.claim(id, agent, body.leaseSeconds)
      } else if (action === 'heartbeat') {
        result = jobs.heartbeat(id, agent, body.leaseSeconds)
      } else if (action === 'result') {
        if (job?.capability === 'list.label') {
          if (job.claimedBy !== agent) return json(res, 409, { error: 'not your job' })
          const label = body.result?.label
          if (typeof label !== 'string' || !label.trim() || label.length > 120) return json(res, 400, { error: 'invalid glance label' })
        }
        if (job?.capability === 'spoken.extract') {
          if (job.claimedBy !== agent) return json(res, 409, { error: 'not your job' })
          const applied = applySpokenModelResult(spokenWork, job, body.result)
          if (!applied.ok && !(applied.code === 409 && ['transcript changed before proposal arrived', 'proposal request was superseded'].includes(applied.error))) {
            return json(res, applied.code || 400, applied)
          }
        }
        result = jobs.finish(id, agent, body.result)
        // Triage results are applied here rather than by the agent: the agent
        // should not need to know what an inbox is.
        if (result.ok && job?.capability === 'triage') {
          const applied = applyTriageResult(body.result)
          console.log(`[triage] applied ${applied} item(s) from ${agent}`)
        }
        if (result.ok && job?.capability === 'list.label') inbox.classifyLabel(job.input.name, body.result.label, { source: 'ai' })
        if (result.ok && job?.capability === 'coach.cue' && job.input?.finalNote) {
          const applied = applyFinalListenSummary(job, body.result)
          if (applied.ok) console.log(`[coach] applied final Listen summary from ${agent}`)
          else console.warn(`[coach] could not apply final Listen summary: ${applied.error}`)
        }
      } else {
        result = jobs.fail(id, agent, body.error, body.retry !== false)
        if (result.ok && job?.capability === 'spoken.extract' && result.job.status === JOB.FAILED) {
          const item = spokenWork.get(job.input?.itemId)
          if (item?.extraction?.jobId === job.id && item.extraction.transcriptRevision === job.input?.transcriptRevision) {
            spokenWork.markExtraction(job.input.itemId, 'failed', { jobId: job.id, error: result.job.error })
          }
        }
      }

      if (result.ok && job?.capability === 'assistant.chat') assistant.syncAll(jobs)

      return json(res, result.ok ? 200 : result.code || 400, result)
    }

    return json(res, 404, { error: 'not found' })
  }

  // ---- health -----------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      metrics: store.index.size,
      uptime: process.uptime(),
      aiCueIntervalMs: AI_CUE_INTERVAL_MS,
      coach: {
        ops: Boolean(coach.currentSession('ops')),
        life: Boolean(coach.currentSession('life')),
      },
      assistant: {
        chatgpt: assistant.providerReady.chatgpt,
        claude: assistant.providerReady.claude,
      },
      stt: transcriberInfo(),
    })
  }

  // ---- foreground coach cue --------------------------------------------
  if (req.method === 'GET' && url.pathname === '/ai/cue') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    const space = cueSpace(url.searchParams.get('space'))
    queueCoachCue(space, { reason: 'poll' })
    const cue = buildCurrentCue(space)
    const since = url.searchParams.get('since') || ''
    return json(res, 200, {
      ok: true,
      cue,
      changed: cue.id !== since,
      nextAfterMs: cue.nextAfterMs,
    })
  }

  // ---- morning brief ----------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/brief') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    const space = url.searchParams.get('space') === 'ops' ? 'ops' : 'life'
    return json(res, 200, morningBrief.snapshot({
      space,
      dayStatus: checklists.dayStatus(space),
    }))
  }

  if (req.method === 'POST' && url.pathname === '/brief/source') {
    if (!authorized(req, INGEST_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    let body
    try {
      body = JSON.parse(await readBody(req, 32 * 1024))
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }
    const result = morningBrief.updateSource(body)
    if (!result.ok) return json(res, 400, result)
    const space = body?.space === 'ops' ? 'ops' : 'life'
    return json(res, 200, {
      ok: true,
      source: result.source,
      brief: morningBrief.snapshot({ space, dayStatus: checklists.dayStatus(space) }),
    })
  }

  // ---- read: the glasses poll this -------------------------------------
  if (req.method === 'GET' && url.pathname === '/state') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })

    const snapshot = store.snapshot()
    const boardId = url.searchParams.get('board')
    if (boardId) {
      const board = snapshot.boards.find(b => b.id === boardId)
      if (!board) return json(res, 404, { error: `no board "${boardId}"` })
      return json(res, 200, { generatedAt: snapshot.generatedAt, boards: [board] })
    }
    return json(res, 200, {
      ...snapshot,
      checklists: checklists.snapshot(),
      // Duration stats ride along so the "what fits in the time I have"
      // screen is instant rather than a second round trip.
      stats: checklists.allStats(),
      inbox: inbox.grouped(),
      tasks: tasks.list(),
      stt: { ...sttStats, pending: pendingTranscriptions(), ...transcriberInfo() },
      assistant: {
        chatgpt: assistant.providerReady.chatgpt,
        claude: assistant.providerReady.claude,
      },
      jobs: jobs.summary(),
      game: gameSummary(gameState()),
    })
  }

  // ---- write: anything that speaks HTTP --------------------------------
  // curl -X POST localhost:8787/ingest -H 'Authorization: Bearer TOKEN' \
  //   -H 'Content-Type: application/json' \
  //   -d '{"metrics":[{"id":"ahu1.sat","value":58.2}]}'
  if (req.method === 'POST' && url.pathname === '/ingest') {
    if (!authorized(req, INGEST_TOKEN)) return json(res, 401, { error: 'unauthorized' })

    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }

    const items = Array.isArray(body) ? body : body.metrics || [body]
    const source = String(body.source || req.headers['x-source'] || 'http').slice(0, 32)

    const written = []
    const rejected = []
    for (const item of items) {
      const id = item.id ?? item.metric
      const result = store.set(id, item.value, { source, note: item.note })
      if (result.ok) written.push(id)
      else rejected.push({ id, error: result.error })
    }

    // The ledger feed also sends its weekly eating-out totals for the game.
    if (source === 'ledger' && body && !Array.isArray(body) && body.eatOut !== undefined) {
      const clean = cleanEatOut(body.eatOut)
      if (clean.error) rejected.push({ id: 'eatOut', error: clean.error })
      else {
        ledgerEatOut = clean
        saveEatOut(EAT_OUT_PATH, clean)
        written.push('eatOut')
        announceGame()
      }
    }

    return json(res, rejected.length && !written.length ? 400 : 200, { written, rejected })
  }

  // ---- Slack Events API over HTTP (public URL required) ----------------
  if (req.method === 'POST' && url.pathname === '/slack/events') {
    const raw = await readBody(req)

    if (!SLACK_SIGNING_SECRET) {
      return json(res, 503, { error: 'SLACK_SIGNING_SECRET not configured' })
    }
    if (!verifySignature(SLACK_SIGNING_SECRET, req.headers, raw)) {
      return json(res, 401, { error: 'bad signature' })
    }

    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      return json(res, 400, { error: 'bad json' })
    }

    if (payload.type === 'url_verification') {
      return json(res, 200, { challenge: payload.challenge })
    }

    const event = payload.event
    if (event?.type === 'message' && !event.subtype && event.text) {
      applyMessage(event.text, event.channel, config, store)
    }
    // Slack retries anything that is not a prompt 200.
    return json(res, 200, { ok: true })
  }

  // ---- checklist writes -------------------------------------------------
  // Gated by READ_TOKEN: these come from the glasses app, not from machines,
  // so they carry the same credential the app already uses to read /state.
  if (req.method === 'POST' && ['/check', '/run/start', '/run/finish', '/step/begin', '/step/reset', '/timers/reset', '/remind'].includes(url.pathname)) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })

    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }

    let result
    if (url.pathname === '/check') {
      result = checklists.check(body.runId, body.itemId, body.done !== false, Date.now(), body.by || 'glasses')
    } else if (url.pathname === '/run/start') {
      result = checklists.start(body.checklistId)
    } else if (url.pathname === '/step/begin') {
      result = checklists.beginStep(body.runId, body.itemId)
    } else if (url.pathname === '/step/reset') {
      result = checklists.resetStep(body.runId, body.itemId)
    } else if (url.pathname === '/timers/reset') {
      result = checklists.resetActiveTimers(Date.now(), body.by || 'glasses')
    } else if (url.pathname === '/remind') {
      // Ad-hoc reminder, for things the phone's own timer cannot know about.
      const delayMs = Math.max(0, Number(body.inMinutes ?? 0)) * 60_000
      const text = String(body.text || 'Check in').slice(0, 200)
      setTimeout(() => void notifier.send('Ops Board', text), delayMs)
      result = { ok: true }
    } else {
      result = checklists.finish(body.runId)
    }

    if (!result.ok) return json(res, 400, result)
    if (url.pathname === '/check') announceGame()
    // Return the fresh checklist state so the glasses can repaint from the
    // server's view rather than guessing at what its own write did.
    return json(res, 200, { ok: true, checklists: checklists.snapshot() })
  }

  // ---- Start Day: skip for now ------------------------------------------
  if (req.method === 'POST' && url.pathname === '/day/draft') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch {}
    const space = body.space === 'ops' ? 'ops' : 'life'
    let result

    if (body.action === 'stage') {
      result = checklists.draftDay(String(body.transcript || ''), space, String(body.sessionId || crypto.randomUUID()), Date.now(), tasks.list().filter(task => task.space === space).map(task => task.label))
      if (result.ok && body.sessionId && spokenWork.bySource(`coach:${body.sessionId}`)) {
        spokenWork.ingest({ sourceKey: `coach:${body.sessionId}`, destinationRefs: [{ kind: 'start_day', id: result.draft.id,
          itemIds: result.sourceItemIds || [], createdAt: Date.now(), syncRevision: 1 }] })
      }
    } else if (body.action === 'toggle') {
      result = checklists.setDayDraftItem(space, String(body.itemId || ''), body.include !== false)
    } else if (body.action === 'revise') {
      result = checklists.reviseDayDraftItem(space, String(body.itemId || ''), {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      })
    } else if (body.action === 'reparse') {
      result = checklists.reparseDayDraftItem(space, String(body.itemId || ''))
    } else if (body.action === 'discard') {
      result = checklists.discardDayDraft(space)
    } else if (body.action === 'commit') {
      const prepared = checklists.prepareDayDraft(space)
      result = prepared
      if (prepared.ok) {
        // Errands go onto the household list, not Home (Mike, 2026-10-18);
        // saying "urgent" with one still makes it a Home task via the list.
        const errands = prepared.tasks.filter(item => item.errand)
        if (errands.length) {
          prepared.tasks = prepared.tasks.filter(item => !item.errand)
          for (const errand of errands) {
            applyListSpeech(parseListSpeech(errand.source || errand.label, inbox.active(300)), { ...listDeps(), by: 'Start Day', via: 'start-day' })
          }
        }
        const open = tasks.list().filter(task => task.space === space)
        const resolved = prepared.tasks.map((item, index) => {
          const existing = matchOpenTask(item.label, open)
          if (existing) {
            if (item.note?.trim()) tasks.addNote(existing.id, item.note, 'start-day', `${prepared.draftId}:day-note:${item.id || index}`)
            return { ok: true, task: existing, existing: true }
          }
          return tasks.addTask({
            label: item.label,
            space,
            window: 'anytime',
            weight: 'big',
            needsPlan: soundsLikePlan(item.label),
            firstNote: item.note || item.label,
            by: 'start-day',
            clientId: `${prepared.draftId}:day-task:${item.id || index}`,
          })
        })
        const failed = resolved.find(row => !row.ok)
        if (failed) result = { ok: false, error: failed.error || 'could not save a task; review is still available' }
        else {
          const created = resolved.map(row => row.task)
          const taskIdsByItem = new Map(prepared.tasks.map((item, index) => [item.id, created[index]?.id]))
          const sourceLinks = prepared.items.map(item => ({ itemId: item.id,
            sessionIds: item.sourceSessionIds || [], taskId: taskIdsByItem.get(item.id) || null }))
          result = checklists.commitDayDraft(space, Date.now(), created.map(task => task.id), sourceLinks)
          if (result.ok) {
            result.createdTasks = created
            try { result.reviewLinks = spokenWork.linkStartDayCommit(prepared.draftId, sourceLinks) }
            catch (error) { result.reviewLinkError = String(error.message || error); console.warn(`[spoken-work] Start Day link pending reconciliation: ${error.message}`) }
          }
        }
      }
    } else {
      result = { ok: false, error: 'unknown draft action' }
    }

    if (!result.ok) return json(res, 400, result)
    return json(res, 200, {
      ...result,
      day: checklists.dayStatus(space),
      checklists: checklists.snapshot(),
    })
  }

  if (req.method === 'POST' && url.pathname === '/day/skip') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch {}
    const space = body.space === 'ops' ? 'ops' : 'life'
    const result = checklists.skipDay(space)
    if (!result.ok) return json(res, 400, result)
    return json(res, 200, { ok: true, day: result, checklists: checklists.snapshot() })
  }

  // ---- block plan -------------------------------------------------------
  // GET /plan?minutes=60&chores=laundry,dishes
  if (req.method === 'GET' && url.pathname === '/plan') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })

    // No window by default: schedule everything and let the reader stop where
    // their time runs out.
    const minutes = Math.max(5, Math.min(720, Number(url.searchParams.get('minutes')) || 720))
    const requested = (url.searchParams.get('chores') || '')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)

    // Default to Life: the running order is a Life screen, and an unfiltered
    // plan is how work lists ended up at the bottom of it.
    const space = url.searchParams.get('space') || 'life'
    return json(res, 200, buildPlan(minutes, requested, space === 'all' ? null : space))
  }

  // ---- daily summary ----------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/summary') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    const day = url.searchParams.get('day') || checklists.dayKey(Date.now() - 86400_000)
    const summary = checklists.readSummary(day) || checklists.rollup(day)
    return json(res, 200, summary)
  }

  json(res, 404, { error: 'not found' })
})

server.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT}`)
  console.log(`[server] ${store.index.size} metrics across ${config.boards.length} boards`)
  console.log(`[server] capture page at http://<your-lan-ip>:${PORT}/`)
  console.log(`[server] phone package at http://<your-tailnet-host>:${PORT}/downloads/latest`)
  console.log(`[server] ${checklists.templates.size} checklists, day ${checklists.dayKey()} (reset ${checklists.resetHour}:00 ${checklists.timezone})`)
})

/**
 * Roll up the previous operational day once past summaryHour. Checked every
 * five minutes rather than scheduled for an exact time, so a restart or a
 * missed window still catches up instead of skipping a day silently.
 */
/**
 * Follow-up reminders through the same phone notifier as wait steps: once when
 * a follow-up comes into its 7-day view, once on its day. Not before 08:00
 * local, and only marked sent once ntfy accepted it, so a failed send retries
 * on the next minute.
 */
const FOLLOWUP_REMIND_HOUR = 8
setInterval(() => {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: checklists.timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()))
  if (hour < FOLLOWUP_REMIND_HOUR) return
  for (const owed of followups.remindersDue(checklists.dayKey())) {
    notifier
      .send(owed.kind === 'due' ? 'WAM follow-up' : 'WAM coming up', reminderText(owed))
      .then(sent => { if (sent) followups.markReminded(owed.id, owed.kind) })
      .catch(err => console.warn(`[followups] reminder: ${err.message}`))
  }
}, 60_000)

/**
 * Wait steps come due on their own schedule, so sweep often. Thirty seconds is
 * fine granularity for a wash cycle and costs nothing.
 */
setInterval(() => {
  sweepWaits(checklists, notifier).catch(err => console.warn(`[notify] sweep: ${err.message}`))
}, 30_000)

if (AI_CUE_NOTIFY) {
  const notified = new Map()
  setInterval(() => {
    for (const space of AI_CUE_SPACES.length ? AI_CUE_SPACES : ['life']) {
      const cue = buildCurrentCue(space)
      if (cue.quiet || notified.get(space) === cue.id) continue
      notified.set(space, cue.id)
      notifier
        .send('WAM', `${cue.title}: ${cue.lines.join(' / ')}`)
        .catch(err => console.warn(`[cue] notify: ${err.message}`))
    }
  }, AI_CUE_INTERVAL_MS)
}

/**
 * Backstop sweep.
 *
 * Jobs are normally queued the moment something is captured; this catches
 * anything left behind by a restart or a failed batch. Raw items are on the
 * glasses immediately either way — sorted versions turn up whenever an agent
 * next runs, and hours later is fine.
 */
setInterval(enqueueTriage, 5 * 60_000)
enqueueTriage()
setInterval(enqueueListLabels, 5 * 60_000)
setTimeout(enqueueListLabels, 60_000)

/**
 * Optional: let the hub do triage itself by calling the API directly.
 * Off unless TRIAGE_MODE=api, because the default is that thinking happens on
 * a machine you already pay for, not per token.
 */
if (process.env.TRIAGE_MODE === 'api') {
  console.log('[triage] TRIAGE_MODE=api — the hub will call the model itself')
  setInterval(() => {
    sweepInbox(inbox, triage).catch(err => console.warn(`[triage] sweep: ${err.message}`))
  }, 60_000)
}

// Day rollover and streak changes happen without a tick, so look again every
// few minutes. The first look after a restart records silently.
announceGame()
setInterval(announceGame, 5 * 60_000)

checklists.maybeRollup()
setInterval(() => {
  try {
    checklists.maybeRollup()
  } catch (err) {
    console.warn(`[checklists] rollup failed: ${err.message}`)
  }
}, 5 * 60 * 1000)

scheduleMorningWeather(0)
scheduleMorningMail(250)

startSocketMode({
  appToken: process.env.SLACK_APP_TOKEN,
  botToken: process.env.SLACK_BOT_TOKEN,
  config,
  store,
}).catch(err => console.warn(`[slack] ${err.message}`))
