import { layout, measure, USABLE_PX } from './metrics'
import type { AgendaRow, Board, ChecklistItem, ChecklistRun, ChecklistStats, InboxGroup, InboxItem, Metric, Status, TaskRow } from './types'

/**
 * Text formatting for a 576x288 monochrome canvas.
 *
 * The firmware font is fixed and not monospace, so column counts here are a
 * conservative estimate rather than a guarantee. LINE_CHARS is tuned low on
 * purpose: a line that wraps unexpectedly costs a whole row and pushes the
 * bottom of the page out of view. Measure on real hardware and adjust.
 */
export const LINE_CHARS = 44

/**
 * Status glyphs, ASCII only.
 *
 * The firmware silently drops glyphs outside its font set, and a dropped status
 * marker reads as "fine" — the most dangerous possible failure for this app.
 * ASCII is guaranteed. Swap for Unicode block characters only after checking
 * them against the glyph list in the Figma design guidelines.
 */
export const GLYPH: Record<Status, string> = {
  alert: 'X',
  warn: '!',
  stale: '?',
  ok: '.',
}

/**
 * Progress bar characters.
 *
 * ASCII by default. The design guidelines list Unicode block characters as a
 * supported pattern for bars, and they look considerably better — swap these
 * two constants once you have confirmed the glyphs render on real glasses.
 * A block that is missing from the firmware font is dropped silently, which
 * would turn a half-full bar into an empty one.
 */
export const BAR_FILL = '#'
export const BAR_EMPTY = '-'

/** "[####------]" — done out of total, in `width` cells. */
export function bar(done: number, total: number, width = 8): string {
  if (total <= 0) return `[${BAR_EMPTY.repeat(width)}]`
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)))
  // Never show a full bar for partial progress: rounding 7/8ths up to full
  // would say "done" about something that is not.
  const capped = done < total && filled === width ? width - 1 : filled
  return `[${BAR_FILL.repeat(capped)}${BAR_EMPTY.repeat(width - capped)}]`
}

/** Right-align in `width` cells, so digits line up down the column. */
export function padLeft(text: string, width: number): string {
  const clipped = text.length > width ? text.slice(0, width) : text
  return ' '.repeat(Math.max(0, width - clipped.length)) + clipped
}

export function pad(text: string, width: number): string {
  const clipped = text.length > width ? text.slice(0, width) : text
  return clipped + ' '.repeat(Math.max(0, width - clipped.length))
}

/**
 * Trim to the display width.
 *
 * 60 lowercase characters fit, 35 at the widest glyphs — both measured on
 * hardware. 44 is the working compromise: comfortable for ordinary mixed text,
 * and nothing here ever gets close to a line of solid capitals.
 */
export function clipToWidth(text: string): string {
  if (measure(text) <= USABLE_PX) return text
  let out = text
  while (out.length > 0 && measure(out) > USABLE_PX) out = out.slice(0, -1)
  return out
}

export function clip(text: string, width: number): string {
  return text.length > width ? text.slice(0, width) : text
}

