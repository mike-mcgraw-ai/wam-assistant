/**
 * The whole 576x288 panel as four 288x144 image tiles.
 *
 * Every screen except Listen is drawn exactly as before: the compact text
 * frame from compactdisplay.ts, placed where its two centred bands used to
 * sit. Listen draws its own four-block board (listenboard.ts). Either way the
 * result is one 576x288 greyscale frame, cut into tiles; main.ts only sends
 * the tiles whose pixels changed.
 */
import {
  COMPACT_PANEL_H,
  COMPACT_W,
  COMPACT_X,
  COMPACT_Y,
  EDGE_THRESHOLD,
  FONT_PX,
  INK,
  LETTER_TRACK_PX,
  LINE_PX,
  SPACE_TRACK_PX,
  renderCompactDisplay,
} from './compactdisplay'
import type { ListenBoard } from './listenboard'

export const PANEL_W = 576
export const PANEL_H = 288
export const TILE_W = 288
export const TILE_H = 144
/** Top-left, top-right, bottom-left, bottom-right. */
export const TILES = [
  { x: 0, y: 0 },
  { x: TILE_W, y: 0 },
  { x: 0, y: TILE_H },
  { x: TILE_W, y: TILE_H },
] as const

export interface DashboardRail {
  time: string
  weekday: string
  date: string
  connection: string
  status: string
  version: string
  timers: Array<{ label: string; value: string }>
}

const PAD_PX = 6
const COLUMN_W = TILE_W - PAD_PX * 2
const DIVIDER_INK = 70
/** Block titles: a small dim label band at the top of each tile. */
const TITLE_FONT_PX = 9
const TITLE_BASELINE_PX = 10
const TITLE_BAND_PX = 14
const TITLE_INK = 110
/** Placeholder text ("Nothing to add yet") is drawn dim too. */
const PENDING_INK = 110
/** Content rows under the title band: 14 + 7 x 18 = 140 of 144. */
const BLOCK_ROWS = 7
const FIRST_BASELINE_PX = TITLE_BAND_PX + 12
/** Fixed two-column timer grid, relative to the bottom-right tile. */
const TIMER_VALUE_X = 154
const TIMER_COLUMN_GAP_PX = 14

function blit(target: number[], source: number[], width: number, height: number, x0: number, y0: number): void {
  for (let y = 0; y < height; y += 1) {
    const from = y * width
    const to = (y0 + y) * PANEL_W + x0
    for (let x = 0; x < width; x += 1) target[to + x] = source[from + x]
  }
}

/** Any ordinary WAM text frame, in the place the two compact bands used to be. */
export function textFrame(content: string): number[] {
  const frame = new Array<number>(PANEL_W * PANEL_H).fill(0)
  const [top, bottom] = renderCompactDisplay(content)
  blit(frame, top, COMPACT_W, COMPACT_PANEL_H, COMPACT_X, COMPACT_Y)
  blit(frame, bottom, COMPACT_W, COMPACT_PANEL_H, COMPACT_X, COMPACT_Y + COMPACT_PANEL_H)
  return frame
}

/**
 * Normal WAM screens use the old compact two-band display on the left and an
 * independently changing dashboard rail on the right. A list scroll therefore
 * changes only the left tiles; the clock changes only the top-right tile.
 */
