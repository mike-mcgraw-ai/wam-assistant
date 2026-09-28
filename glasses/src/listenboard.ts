/**
 * Listen, laid out across the whole 576x288 panel (four 288x144 tiles).
 *
 *   +-------------------+-------------------+
 *   | TOPICS     status | AI CUE            |
 *   | newest first      | fact checks,      |
 *   |                   | answers, follow-  |
 *   |                   | ups               |
 *   +-------------------+-------------------+
 *   | SUMMARY           | TRANSCRIPT        |
 *   | condensed points  | cleaned, newest   |
 *   | from the AI       | at the bottom     |
 *   +-------------------+-------------------+
 *
 * One block per tile, so a new transcript line redraws one tile, not two.
 * This file decides WHAT goes in each block; fullpanel.ts draws it. Nothing
 * here touches the DOM. v0.103.0 (Claude).
 */
import { config } from './config'
import type { UiState } from './render'
import type { CoachSegment } from './types'

export interface ListenBlock {
  /** small dim label, top left of the tile */
  title: string
  /** small dim note, top right of the tile */
  note: string
}

export interface ListenBoard {
  topicsBlock: ListenBlock
  topics: { text: string; current: boolean }[]
  summaryBlock: ListenBlock
  /** condensed points; each wraps with a hanging indent */
  summary: string[]
  /** true when summary holds a placeholder, drawn as-is */
  summaryPending: boolean
  cueBlock: ListenBlock
  cue: string[]
  cuePending: boolean
  transcriptBlock: ListenBlock
  transcript: { speaker: 'me' | 'other'; text: string }[]
  /** wrapped transcript rows to wind back from live */
  scrollBack: number
  /** shown as the last row of the summary block, e.g. the review prompt */
  footer: string | null
  /** shown in the transcript block when there is no transcript yet */
  emptyNote: string | null
}

// ---- topics ------------------------------------------------------------------

/**
 * Topic history per session. The hub only ever sends the CURRENT thread, so
 * the list of how the conversation moved has to be remembered here. It lives
 * for as long as the app is loaded; a reload starts a fresh list.
 */
const topicLog = new Map<string, string[]>()

function words(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(' ').filter(word => word.length > 2),
  )
}

/** Same topic reworded ("Weekend plans" -> "Planning the weekend")? */
function sameTopic(a: string, b: string): boolean {
  const left = words(a)
  const right = words(b)
  if (left.size === 0 || right.size === 0) return a.toLowerCase() === b.toLowerCase()
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / Math.min(left.size, right.size) >= 0.5
}

function noteField(lines: string[], name: string): string | null {
  const pattern = new RegExp(`^${name}\\s*:\\s*`, 'i')
  const line = lines.find(candidate => pattern.test(candidate))
  const value = line?.replace(pattern, '').replace(/\s+/g, ' ').trim()
  return value || null
}

const TOPIC_GLUE = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'at', 'because', 'been', 'before', 'but', 'can',
  'did', 'do', 'does', 'doing', 'for', 'found', 'from', 'got', 'had', 'has', 'have', 'her', 'here',
  'him', 'his', 'how', 'into', 'its', 'just', 'like', 'look', 'me', 'my', 'not', 'now', 'of', 'on',
  'or', 'our', 'said', 'she', 'so', 'some', 'something', 'that', 'the', 'their', 'them', 'there',
  'they', 'this', 'to', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'with', 'you',
  'your',
])

/** A topic is a durable subject label, not the last tiny thing STT heard. */
function meaningfulTopic(raw: string | null): string | null {
  const text = String(raw || '').replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim()
  const tokens = text.toLowerCase().match(/[a-z0-9']+/g) ?? []
  if (tokens.length < 2) return null
  const content = tokens.filter(token => token.length > 1 && !TOPIC_GLUE.has(token))
  return content.length >= 2 ? text : null
}

function recordTopic(sessionId: string, topic: string | null): string[] {
  const log = topicLog.get(sessionId) ?? []
  if (topic) {
    const last = log[log.length - 1]
    if (!last) log.push(topic)
    else if (sameTopic(last, topic)) log[log.length - 1] = topic
    else log.push(topic)
    if (log.length > 30) log.splice(0, log.length - 30)
  }
  topicLog.set(sessionId, log)
  return log
}

// ---- transcript cleanup ------------------------------------------------------

const FILLERS = new Set([
  'um', 'umm', 'ummm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'hmm', 'hm', 'mm', 'mhm', 'mmhmm',
])

/** A sentence cannot end on these, so a period after one is a chunk boundary. */
const NO_END = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'but', 'or', 'with', 'from', 'by', 'into', 'is', 'are',
  'was', 'were', 'be', 'been', 'my', 'your', 'our', 'their', 'his', 'her', 'its', 'these',
  'those', 'if', 'because', 'than', 'as', 'very', 'gonna', 'wanna', 'i', "i'm", 'we', 'they',
])

/** A period before one of these was a chunk boundary mid-clause: drop it. */
const CONTINUERS = new Set(['that', 'to', 'of', 'than', 'whether'])

