/**
 * Big clock, drawn as pixels.
 *
 * The firmware has one fixed font with no size control, so the only way to get
 * large type is to draw it and send it as an image. 4-bit greyscale, max
 * 288x144, and it cannot be sent with createStartUpPageContainer — a
 * placeholder is created first and filled in afterwards.
 *
 * ENCODING IS UNVERIFIED. The docs say "4-bit greyscale" but not how the bytes
 * are laid out, and the SDK has a dedicated `imageToGray4Failed` result, which
 * suggests the host may convert for us. So rather than guess once and get a
 * blank rectangle with no explanation, this tries each plausible encoding in
 * turn and remembers whichever the firmware accepts.
 */

/**
 * Clock band size.
 *
 * The display is 288px tall and fits 9 text rows, so a row is about 32px.
 * At 56 the band cost exactly two rows; 44 costs closer to one and a half
 * while still leaving the time far larger than any text could be.
 *
 * 288 is the widest an image container may be, and the canvas is 576 — so the
 * right half of this band is free. The space label lives there rather than
 * spending a text row on it.
 */
export const CLOCK_W = 288
export const CLOCK_H = 44

export type Encoding = 'gray8' | 'gray4' | 'pngBase64'

/** Order matters: cheapest and most likely first. */
export const ENCODINGS: Encoding[] = ['gray8', 'gray4', 'pngBase64']

const REMEMBERED_KEY = 'opsboard.imageEncoding'

export function rememberedEncoding(): Encoding | null {
  try {
    const v = localStorage.getItem(REMEMBERED_KEY)
    return ENCODINGS.includes(v as Encoding) ? (v as Encoding) : null
  } catch {
    return null
  }
}

export function rememberEncoding(encoding: Encoding): void {
  try {
    localStorage.setItem(REMEMBERED_KEY, encoding)
  } catch {
    // Not remembering just means re-probing next launch.
  }
}

/** "3:17" and "pm" — drawn separately so the meridiem can be smaller. */
export function clockParts(now = new Date()): { time: string; meridiem: string } {
  const h24 = now.getHours()
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return {
    time: `${h}:${String(now.getMinutes()).padStart(2, '0')}`,
    meridiem: h24 < 12 ? 'am' : 'pm',
  }
}

/**
 * A 5x7 pixel font, drawn as blocks.
 *
 * Canvas text antialiases, and on a 16-level greyscale display those soft
 * edges turn to mush — which is exactly the blur. Drawing from a bitmap at an
 * integer scale means every pixel is fully on or fully off, so the result is
 * hard-edged and blocky at any size. It is also how the device's own clock
 * faces are built.
 */
const FONT: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  m: ['00000', '00000', '11010', '10101', '10101', '10001', '10001'],
  p: ['00000', '00000', '11110', '10001', '11110', '10000', '10000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  // Uppercase only: month and weekday abbreviations read fine in caps, and it
  // halves the glyph data over carrying a mixed-case set.
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
}

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEPT','OCT','NOV','DEC']
const DAYS = ['SUN','MON','TUES','WED','THUR','FRI','SAT']

const GLYPH_W = 5
const GLYPH_H = 7

function glyphWidth(text: string, scale: number, gap: number): number {
  return text.length * (GLYPH_W * scale + gap) - gap
}

/** Paint one glyph as solid blocks. No antialiasing anywhere. */
function blit(
  ctx: CanvasRenderingContext2D,
  ch: string,
  x: number,
  y: number,
  scale: number,
): void {
  const rows = FONT[ch]
  if (!rows) return
  for (let r = 0; r < GLYPH_H; r += 1) {
    for (let c = 0; c < GLYPH_W; c += 1) {
      if (rows[r][c] === '1') {
        ctx.fillRect(x + c * scale, y + r * scale, scale, scale)
      }
    }
  }
}

