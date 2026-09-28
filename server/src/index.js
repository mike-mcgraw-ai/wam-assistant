import http from 'node:http'
import crypto from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { Store } from './state.js'
import { Checklists } from './checklists.js'
import { agenda, planBlock, reach } from './plan.js'
import { Inbox } from './inbox.js'
import { Tasks } from './tasks.js'
import { Triage, sweepInbox } from './triage.js'
import { Jobs, JOB } from './jobs.js'
import { distillNote } from './distill.js'
import { Notifier, sweepWaits } from './notify.js'
import { applyMessage, verifySignature, startSocketMode } from './slack.js'
import { buildCue } from './cues.js'
import { Coach } from './coach.js'
import { transcribePcm, transcriberInfo } from './stt.js'
import { AssistantChat } from './assistant.js'
import { coalesceTranscriptSegments, isNonSpeechText, parseTaskCommand, transcriptText } from './transcript.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0'
const INGEST_TOKEN = process.env.INGEST_TOKEN || ''
const READ_TOKEN = process.env.READ_TOKEN || ''
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || ''
const PERSIST = process.env.PERSIST_PATH || join(HERE, '..', 'data', 'values.json')
const CONFIG_PATH = process.env.CONFIG_PATH || join(HERE, 'boards.config.json')

const CHECKLISTS_PATH = process.env.CHECKLISTS_PATH || join(HERE, 'checklists.config.json')
const DATA_DIR = process.env.DATA_DIR || join(HERE, '..', 'data')
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || join(HERE, '..', 'downloads')
const PHONE_PACKAGE_PATH = process.env.PHONE_PACKAGE_PATH || join(DOWNLOADS_DIR, 'wam-latest.ehpk')
const AI_CUE_INTERVAL_MS = Math.max(30_000, Number(process.env.AI_CUE_INTERVAL_MS || 2 * 60_000))
const AI_CUE_LULL_MS = Math.max(3_000, Number(process.env.AI_CUE_LULL_MS || 8_000))
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

const inbox = new Inbox({
  storePath: join(DATA_DIR, 'inbox.json'),
  logPath: join(DATA_DIR, 'inbox.jsonl'),
})
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
      const run = active.find(r => r.checklistId === s.checklistId && !r.complete)

      // Drop every completed step individually, rather than slicing from a
      // cursor. The cursor model assumed you work top to bottom; Mike works a
      // list out of order by design, so a step finished early stayed in the
      // running order and kept adding its minutes to every total below it.
      // What is left is what is left, whatever order it got done in.
      const doneIds = new Set(
        (run?.items ?? []).filter(i => i.done).map(i => i.id),
      )
      let steps = s.plan
        .map((step, i) => ({ ...step, position: i + 1, total: s.plan.length }))
        .filter(step => !doneIds.has(step.id))

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
        schedulable: s.schedulable,
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
  const all = choresForPlan(requestedIds, space)
  const chores = all.filter(c => c.schedulable)
  const unestimated = all.filter(c => !c.schedulable)
  const plan = planBlock(chores, minutes)
  return {
    ...plan,
    // Tasks lead the screen, but as their own section above the list rather
    // than as rows in it. Scheduling by efficiency would bury every one of
    // them behind a dishwasher; folding them into the total corrupts it.
    tasks: taskRows(space),
    agenda: withDoneInline(withRunningTotal(agenda(plan, unestimated)), doneRows(space)),
    // Solo reach per chore, so the "what fits" screen can answer
    // "how far do I get with just this one" without a second request.
    reach: chores.map(c => ({ choreId: c.id, name: c.name, ...reach(c, minutes) })),
  }
}

function cueSpace(value) {
  return value === 'life' ? 'life' : 'ops'
}

