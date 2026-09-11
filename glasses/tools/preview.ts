/**
 * Renders every screen to the terminal inside a 44-column frame, using live
 * data from the server. Lets you check line lengths, wrapping and the
 * character budget without the simulator or hardware.
 *
 *   npm run preview
 */
import { fetchCoachCue, fetchSnapshot } from '../src/api'
import { render, type UiState } from '../src/render'
import { LINE_CHARS } from '../src/format'
import { config } from '../src/config'

const frame = (title: string, body: string) => {
  const lines = body.split('\n')
  const over = lines.filter(l => l.length > LINE_CHARS)
  const bar = '-'.repeat(LINE_CHARS + 2)
  console.log(`\n${title}  (${body.length} chars, ${lines.length} lines)`)
  console.log(`+${bar}+`)
  for (const line of lines) console.log(`| ${line.padEnd(LINE_CHARS)} |`)
  console.log(`+${bar}+`)
  if (over.length) console.log(`  !! ${over.length} line(s) exceed ${LINE_CHARS} cols`)
  if (body.length > config.maxChars) console.log(`  !! over maxChars (${config.maxChars})`)
  if (lines.length > 11) console.log(`  !! ${lines.length} lines may not fit 288px`)
}

const result = await fetchSnapshot()
if (!result.ok) {
  console.error(`fetch failed: ${result.error} (is the server running on ${config.serverUrl}?)`)
  process.exit(1)
}

const base: UiState = {
  view: { kind: 'index', cursor: 0 },
  snapshot: result.snapshot,
  error: null,
  loading: false,
  lastOkAt: Date.now(),
  fromCache: false,
  alertsOnly: false,
  plan: null,
  planLoading: false,
  cue: null,
  cueReturn: null,
  pong: null,
  events: 0,
  lastEvent: '-',
  diagnostics: false,
  space: 'life',
  scrollTop: 0,
  armedTaskId: null,
}

frame('INDEX', render(base))
frame('INDEX (flagged only)', render({ ...base, alertsOnly: true }))
frame('INDEX (network down)', render({ ...base, error: 'timeout' }))
frame('INDEX (cold start, cached)', render({ ...base, fromCache: true }))

const lifeCue = await fetchCoachCue('life')
if (lifeCue.ok) {
  frame('LIFE INDEX (no auto AI widget)', render({ ...base, cue: lifeCue.cue }))
  frame('COACH (manual)', render({ ...base, cue: lifeCue.cue, view: { kind: 'cue' } }))
}

const opsCue = await fetchCoachCue('ops')
if (opsCue.ok) {
  frame('OPS DASHBOARD (AI widget)', render({ ...base, space: 'ops', cue: opsCue.cue }))
}

for (const board of result.snapshot.boards) {
  frame(`BOARD ${board.id}`, render({ ...base, view: { kind: 'board', boardId: board.id, cursor: 0 } }))
}