/** "3m" / "2h" / "--" — short enough to sit at the end of a row. */
export function age(seconds: number | null): string {
  if (seconds === null) return '--'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

/** Values are shown as-is; long strings are clipped rather than wrapped. */
export function displayValue(metric: Metric): string {
  if (metric.value === null) return '--'
  const base = typeof metric.value === 'number' ? String(metric.value) : metric.value
  return clip(metric.unit ? `${base} ${metric.unit}` : base, 12)
}

/** 12-hour, e.g. "3:04p". */
export function clockFrom(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--'
  return clockShort(date.getTime())
}

/** One row on the board index: "> X HVAC        1 alert, 3 stale" */
export function boardRow(board: Board, selected: boolean): string {
  const cursor = selected ? '>' : ' '
  const name = pad(board.name, 12)
  return clip(`${cursor}${GLYPH[board.status]} ${name} ${board.summary}`, LINE_CHARS)
}

/** One row on a board detail page: "X AHU-1 SAT      70 F      2m" */
export function metricRow(metric: Metric): string {
  const label = pad(metric.label, 13)
  const value = pad(displayValue(metric), 11)
  return clip(`${GLYPH[metric.status]} ${label} ${value} ${age(metric.ageSeconds)}`, LINE_CHARS)
}

/**
 * Join lines and enforce both ceilings by dropping whole trailing rows.
 *
 * Truncating mid-row would leave a half-drawn metric that still looks like
 * data, and a row pushed past the bottom edge is invisible rather than
 * scrollable — so anything that does not fit is replaced by a visible marker.
 */
export function assemble(lines: string[], maxChars: number, maxLines: number): string {
  const kept: string[] = []
  let total = 0
  for (const line of lines) {
    const cost = line.length + 1
    if (total + cost > maxChars || kept.length >= maxLines) {
      kept.push('...')
      break
    }
    kept.push(line)
    total += cost
  }
  return kept.join('\n')
}

/** "7:42a" — short enough to sit at the end of a checklist row. */
export function clockShort(ms: number | null): string {
  if (ms === null) return ''
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const h24 = date.getHours()
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h}:${String(date.getMinutes()).padStart(2, '0')}${h24 < 12 ? 'a' : 'p'}`
}

/** One row on the index for a checklist: "> [####----] AM Rounds  3/8" */
export function checklistRow(run: ChecklistRun, selected: boolean): string {
  const cursor = selected ? '>' : ' '
  return clip(
    `${cursor}${bar(run.done, run.total)} ${pad(run.name, 12)} ${run.done}/${run.total}`,
    LINE_CHARS,
  )
}

/** "28m" / "1h55" — compact enough to sit in a row with a label. */
export function mins(ms: number | null): string {
  if (ms === null) return '--'
  const total = Math.round(ms / 60000)
  if (total < 60) return `${total}m`
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}`
}

