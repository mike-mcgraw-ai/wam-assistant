export type Status = 'ok' | 'warn' | 'alert' | 'stale'

/** 'ops' is the building, 'life' is home. The glasses show one at a time. */
export type Space = 'ops' | 'life'

export interface Metric {
  id: string
  label: string
  unit: string
  value: number | string | null
  status: Status
  ageSeconds: number | null
  source: string | null
  note: string
}

export interface Board {
  id: string
  name: string
  space: Space
  status: Status
  counts: Partial<Record<Status, number>>
  summary: string
  metrics: Metric[]
}

export interface SttStats {
  queued: number
  pending: number
  ok: number
  empty: number
  failed: number
  lastError: string | null
  lastText: string | null
  lastMs: number
  provider: string
  configured: boolean
}

export interface Snapshot {
  generatedAt: string
  boards: Board[]
  /** Absent on older server builds; the UI treats that as "no checklists". */
  checklists?: ChecklistsState
  stats?: ChecklistStats[]
  /** grouped shared-list items; absent on older server builds */
  inbox?: InboxGroup[]
  /** what the transcriber has been doing; absent on older server builds */
  stt?: SttStats
  assistant?: Record<AssistantProvider, boolean>
  /** Life game summary, scored server-side by fixed rules; absent on older servers. */
  game?: GameSummary
}

export interface GameSummary {
  level: number
  xp: number
  into: number
  size: number
  toNext: number
  streak: number
  todayEarned: number
}

export type AssistantProvider = 'chatgpt' | 'claude'

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  at: number
}

export interface AssistantPendingJob {
  id?: string
  status: 'queued' | 'claimed' | 'blocked' | 'done' | 'failed'
  claimedBy: string | null
  attempts: number
  createdAt: number
  updatedAt: number
}

export interface AssistantChat {
  provider: AssistantProvider
  ready: boolean
  busy: boolean
  queued?: number
  activeSource?: { kind: string; clientId?: string; noteId?: string; subjectId?: string; label?: string } | null
  pending: AssistantPendingJob | null
  messages: AssistantMessage[]
  updatedAt: number
}

export type AssistantChatResponse =
  | { ok: true; chat: AssistantChat }
  | { ok: false; pending?: boolean; error: string }

/**
 * - `do`    something you do, timed: click starts, click again finishes
 * - `wait`  a machine running: click starts the countdown, click again ends it
 * - `check` a single click, done, and the time it happened is the record
 *
 * `check` exists because not everything worth ticking is worth timing. You are
 * not going to reopen the list wet to stop the clock on the shower, and a step
 * left running all morning is worse data than no duration at all.
 */
export type StepKind = 'do' | 'wait' | 'check'

export interface ChecklistItem {
  id: string
  label: string
  /** 'do' costs you time; 'wait' costs the clock time while you do something else */
  stepKind: StepKind
  estimateMinutes: number | null
  waitMinutes: number | null
  done: boolean
  /** epoch ms when it was checked, null while unchecked */
  at: number | null
  startedAt: number | null
  /** a step whose clock is running but which is not finished */
  running: boolean
  elapsedMs: number | null
  /** running far longer than plausible — started by accident or forgotten */
  suspect: boolean
  /** how long after the previous step finished this one was started */
  lagMs: number | null
  autoStart: boolean
  /** when an armed wait comes due; null for 'do' steps and unstarted waits */
  endsAt: number | null
  /** goes negative once a wait is overdue but not yet ticked */
  remainingSeconds: number | null
  durationMs: number | null
}

export interface ChecklistRun {
  runId: string
  checklistId: string
  name: string
  kind: 'daily' | 'ondemand'
  space: Space
  day: string
  done: number
  total: number
  complete: boolean
  /** when the most recent step was ticked; null if none */
  lastAt: number | null
  startedAt: number
  finishedAt: number | null
  ageSeconds: number
  /** time you actually spend — the number that answers "can I start this now" */
  activeMs: number
  /** elapsed until finished — the number that answers "will it be done by then" */
  wallMs: number
  currentItemId: string | null
  items: ChecklistItem[]
}

export interface InboxItem {
  id: string
  text: string
  by: string
  createdAt: number
  status: 'raw' | 'sorted' | 'done'
  kind: string | null
  list: string | null
  parts: string[] | null
  note: string | null
}

export interface InboxGroup {
  name: string
  items: InboxItem[]
}

export interface ChecklistStepStats {
  id: string
  label: string
  stepKind: StepKind
  samples: number
  medianMs: number | null
}