function latestCoachModelCueForSession(space, sessionId, now = Date.now(), freshOnly = true) {
  if (!sessionId) return null

  const freshMs = Math.max(AI_CUE_INTERVAL_MS * 4, 2 * 60_000)
  return [...jobs.jobs.values()]
    .filter(job => job.capability === 'coach.cue' && job.status === JOB.DONE)
    .filter(job => job.input?.space === space && job.input?.sessionId === sessionId)
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

function coachSnapshotWithModel(space, now = Date.now()) {
  const snapshot = coach.snapshot(space)
  const modelCue = latestCoachModelCue(space, snapshot, now)
  if (snapshot.session) {
    snapshot.session = {
      ...snapshot.session,
      runningNote: modelRunningNote(modelCue, snapshot.session.runningNote),
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
  const recapLines = modelResult?.kind === 'recap' && Array.isArray(modelResult.lines)
    ? modelResult.lines.map(line => String(line || '').trim()).filter(Boolean).slice(0, 3)
    : []
  if (recapLines.length) return recapLines.join('\n').slice(0, 400)
  const note = modelRunningNote(modelResult)
  if (!note?.lines?.length) return null
  return note.lines.slice(0, 3).join('\n').slice(0, 400)
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
      const modelResult = latestCoachModelCueForSession(cueSpace(session.space), sessionId, Date.now(), false)
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

function scheduleCoachCue(session) {
  if (!session?.active || session.context?.taskId === '__assistant__') return
  const prior = coachCueTimers.get(session.id)
  if (prior) clearTimeout(prior)
  const expectedCount = session.segmentCount
  const timer = setTimeout(() => {
    coachCueTimers.delete(session.id)
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
  previousRunningNote = null,
} = {}) {
  if (!session) return null
  const safeSpace = cueSpace(session.space)
  const recentSegments = coalesceTranscriptSegments(session.segments ?? session.recentSegments)
    .slice(finalNote ? -64 : -32)
  if (recentSegments.length === 0) return null
  const mode = coach.getMode(session.modeId) ?? coach.activeMode(safeSpace)
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
      ...(finalNote ? { finalNote } : {}),
      constraints: {
        titleChars: 30,
        lineChars: 44,
        maxLines: 3,
        noteLineChars: 42,
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

function consolidatedSessionNote(session) {
  return transcriptText(session?.segments, 400)
}

function routeCoachSession(session, at = Date.now()) {
  const rawText = consolidatedSessionNote(session)
  if (!rawText) return { kind: 'empty', result: { ok: true } }
  const noteId = `${session.id}:note`
  const space = cueSpace(session.space)

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

  const modelResult = latestCoachModelCueForSession(space, session.id, at, false)
  const summaryText = modelNoteSummary(modelResult)
  // No model result means the Coach worker is not running — out of credit,
  // not installed, laptop asleep. That used to save the raw transcript, which
  // is how the Notes list ended up full of rows titled "uhh so I was
  // thinking". The distiller understands nothing, but it removes what speech
  // has and writing does not and puts a readable first line on top, which is
  // the difference between a note you can find and one you never open.
  const noteText = summaryText || distillNote(rawText) || rawText
  const noteBy = summaryText ? 'listen-ai' : 'listen'

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

function summaryText(text, max = 88) {
  return String(text || '')
    .replace(/^(?:add|create|make)\s+(?:a\s+)?(?:task|to-?do|todo)\s+(?:to\s+)?/i, '')
    .replace(/^(?:remind me to|remember to|i need to|need to)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function sessionSummary(session) {
  const segments = (session?.segments ?? []).filter(segment => segment.final !== false)
  if (segments.length === 0) return { title: 'Session recap', lines: [] }

  const lines = []
  const seen = new Set()
  const add = (prefix, text) => {
    const body = summaryText(text)
    const key = normalizeRouteText(`${prefix} ${body}`)
    if (!body || seen.has(key)) return
    seen.add(key)
    lines.push(`${prefix}: ${body}`)
  }

  for (const segment of segments.slice().reverse()) {
    const text = segment.text
    if (/\b(decided|decision|agreed|plan is|we will|we're going to|i will|i'll)\b/i.test(text)) {
      add('Decision', text)
    } else if (/\b(remind me to|remember to|need to|have to|should|follow up|call|text|email|send|book|schedule|pay|check|buy|file|finish|ask|tell)\b/i.test(text)) {
      add('Next', text)
    }
    if (lines.length >= 5) break
  }

  if (lines.length === 0 && session.context?.label) {
    lines.push(`Filed under: ${session.context.label}`)
  }
  if (lines.length === 0) lines.push(`Captured ${segments.length} line${segments.length === 1 ? '' : 's'}.`)
  return { title: 'Session recap', lines: lines.slice(0, 5) }
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

function enqueueTranscription(sessionId, pcm, body) {
  // A backlog means the model is slower than the speech. Dropping the oldest
  // is better than falling further behind for the rest of the conversation.
  if (transcribeQueue.length > 8) transcribeQueue.shift()
  transcribeQueue.push({ sessionId, pcm, body })
  sttStats.queued += 1
  void drainTranscriptions()
}

async function drainTranscriptions() {
  if (transcribing) return
  transcribing = true
  try {
    while (transcribeQueue.length) {
      const { sessionId, pcm, body, resolve } = transcribeQueue.shift()
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
          if (result.session.context?.taskId !== '__assistant__') {
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
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

  /**
   * Mirror of whatever is on the glasses.
   *
   * The hub cannot know what the display shows — the rendering happens in the
   * app — so the app posts each frame here and this hands it back. One string,
   * no second renderer to drift out of sync with the first.
   */
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

  // The iPad controller. The glasses are glanceable; this is the surface the
  // system is actually driven from, with room for the columns nine lines has
  // to compress.
  if (req.method === 'GET' && url.pathname === '/pad') {
    try {
      const html = readFileSync(join(WEB_DIR, 'pad.html'))
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
    return json(res, 200, sessionSummary(session))
  }

  const coachTranscriptMatch = url.pathname.match(/^\/coach\/session\/([^/]+)\/transcript$/)
  if (req.method === 'GET' && coachTranscriptMatch) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    const session = coach.session(decodeURIComponent(coachTranscriptMatch[1]))
    if (!session) return json(res, 404, { error: 'unknown session' })
    const rawSegments = (session.segments ?? []).filter(segment => segment.final !== false)
    return json(res, 200, {
      ok: true,
      id: session.id,
      title: session.title,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      context: session.context ?? null,
      // Readers get speech-sized blocks; diagnostics retain every exact STT
      // transport chunk without forcing the glasses to display those chunks.
      segments: coalesceTranscriptSegments(rawSegments),
      rawSegments,
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
      const result = coach.removeSession(id)
      if (result.ok) jobs.removeForCoachSession(id)
      return json(res, result.ok ? 200 : 404, result)
    }

    if (action === 'end') {
      const id = decodeURIComponent(sessionId)
      const result = coach.endSession(id, body.at)
      const timer = coachCueTimers.get(id)
      if (timer) clearTimeout(timer)
      coachCueTimers.delete(id)
      const session = result.ok ? coach.session(id) : null
      const note = session && session.context?.taskId !== '__assistant__'
        ? routeCoachSession(session, body.at)
        : null
      if (session) {
        jobs.discardQueuedCoachCuesForSession(session.id)
        if (note?.result?.ok && note.summaryTarget) {
          const prior = latestCoachModelCueForSession(cueSpace(session.space), session.id, Date.now(), false)
          createCoachCueJob(session, {
            reason: 'session-end',
            priority: 'now',
            finalNote: note.summaryTarget,
            previousRunningNote: modelRunningNote(prior),
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
      if (result.session.context?.taskId !== '__assistant__') {
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
    return json(res, 200, { items: inbox.active(), pending: inbox.pending().length })
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
    return json(res, result.ok ? 200 : 404, { ...result, tasks: tasks.list() })
  }

  if (req.method === 'GET' && url.pathname === '/tasks') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    return json(res, 200, { tasks: tasks.list() })
  }

  // ---- assistant chat --------------------------------------------------
  if (url.pathname === '/assistant/chat' || url.pathname === '/assistant/chat/from-session') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    const querySpace = cueSpace(url.searchParams.get('space'))
    const queryProvider = url.searchParams.get('provider') === 'claude' ? 'claude' : 'chatgpt'

    if (req.method === 'GET' && url.pathname === '/assistant/chat') {
      return json(res, 200, { ok: true, chat: assistant.snapshot(querySpace, queryProvider, jobs) })
    }

    let body = {}
    try {
      const raw = await readBody(req)
      if (raw) body = JSON.parse(raw)
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
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
      const available = capability === 'coach.cue'
        ? jobs.availableCoachCues([
            coach.currentSession('ops')?.id,
            coach.currentSession('life')?.id,
          ])
        : jobs.available(capability)
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

      if (action === 'claim') {
        result = jobs.claim(id, agent, body.leaseSeconds)
      } else if (action === 'heartbeat') {
        result = jobs.heartbeat(id, agent, body.leaseSeconds)
      } else if (action === 'result') {
        const job = jobs.get(id)
        result = jobs.finish(id, agent, body.result)
        // Triage results are applied here rather than by the agent: the agent
        // should not need to know what an inbox is.
        if (result.ok && job?.capability === 'triage') {
          const applied = applyTriageResult(body.result)
          console.log(`[triage] applied ${applied} item(s) from ${agent}`)
        }
        if (result.ok && job?.capability === 'coach.cue' && job.input?.finalNote) {
          const applied = applyFinalListenSummary(job, body.result)
          if (applied.ok) console.log(`[coach] applied final Listen summary from ${agent}`)
          else console.warn(`[coach] could not apply final Listen summary: ${applied.error}`)
        }
      } else {
        result = jobs.fail(id, agent, body.error, body.retry !== false)
      }

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
  if (req.method === 'POST' && ['/check', '/run/start', '/run/finish', '/step/begin', '/step/reset', '/remind'].includes(url.pathname)) {
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
    // Return the fresh checklist state so the glasses can repaint from the
    // server's view rather than guessing at what its own write did.
    return json(res, 200, { ok: true, checklists: checklists.snapshot() })
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

checklists.maybeRollup()
setInterval(() => {
  try {
    checklists.maybeRollup()
  } catch (err) {
    console.warn(`[checklists] rollup failed: ${err.message}`)
  }
}, 5 * 60 * 1000)

startSocketMode({
  appToken: process.env.SLACK_APP_TOKEN,
  botToken: process.env.SLACK_BOT_TOKEN,
  config,
  store,
}).catch(err => console.warn(`[slack] ${err.message}`))