/** "31m" left, or "DUE" once a wait has come and gone. */
export function countdown(remainingSeconds: number | null): string {
  if (remainingSeconds === null) return ''
  if (remainingSeconds <= 0) return 'DUE'
  const m = Math.ceil(remainingSeconds / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

/**
 * One row inside a checklist.
 *
 * A running wait shows its countdown where a finished step shows its
 * timestamp — same column, so the eye lands in one place either way.
 */
export function checklistItemRow(item: ChecklistItem, selected: boolean): string {
  const cursor = selected ? '>' : ' '
  const box = item.done
    ? '[x]'
    : item.stepKind === 'wait'
      ? '(~)'
      : item.running
        ? '[>]'
        : '[ ]'

  let right = ''
  if (item.done) right = clockShort(item.at)
  else if (item.stepKind === 'wait' && item.endsAt !== null) right = countdown(item.remainingSeconds)
  else if (item.running) right = `${mins(item.elapsedMs)}...`
  else if (item.stepKind === 'wait' && item.waitMinutes) right = `~${item.waitMinutes}m`
  else if (item.estimateMinutes) right = `~${item.estimateMinutes}m`

  return clip(`${cursor}${box} ${pad(item.label, 24)} ${right}`, LINE_CHARS)
}

/** "0:47" — offset from the start of a planned block. */
export function offset(ms: number): string {
  const m = Math.round(ms / 60000)
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

/**
 * One row of the running order.
 *
 * The left column is when the row starts, and it is the column that does the
 * work: you read down until the clock passes the time you have, and stop. No
 * window to pick, no plan truncated to a guess about your afternoon.
 */
/**
 * One row of the running order.
 *
 * Duration is the FIRST column, because "how long does this take" is the
 * decision being made. The start offset used to be here, which meant working
 * out 0:07 minus 0:00 to answer a question the screen should just answer —
 * and it framed everything as "if you start right now", which is not the
 * point. The point is that most of these are shorter than they feel.
 */
/**
 * One row of the running order.
 *
 * Two time columns, both earning their space:
 *   how long this takes  — the "is it worth starting" number
 *   running total        — the "what fits in the half hour I have" number
 *
 * Scan the second column until it passes the time you have, and everything
 * above the line is what you can get done. That was the original point of the
 * screen and it went missing when the offsets came out.
 *
 * An item with no estimate shows "--" in both. It is listed rather than
 * scheduled, because guessing its length would corrupt the running total —
 * but hiding it means the awkward jobs quietly disappear.
 */
/**
 * Column positions for the running order, in pixels.
 *
 * Pixels, not characters, because the firmware font is proportional: `11m` is
 * narrower than `47m`, so a column padded to the same character count lands in
 * a different place on every row. Checked on the laptop with tools/ruler.mjs
 * against metrics.ts, which is the only way to see this without packing a
 * build and squinting at it.
 */
export const COL = {
  dur: 62,
  wall: 134,
  marker: 144,
  label: 178,
  right: 420,
  taskLabel: 30,
  taskWhen: 360,
}

export function agendaRow(row: AgendaRow): string {
  const dur = row.ms === null ? '--' : mins(row.ms)
  const work = row.cumulativeBusyMs == null ? '--' : mins(row.cumulativeBusyMs)
  const wall = row.cumulativeWallMs == null ? '--' : mins(row.cumulativeWallMs)

  const marker = row.kind === 'gap' ? ' ~ ' : row.open ? '[>]' : '( )'
  const label =
    row.kind === 'gap'
      ? `open${row.nextFree ? ` ${clip(row.nextFree.chore, 14)}` : ''}`
      : row.step

  return clipToWidth(
    layout([
      { text: dur, end: COL.dur },
      { text: wall, end: COL.wall },
      { text: marker, at: COL.marker },
      { text: label, at: COL.label },
      { text: work, end: COL.right },
    ]),
  )
}

/**
 * Break a long note over as many lines as it needs.
 *
 * Wrapping on words, not characters: a note is prose, and a note cut mid-word
 * reads as corrupted text rather than as a sentence continuing. A single word
 * longer than the line is cut, because the alternative is an empty line.
 */
export function wrap(text: string, width = LINE_CHARS): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []

  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line === '') line = word.length > width ? word.slice(0, width) : word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      lines.push(line)
      line = word.length > width ? word.slice(0, width) : word
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * One big-ticket task.
 *
 * Deliberately not shaped like an agenda row. These are a different kind of
 * thing — an hour of tyre-fitting is not an item you slot between the
 * dishwasher and the laundry — and a row that looks like the list below
 * invites you to read it like the list below. No running total, label first,
 * estimate to the right where it informs rather than decides.
 *
 * A shut task still sits here in its normal place and says when it opens.
 * Sorting it downward would demote the row that most needs to stay in view
 * for exactly the hours you are most likely to be looking at the screen.
 */
export function taskRow(row: TaskRow, armed = false): string {
  const marker = armed ? '?' : '!'
  const est = row.ms === null ? '' : mins(row.ms)
  const when = armed ? 'done?' : (row.opensLabel ?? '')

  // The estimate finishes in the same column as the work totals below it, so
  // every time on the page ends on one vertical line.
  return clipToWidth(
    layout([
      { text: marker, at: 8 },
      { text: row.label, at: COL.taskLabel },
      { text: when, end: COL.taskWhen },
      { text: est, end: COL.right },
    ]),
  )
}

/** One row on the "what fits" screen: "> Laundry      28m / 1h55  n=9" */
export function fitsRow(stat: ChecklistStats, selected: boolean): string {
  const trust = stat.trusted ? `n=${stat.samples}` : 'est'
  return clip(
    `${selected ? '>' : ' '} ${pad(stat.name, 14)} ${pad(mins(stat.activeMs), 5)} ${pad(mins(stat.wallMs), 6)} ${trust}`,
    LINE_CHARS,
  )
}

/** One row on the index for a shared list: "> *  Groceries        3" */
export function inboxGroupRow(group: InboxGroup, selected: boolean): string {
  return clip(
    `${selected ? '>' : ' '}*   ${pad(group.name, 14)} ${group.items.length}`,
    LINE_CHARS,
  )
}

/**
 * One item on the shared list.
 *
 * `parts` is what triage split the line into; when it has split something, the
 * parts are what you actually shop for. The original text stays available but
 * the useful row is the part.
 */
export function inboxItemRow(item: InboxItem, selected: boolean, partIndex = 0): string {
  const label = item.parts?.[partIndex] ?? item.text
  return clip(`${selected ? '>' : ' '}[ ] ${pad(label, 26)} ${clip(item.by, 8)}`, LINE_CHARS)
}