export interface PlanStep {
  at: number
  endsAt: number
  choreId: string
  chore: string
  stepId: string
  step: string
  stepKind: StepKind
  ms: number
  measured: boolean
  /** the step is still running when the block ends */
  overruns: boolean
}

export interface PlanReach {
  choreId: string
  name: string
  stepsDone: number
  total: number
  complete: boolean
  stoppedAt: string | null
}

export type AgendaRow =
  | {
      kind: 'gap'
      at: number
      ms: number
      running: string[]
      nextFree: { chore: string; step: string; endsAt: number } | null
      /** unchanged across a gap: waiting is not working */
      cumulativeBusyMs: number | null
      /** advances across a gap: this is the column the wait shows up in */
      cumulativeWallMs: number | null
    }
  | {
      kind: 'do'
      /** null on an unestimated item: listed, not scheduled */
      at: number | null
      endsAt: number | null
      ms: number | null
      chore: string
      choreId: string
      step: string
      stepId: string
      stepIndex: number
      stepTotal: number
      measured: boolean
      /** false when an earlier step of the same chore has to happen first */
      open: boolean
      /** minutes of actual work to get here, waits excluded */
      cumulativeBusyMs: number | null
      /** minutes of wall clock to get here, waits included */
      cumulativeWallMs: number | null
    }

/**
 * A big-ticket one-off: a phone call, a trip, a thing you have been avoiding.
 *
 * Kept apart from the agenda on purpose. These are not steps you slot into a
 * spare twenty minutes, so they get no running total and a different shape on
 * screen — a row that looks like the chore list invites you to read it like
 * the chore list.
 *
 * `open` here means "inside its time window right now", which is a different
 * question from a chore step's `open` ("no earlier step is in the way"). It
 * never affects the ordering; it only decides whether the row says when it
 * opens.
 */
export interface TaskRow {
  kind: 'task'
  taskId: string
  label: string
  /** context, e.g. "Wilkes Barre PA" — not always shown */
  note: string
  ms: number | null
  open: boolean
  weight: 'big' | 'normal'
  /** Start Day heard this as multi-step work; voice planning is the first action. */
  needsPlan?: boolean
  /** "9am" / "Thu9a" when shut; null while it is open */
  opensLabel: string | null
  /**
   * What you know about this task, oldest first.
   *
   * The reason tasks are not checkboxes. "Call dentist" is blocked on finding
   * out which dentist; "Replace car tire" is really three hours of driving and
   * a day off work. A row that cannot carry that is a row that nags without
   * ever telling you how to start.
   */
  notes: TaskNote[]
}

export interface TaskNote {
  id: string
  text: string
  by: string
  /** 0 for a note seeded from the config */
  at: number
}

export interface ChecklistNote extends TaskNote {
  checklistId: string
  label: string
  space?: Space
}

export interface DoneRow {
  kind: 'done'
  chore: string
  choreId: string
  runId: string
  step: string
  stepId: string
  at: number
  /** how long it actually took */
  ms: number | null
  cumulativeBusyMs: null
  cumulativeWallMs: null
}

export type MorningBriefStatus = 'ok' | 'stale' | 'notConfigured' | 'disabled' | 'error'

export interface MorningBriefSource {
  id: 'texts' | 'mail' | 'linkedin' | 'weather' | 'money' | string
  label: string
  status: MorningBriefStatus
  kind: string
  value: number | string | boolean | null
  display: string
  asOf: string | null
  staleAt: string | null
  ttlSeconds: number | null
  source: string | null
  confidence: string
  privacy: string
  error: string | null
  slots?: Array<{
    id: string
    label: string
    display: string
    asOf: string | null
    confidence: string
  }>
}

export interface MorningBrief {
  schemaVersion: number
  space: Space
  day: string
  generatedAt: string
  snapshotAt: string
  mode: 'morning' | 'started' | string
  started: boolean
  summary: {
    line1: string
    line2: string
    line3: string
    asOfLabel: string
  }
  sources: Record<string, MorningBriefSource>
}

export interface DayDraftItem {
  id: string
  kind: 'checklist' | 'task'
  label: string
  include: boolean
  checklistId?: string
  startIndex?: number
  fromStep?: string | null
  note?: string
  source?: string
  conflict?: string
  uncertain?: boolean
}

export interface DayDraft {
  id: string
  createdAt: number
  transcript: string
  items: DayDraftItem[]
}