function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  scale: number,
  gap: number,
): void {
  let cx = x
  for (const ch of text) {
    blit(ctx, ch, cx, y, scale)
    cx += GLYPH_W * scale + gap
  }
}

/** "SEPT - 9/9/26 - TUES" */
export function dateDigits(now = new Date()): string {
  const month = MONTHS[now.getMonth()]
  const day = DAYS[now.getDay()]
  const numeric = `${now.getMonth() + 1}/${now.getDate()}/${String(now.getFullYear()).slice(-2)}`
  return `${month} - ${numeric} - ${day}`
}

/**
 * Draw the clock.
 *
 * Date and time live together here rather than the date sitting in the text
 * header: this is the thing being glanced at, and splitting it across two
 * rendering systems put half of it in a different place and a different size.
 *
 * The meridiem is a bare "a" or "p" with no space — dropping the "m" buys the
 * width the date needs, and nobody has ever misread 11:26p.
 */
function drawClock(now = new Date(), spaceLabel = ''): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = CLOCK_W
  canvas.height = CLOCK_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')

  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, CLOCK_W, CLOCK_H)
  ctx.fillStyle = '#fff'

  const { time, meridiem } = clockParts(now)
  const stamp = `${time}${meridiem[0]}`
  const date = dateDigits(now)

  const smallScale = 2
  const smallGap = 2
  const dateH = GLYPH_H * smallScale
  const gapBetween = 4

  // Whatever height is left after the date row goes to the time.
  const bigScale = Math.max(1, Math.floor((CLOCK_H - dateH - gapBetween) / GLYPH_H))
  const bigGap = Math.max(1, Math.round(bigScale / 5))

  const dateW = glyphWidth(date, smallScale, smallGap)
  const stampW = glyphWidth(stamp, bigScale, bigGap)

  // Both rows flush left, matching the text rows below. Centring the image
  // inside a 288-wide container that is itself half the canvas left a large
  // empty margin on the left of everything.
  drawText(ctx, date, 0, 0, smallScale, smallGap)
  drawText(ctx, stamp, 0, dateH + gapBetween, bigScale, bigGap)

  // Which space you are in, tucked beside the time. Costs no text row, and it
  // is the only thing telling Ops from Life now that the titles are gone.
  if (spaceLabel) {
    const label = spaceLabel.toUpperCase()
    drawText(
      ctx,
      label,
      Math.min(CLOCK_W - glyphWidth(label, smallScale, smallGap), stampW + bigScale * 3),
      dateH + gapBetween + (GLYPH_H * bigScale - GLYPH_H * smallScale),
      smallScale,
      smallGap,
    )
  }
  void dateW

  return ctx.getImageData(0, 0, CLOCK_W, CLOCK_H)
}

/** Luminance 0-255 per pixel, one byte each. */
function toGray8(image: ImageData): number[] {
  const out: number[] = new Array(image.width * image.height)
  for (let i = 0, p = 0; i < image.data.length; i += 4, p += 1) {
    const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]]
    out[p] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  }
  return out
}

/** Two pixels per byte, 4 bits each, high nibble first. */
function toGray4(image: ImageData): number[] {
  const gray = toGray8(image)
  const out: number[] = []
  for (let i = 0; i < gray.length; i += 2) {
    const hi = (gray[i] >> 4) & 0x0f
    const lo = ((gray[i + 1] ?? 0) >> 4) & 0x0f
    out.push((hi << 4) | lo)
  }
  return out
}

function toPngBase64(image: ImageData): string {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext('2d')?.putImageData(image, 0, 0)
  // Data-URL prefix stripped: the host wants bytes, not a URL.
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}

export function encodeClock(
  encoding: Encoding,
  now = new Date(),
  spaceLabel = '',
): number[] | string {
  const image = drawClock(now, spaceLabel)
  if (encoding === 'gray8') return toGray8(image)
  if (encoding === 'gray4') return toGray4(image)
  return toPngBase64(image)
}