/** A period before one of these was almost always a comma. */
const JOINERS = new Set(['and', 'but', 'so', 'or', 'because', 'cause', 'which', 'then', 'plus'])

/** Words safe to lowercase when two chunks are merged. Names are never in here. */
const COMMON = new Set([
  ...NO_END, ...JOINERS,
  'you', 'he', 'she', 'it', "it's", 'that', "that's", 'there', "there's", 'this', 'what', 'how',
  'why', 'when', 'where', 'yeah', 'yes', 'no', 'okay', 'ok', 'well', 'just', 'like', 'maybe',
  'not', "don't", 'do', 'did', 'can', 'will', 'would', 'should', 'could', 'have', 'has', 'had',
  'get', 'got', 'go', 'know', 'think', 'mean', 'right', 'all', 'at', 'in', 'on', 'for', 'about',
  'with', 'we', 'they', "we're", "they're", "you're", 'let', "let's", 'now', 'also', 'still',
])

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'etc', 'jr', 'sr'])

const core = (token: string): string => token.toLowerCase().replace(/[^a-z0-9']/g, '')
const isPronounI = (word: string): boolean => /^i('|$)/.test(word)

function lower(token: string): string {
  return token.charAt(0).toLowerCase() + token.slice(1)
}

function lowerIfCommon(token: string): string {
  const word = core(token)
  if (!COMMON.has(word) || isPronounI(word)) return token
  return lower(token)
}

/**
 * Words seen capitalised in the middle of a sentence ("I think a family member said"):
 * those are names, and merging two chunks must not lowercase them.
 */
function namesIn(tokens: string[]): Set<string> {
  const names = new Set<string>()
  for (let index = 1; index < tokens.length; index += 1) {
    if (/[.?!]$/.test(tokens[index - 1])) continue
    if (/^[A-Z]/.test(tokens[index]) && !isPronounI(core(tokens[index]))) names.add(core(tokens[index]))
  }
  return names
}

/**
 * Filler out, stutters out, chunk-boundary periods turned back into commas or
 * nothing. Speech-to-text runs on ~2 s chunks and ends each one with a period,
 * which is where most of the stray full stops come from.
 */
export function cleanSpeech(raw: string): string {
  const tokens: string[] = []
  for (const token of raw.replace(/\s+/g, ' ').trim().split(' ')) {
    if (!token) continue
    const word = core(token)
    const previous = tokens[tokens.length - 1]

    if (FILLERS.has(word)) {
      // "going there, um." keeps its full stop on the word before.
      const end = token.match(/[.?!]+$/)?.[0]
      if (end && previous && !/[.?!]$/.test(previous)) tokens[tokens.length - 1] = previous.replace(/[,;:]+$/, '') + end
      continue
    }
    // "I, I think" / "the the"
    if (previous && word && word === core(previous) && word !== 'had' && !/[.?!]$/.test(previous)) {
      tokens[tokens.length - 1] = previous.replace(/[,;:]+$/, '')
      continue
    }
    tokens.push(token)
  }

  const names = namesIn(tokens)
  let sinceBoundary = 0
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index]
    sinceBoundary += 1
    if (!/[^.]\.$/.test(token)) {
      if (/[.?!]$/.test(token)) sinceBoundary = 0
      continue
    }
    const word = core(token)
    if (ABBREVIATIONS.has(word) || /^\d/.test(word)) continue
    const next = core(tokens[index + 1])

    if (NO_END.has(word) || CONTINUERS.has(next)) {
      // Mid-clause: "go to the. Store" -> "go to the store".
      tokens[index] = token.slice(0, -1)
      if (!isPronounI(next) && !names.has(next)) tokens[index + 1] = lower(tokens[index + 1])
    } else if (JOINERS.has(next) || (sinceBoundary <= 2 && COMMON.has(next) && !isPronounI(next))) {
      tokens[index] = `${token.slice(0, -1)},`
      tokens[index + 1] = lowerIfCommon(tokens[index + 1])
    } else {
      sinceBoundary = 0
    }
  }

  const text = tokens.join(' ').replace(/\s+([,.?!])/g, '$1').replace(/,{2,}/g, ',').trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function cleanBlocks(segments: CoachSegment[]): { speaker: 'me' | 'other'; text: string }[] {
  const blocks: { speaker: 'me' | 'other'; text: string }[] = []
  for (const segment of segments) {
    const speaker = segment.speaker === 'me' ? 'me' : 'other'
    const text = segment.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const previous = blocks[blocks.length - 1]
    // Join the whole run from one speaker BEFORE cleaning, so the periods at
    // chunk boundaries are visible to the cleaner.
    if (previous && previous.speaker === speaker && previous.text.length < 600) {
      previous.text = `${previous.text} ${text}`
    } else {
      blocks.push({ speaker, text })
    }
  }
  return blocks
    .map(block => ({ speaker: block.speaker, text: cleanSpeech(block.text) }))
    .filter(block => block.text.length > 0)
}

// ---- the board ---------------------------------------------------------------

function shortTime(now = new Date()): string {
  const h24 = now.getHours()
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h}:${String(now.getMinutes()).padStart(2, '0')}${h24 < 12 ? 'a' : 'p'}`
}

/** Minute-grained, so a label does not change (and cost a send) every second. */
function age(at: number | null | undefined, now = Date.now()): string {
  if (!at) return ''
  const minutes = Math.floor((now - at) / 60_000)
  return minutes >= 1 ? `${minutes}m ago` : ''
}

const CONVERSATION_CUES = new Set(['answer', 'followup', 'factcheck', 'advice', 'thought', 'recap'])
const CUE_LABEL: Record<string, string> = {
  answer: 'AI CUE - ANSWER',
  followup: 'AI CUE - FOLLOW-UP',
  factcheck: 'AI CUE - FACT CHECK',
  advice: 'AI CUE - ADVICE',
  thought: 'AI CUE - THOUGHT',
  recap: 'AI CUE - RECAP',
}

/**
 * The four-block Listen board, or null when the old single-column screen
 * should draw instead (mode picker, nothing recorded, debug view).
 */
export function listenBoard(state: UiState): ListenBoard | null {
  if (state.view.kind !== 'cue' || config.listenDebug) return null
  const session = state.coachSession
  if (!session) return null
  const segments = session.recentSegments ?? []
  if (!session.active && segments.length === 0) return null

  const now = Date.now()
  const scrollBack = state.view.scroll ?? 0
  const armed = state.view.startArmed === true
  const reviewing = session.active && state.listenReviewing
  const a = state.audio
  const mic = !a?.open ? 'MIC OFF' : a.sent > 0 ? 'MIC*' : a.frames > 0 ? 'MIC.' : 'MIC?'
  const status = !session.active
    ? armed ? 'READY? click starts' : 'STOPPED - click arms'
    : `${reviewing ? 'REVIEW' : 'LISTEN'}  ${shortTime()}  ${reviewing ? 'STOP' : mic}`
  const aiStatus = session.aiState?.status
  const aiNote = aiStatus === 'thinking' ? 'AI updating' : aiStatus === 'error' ? 'AI failed' : ''
  const board = session.board ?? null
  const note = session.runningNote?.lines ?? []
  const transcript = cleanBlocks(segments)

  // Raw STT changes the transcript tile only. Topics wait for an AI board and
  // reject incidental fragments so this panel stays stable and glanceable.
  const modelTopics = (board?.topics ?? [])
    .map(topic => meaningfulTopic(topic))
    .filter((topic): topic is string => Boolean(topic))
  const log = modelTopics.length > 0
    ? modelTopics
    : recordTopic(session.id, meaningfulTopic(noteField(note, 'Thread')))
  const topics = log.slice().reverse().map((text, index) => ({ text, current: index === 0 }))

  // Summary also waits for the model. Mirroring each raw sentence here made
  // both left tiles churn and mistook transport chunks for complete thoughts.
  let summary = board?.points?.length
    ? board.points
    : note.filter(line => !/^Thread\s*:/i.test(line)).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const summaryPending = summary.length === 0
  if (summaryPending) {
    summary = [aiStatus === 'error' ? 'Summary unavailable. Still recording.' : 'Starts about 15 s into the talk.']
  }

  // Cue: only conversation help belongs here, not chore reminders.
  const cue = state.cue
  const liveCue = cue && CONVERSATION_CUES.has(cue.kind) && cue.createdAt >= session.startedAt
    && (!cue.expiresAt || cue.expiresAt > now) && cue.lines?.length ? cue : null
  const cueLines = liveCue
    ? [
        ...(liveCue.title && !/^(coach|listening)$/i.test(liveCue.title) ? [liveCue.title] : []),
        ...liveCue.lines.map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean),
      ]
    : ['Nothing to add yet.', 'Answers, fact checks and follow-up ideas show up here.']

  let emptyNote: string | null = null
  if (segments.length === 0 && session.active) {
    const stt = state.snapshot?.stt
    emptyNote = !a?.open ? 'No lines yet - mic closed'
      : a.sent === 0 ? 'No lines yet - nothing sent to hub'
      : stt && stt.failed > 0 ? 'No lines yet - hub stt failing'
      : stt && stt.empty > 0 ? 'No lines yet - hub stt heard nothing'
      : 'No lines yet - waiting on hub'
  }

  return {
    topicsBlock: { title: 'TOPICS', note: status },
    topics,
    summaryBlock: {
      title: 'SUMMARY',
      note: aiNote || age(board?.updatedAt ?? session.runningNote?.updatedAt, now),
    },
    summary,
    summaryPending,
    cueBlock: { title: liveCue ? CUE_LABEL[liveCue.kind] ?? 'AI CUE' : 'AI CUE', note: liveCue ? age(liveCue.createdAt, now) : '' },
    cue: cueLines,
    cuePending: !liveCue,
    transcriptBlock: { title: 'TRANSCRIPT', note: scrollBack > 0 ? `back ${scrollBack}` : '' },
    transcript,
    scrollBack,
    footer: reviewing ? 'click saves - back discards' : null,
    emptyNote,
  }
}