export interface BlockPlan {
  minutes: number
  budgetMs: number
  timeline: PlanStep[]
  busyMs: number
  idleMs: number
  progress: Array<{ choreId: string; name: string; stepsDone: number; total: number; complete: boolean }>
  reach: PlanReach[]
  agenda: (AgendaRow | DoneRow)[]
  tasks: TaskRow[]
  day?: {
    day: string
    startHour: number
    started: boolean
    /** "Skip for now" chosen today; the normal list shows, Start Day stays one row away. */
    skipped?: boolean
    skippedAt?: number | null
    startedAt: number | null
    checklistIds: string[]
    /** Today's runs plus every unfinished one-off committed by any Start Day walk. */
    runIds?: string[]
    taskIds?: string[]
    transcript: string
    /** A spoken Start Day proposal waiting for explicit review and commit. */
    draft?: DayDraft
  } | null
  morningBrief?: MorningBrief | null
}

export interface CoachCue {
  id: string
  title: string
  lines: string[]
  kind: 'reminder' | 'recap' | 'task' | 'list' | 'ops' | 'answer' | 'followup' | 'factcheck' | 'advice' | 'thought'
  priority: number
  quiet: boolean
  createdAt: number
  expiresAt: number
  nextAfterMs: number
}

export type CoachCueResponse =
  | { ok: true; cue: CoachCue; changed: boolean; nextAfterMs: number }
  | { ok: false; error: string }

export interface CoachMode {
  id: string
  name: string
  category: string
  keepPrivate: boolean
  behavior: string
  cueTypes: {
    answers: boolean
    followups: boolean
    explanations: boolean
    factChecks: boolean
    advice: boolean
    thoughts: boolean
  }
  speakUp: 'low' | 'medium' | 'high'
  promptLulls: boolean
  periodicRecap: boolean
  recapMinutes: number
  lullSeconds: number
  files: string[]
}

export interface CoachSegment {
  id: string
  clientId: string | null
  speaker: string
  text: string
  final: boolean
  at: number
}

export interface CoachRunningNote {
  title: string
  lines: string[]
  updatedAt: number | null
  segmentCount: number
}

export interface CoachSessionSummary {
  id: string
  space: Space
  modeId: string
  modeName: string
  title: string
  startedAt: number
  updatedAt: number
  endedAt: number | null
  active: boolean
  context?: { taskId?: string; choreId?: string; reviewItemId?: string; reviewRevision?: number; amendmentKind?: 'correction' | 'detail'; label: string } | null
  segmentCount: number
  recentSegments: CoachSegment[]
  runningNote: CoachRunningNote | null
  /** Listen board topics and condensed points; absent from older hubs. */
  board?: {
    topics: string[]
    points: string[]
    overallTopic?: string
    sections?: string[]
    currentSummary?: string[]
    updatedAt: number | null
    segmentCount: number
  } | null
  aiState?: {
    status: 'listening' | 'thinking' | 'quiet' | 'cue' | 'error'
    segmentCount: number
    updatedAt: number | null
  } | null
  lastCueAt: number | null
  lastRecapAt: number | null
}

export interface NoteTranscript {
  noteId: string
  sessionId: string
  title: string
  startedAt: number
  endedAt: number | null
  segments: CoachSegment[]
}

export type CoachSessionResponse =
  | { ok: true; space: Space; mode: CoachMode; modes?: CoachMode[]; session: CoachSessionSummary | null; cue?: CoachCue | null }
  | { ok: false; error: string }

export type CoachSessionWriteResponse =
  | {
      ok: true
      session: CoachSessionSummary
      existing?: boolean
      note?: {
        kind: string
        result: {
          ok: boolean
          error?: string
          checklistIds?: string[]
          matched?: Array<{ id: string; name: string }>
          draft?: DayDraft
        }
      } | null
    }
  | { ok: false; error: string }

export type CoachSessionDiscardResponse =
  | { ok: true }
  | { ok: false; error: string }

export interface ChecklistStats {
  checklistId: string
  name: string
  samples: number
  /** false while there are too few runs to trust the median over the estimate */
  trusted: boolean
  activeMs: number
  wallMs: number
  steps: ChecklistStepStats[]
}

export interface StartableChecklist {
  id: string
  name: string
  total: number
  space: Space
}

export interface ChecklistsState {
  active: ChecklistRun[]
  startable: StartableChecklist[]
  /** Durable notes attached to a chore rather than one particular run. */
  notes?: ChecklistNote[]
}