export function dashboardFrame(content: string, rail: DashboardRail): number[] {
  const canvas = document.createElement('canvas')
  canvas.width = PANEL_W
  canvas.height = PANEL_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('dashboard panel has no 2d canvas')
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, PANEL_W, PANEL_H)
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'alphabetic'
  const rightX = TILES[1].x + PAD_PX
  ctx.font = `18px sans-serif`
  drawLine(ctx, rail.time, rightX, 24, COLUMN_W)
  ctx.font = CONTENT_FONT
  drawLine(ctx, rail.weekday, rightX, 48, COLUMN_W)
  drawLine(ctx, rail.date, rightX, 66, COLUMN_W)
  // No screen name here: it changed on every navigation, which dragged this
  // tile into every repaint and turned a two-tile left-side change into a
  // visible four-tile rollout. The left side already says where you are.
  drawLine(ctx, rail.connection, rightX, 91, COLUMN_W)
  drawLine(ctx, rail.status, rightX, 109, COLUMN_W)
  drawLine(ctx, rail.version, rightX, 127, COLUMN_W)

  const shownTimers = rail.timers.slice(0, BLOCK_ROWS)
  const timerNote = rail.timers.length > BLOCK_ROWS
    ? `${BLOCK_ROWS}/${rail.timers.length} active`
    : rail.timers.length ? `${rail.timers.length} active` : ''
  drawBlock(ctx, 3, 'TIMERS', timerNote, shownTimers.length > 0 ? [] : ['No timers running.'])
  if (shownTimers.length > 0) {
    const { x, y } = TILES[3]
    const labelX = x + PAD_PX
    const valueX = x + TIMER_VALUE_X
    const labelWidth = TIMER_VALUE_X - PAD_PX - TIMER_COLUMN_GAP_PX
    const valueWidth = TILE_W - TIMER_VALUE_X - PAD_PX
    ctx.font = CONTENT_FONT
    shownTimers.forEach((timer, index) => {
      const label = clipPx(ctx, timer.label, labelWidth)
      const value = clipPx(ctx, timer.value, valueWidth)
      const baseline = y + FIRST_BASELINE_PX + index * LINE_PX
      drawLine(ctx, label, labelX, baseline, labelWidth)
      drawLine(ctx, value, valueX, baseline, valueWidth)
    })
  }

  const rgba = ctx.getImageData(0, 0, PANEL_W, PANEL_H).data
  const frame = new Array<number>(PANEL_W * PANEL_H)
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 1) {
    frame[target] = rgba[source] >= EDGE_THRESHOLD ? INK : 0
  }
  // Give the clock a visual hierarchy without spending a row on a container
  // header: time is bright; date, context and build identity sit back.
  dim(frame, TILES[1].x, TILES[1].y + 28, TILE_W, 48, TITLE_INK)
  dim(frame, TILES[1].x, TILES[1].y + 112, TILE_W, 32, TITLE_INK)
  dim(frame, TILES[3].x, TILES[3].y, TILE_W, TITLE_BAND_PX, TITLE_INK)
  if (shownTimers.length === 0) {
    dim(frame, TILES[3].x, TILES[3].y + TITLE_BAND_PX, TILE_W, TILE_H - TITLE_BAND_PX, PENDING_INK)
  }

  // Preserve the exact compact rendering and vertical placement that was
  // proven readable on the glasses; only move it from centre to the left.
  const [top, bottom] = renderCompactDisplay(content)
  blit(frame, top, COMPACT_W, COMPACT_PANEL_H, 0, COMPACT_Y)
  blit(frame, bottom, COMPACT_W, COMPACT_PANEL_H, 0, COMPACT_Y + COMPACT_PANEL_H)
  return frame
}

export function splitTiles(frame: number[]): number[][] {
  return TILES.map(({ x, y }) => {
    const tile = new Array<number>(TILE_W * TILE_H)
    for (let row = 0; row < TILE_H; row += 1) {
      const from = (y + row) * PANEL_W + x
      for (let col = 0; col < TILE_W; col += 1) tile[row * TILE_W + col] = frame[from + col]
    }
    return tile
  })
}

/** FNV-1a over the pixels: enough to tell "this tile did not change". */
export function hashTile(tile: number[]): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < tile.length; index += 1) {
    hash ^= tile[index]
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// ---- text measured in the font that is actually drawn ------------------------

type Ctx = CanvasRenderingContext2D

const glyphWidths = new Map<string, number>()

function glyph(ctx: Ctx, ch: string): number {
  const key = `${ctx.font}|${ch}`
  let width = glyphWidths.get(key)
  if (width === undefined) {
    width = ctx.measureText(ch).width
    glyphWidths.set(key, width)
  }
  return width
}

function measure(ctx: Ctx, text: string): number {
  let width = 0
  for (let index = 0; index < text.length; index += 1) {
    width += glyph(ctx, text[index])
    if (index < text.length - 1) width += text[index] === ' ' ? SPACE_TRACK_PX : LETTER_TRACK_PX
  }
  return width
}

/** Same glyph placement as compactdisplay.ts: real widths plus tracking. */
function drawLine(ctx: Ctx, text: string, x0: number, baseline: number, maxWidth: number): void {
  const natural = [...text].reduce((total, ch) => total + glyph(ctx, ch), 0)
  const desired = measure(ctx, text) - natural
  const room = Math.max(0, maxWidth - natural)
  const scale = desired <= 0 ? 0 : Math.min(1, room / desired)
  let x = x0
  for (let index = 0; index < text.length; index += 1) {
    ctx.fillText(text[index], Math.round(x), baseline)
    const track = index === text.length - 1 ? 0 : text[index] === ' ' ? SPACE_TRACK_PX : LETTER_TRACK_PX
    x += glyph(ctx, text[index]) + track * scale
  }
}

/** Word wrap by drawn pixels. A word too long for a line is broken by letters. */
function wrapPx(ctx: Ctx, text: string, width: number, indent = ''): string[] {
  const lines: string[] = []
  let line = ''
  const push = () => {
    if (line) lines.push(line)
    line = ''
  }
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (!word) continue
    const candidate = line ? `${line} ${word}` : lines.length > 0 ? `${indent}${word}` : word
    if (measure(ctx, candidate) <= width) {
      line = candidate
      continue
    }
    push()
    let rest = lines.length > 0 ? `${indent}${word}` : word
    while (measure(ctx, rest) > width) {
      let cut = rest.length - 1
      while (cut > 1 && measure(ctx, rest.slice(0, cut)) > width) cut -= 1
      lines.push(rest.slice(0, cut))
      rest = `${indent}${rest.slice(cut)}`
    }
    line = rest
  }
  push()
  return lines
}

function clipPx(ctx: Ctx, text: string, width: number): string {
  if (measure(ctx, text) <= width) return text
  let cut = text.length
  while (cut > 0 && measure(ctx, `${text.slice(0, cut).trimEnd()}...`) > width) cut -= 1
  return `${text.slice(0, cut).trimEnd()}...`
}

// ---- the Listen board ----------------------------------------------------------

const CONTENT_FONT = `${FONT_PX}px sans-serif`
const TITLE_FONT = `${TITLE_FONT_PX}px sans-serif`

/** Rows for one block: wrap each paragraph, never more than `room`. */
function paragraphs(ctx: Ctx, items: string[], room: number, bullet: string, keepNewest: boolean): string[] {
  const wrapped = items.map(item => wrapPx(ctx, `${bullet}${item}`, COLUMN_W, bullet ? ' '.repeat(bullet.length) : ''))
  // Newest last: keep the newest rows, but do not throw away a whole older
  // point just because one of its rows crosses the limit. That left half of
  // Summary blank whenever one long point pushed the total barely over seven.
  if (keepNewest) {
    const rows = wrapped.flat()
    if (rows.length <= room) return rows
    const kept = rows.slice(-room)
    kept[0] = clipPx(ctx, `... ${kept[0].trimStart()}`, COLUMN_W)
    return kept
  }
  const rows = wrapped.flat()
  if (rows.length > room) {
    rows.length = room
    rows[room - 1] = clipPx(ctx, `${rows[room - 1]} ...`, COLUMN_W)
  }
  return rows
}

function drawBlock(
  ctx: Ctx,
  tile: number,
  title: string,
  note: string,
  rows: string[],
  firstRow = 0,
): void {
  const { x, y } = TILES[tile]
  ctx.font = TITLE_FONT
  const noteText = note ? clipPx(ctx, note, COLUMN_W - measure(ctx, title) - 12) : ''
  drawLine(ctx, title, x + PAD_PX, y + TITLE_BASELINE_PX, COLUMN_W)
  if (noteText) {
    drawLine(ctx, noteText, x + TILE_W - PAD_PX - measure(ctx, noteText), y + TITLE_BASELINE_PX, COLUMN_W)
  }
  ctx.font = CONTENT_FONT
  rows.slice(0, BLOCK_ROWS - firstRow).forEach((text, index) =>
    drawLine(ctx, text, x + PAD_PX, y + FIRST_BASELINE_PX + (firstRow + index) * LINE_PX, COLUMN_W),
  )
}

function dim(frame: number[], x: number, y: number, width: number, height: number, ink: number): void {
  for (let row = y; row < y + height; row += 1) {
    for (let col = x; col < x + width; col += 1) {
      const index = row * PANEL_W + col
      if (frame[index]) frame[index] = ink
    }
  }
}

export function listenFrame(board: ListenBoard): number[] {
  const canvas = document.createElement('canvas')
  canvas.width = PANEL_W
  canvas.height = PANEL_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('full panel has no 2d canvas')
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, PANEL_W, PANEL_H)
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'alphabetic'
  ctx.font = CONTENT_FONT

  // Top-left: topics, newest first. The current one may take two rows.
  const topicRows: string[] = []
  for (const topic of board.topics) {
    if (topicRows.length >= BLOCK_ROWS) break
    if (topic.current) {
      const wrapped = wrapPx(ctx, `> ${topic.text}`, COLUMN_W, '  ')
      if (wrapped.length > 2) wrapped[1] = clipPx(ctx, `${wrapped[1]} ${wrapped.slice(2).join(' ')}`, COLUMN_W)
      topicRows.push(...wrapped.slice(0, 2))
    } else {
      topicRows.push(clipPx(ctx, `  ${topic.text}`, COLUMN_W))
    }
  }
  const topicsPending = topicRows.length === 0
  if (topicsPending) topicRows.push('Topics appear as the talk moves.')
  drawBlock(ctx, 0, board.topicsBlock.title, board.topicsBlock.note, topicRows)

  // Top-right: the AI cue. The cue title, then its lines.
  ctx.font = CONTENT_FONT
  const cueRows = board.cuePending
    ? board.cue.flatMap(line => wrapPx(ctx, line, COLUMN_W))
    : paragraphs(ctx, board.cue, BLOCK_ROWS, '', false)
  drawBlock(ctx, 1, board.cueBlock.title, board.cueBlock.note, cueRows)

  // Bottom-left: the summary, footer on its last row.
  ctx.font = CONTENT_FONT
  const summaryRoom = BLOCK_ROWS - (board.footer ? 1 : 0)
  const summaryRows = board.summaryPending
    ? board.summary.flatMap(line => wrapPx(ctx, line, COLUMN_W)).slice(0, summaryRoom)
    : paragraphs(ctx, board.summary, summaryRoom, '- ', true)
  if (board.footer) summaryRows.push(clipPx(ctx, board.footer, COLUMN_W))
  drawBlock(ctx, 2, board.summaryBlock.title, board.summaryBlock.note, summaryRows)

  // Bottom-right: the clean transcript, newest row at the bottom.
  ctx.font = CONTENT_FONT
  const transcriptRows: string[] = []
  for (const block of board.transcript) {
    const prefix = block.speaker === 'me' ? '> ' : ''
    transcriptRows.push(...wrapPx(ctx, `${prefix}${block.text}`, COLUMN_W, block.speaker === 'me' ? '  ' : ''))
  }
  if (transcriptRows.length === 0 && board.emptyNote) transcriptRows.push(...wrapPx(ctx, board.emptyNote, COLUMN_W))
  const maxScroll = Math.max(0, transcriptRows.length - BLOCK_ROWS)
  const end = transcriptRows.length - Math.min(board.scrollBack, maxScroll)
  drawBlock(ctx, 3, board.transcriptBlock.title, board.transcriptBlock.note, transcriptRows.slice(Math.max(0, end - BLOCK_ROWS), end))

  // Threshold exactly as the compact path does.
  const rgba = ctx.getImageData(0, 0, PANEL_W, PANEL_H).data
  const frame = new Array<number>(PANEL_W * PANEL_H)
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 1) {
    frame[target] = rgba[source] >= EDGE_THRESHOLD ? INK : 0
  }

  // Titles dim, so content reads first. Placeholders dim too.
  for (const { x, y } of TILES) dim(frame, x, y, TILE_W, TITLE_BAND_PX, TITLE_INK)
  const body = (tile: number) => [TILES[tile].x, TILES[tile].y + TITLE_BAND_PX, TILE_W, TILE_H - TITLE_BAND_PX] as const
  if (topicsPending) dim(frame, ...body(0), PENDING_INK)
  if (board.cuePending) dim(frame, ...body(1), PENDING_INK)
  if (board.summaryPending) dim(frame, ...body(2), PENDING_INK)

  // Static dotted dividers: they never change, so they never cost a send.
  for (let y = 2; y < PANEL_H - 2; y += 3) frame[y * PANEL_W + TILE_W] = DIVIDER_INK
  for (let x = PAD_PX; x < PANEL_W - PAD_PX; x += 3) {
    if (x !== TILE_W) frame[TILE_H * PANEL_W + x] = DIVIDER_INK
  }
  return frame
}
