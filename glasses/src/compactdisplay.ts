/**
 * Compact HUD viewport.
 *
 * The native Even text container exposes no font-size control. Drawing the
 * existing text frame into images is the only supported way to make
 * every screen genuinely smaller without changing its navigation or content.
 * Two vertically stacked bands stay within the firmware's 288x144 image limit
 * while giving the letters enough vertical separation not to bloom together.
 */
export const COMPACT_W = 288
export const COMPACT_PANEL_H = 108
export const COMPACT_ROWS = 12
export const COMPACT_X = Math.floor((576 - COMPACT_W) / 2)
export const COMPACT_Y = Math.floor((288 - COMPACT_PANEL_H * 2) / 2)

export const FONT_PX = 11
export const LINE_PX = 18
const LEFT_PX = 5
const TOP_PX = 3
const PANEL_ROWS = COMPACT_ROWS / 2
export const LETTER_TRACK_PX = 1.4
export const SPACE_TRACK_PX = 1.1
export const INK = 180
export const EDGE_THRESHOLD = 88

/**
 * Render one WAM text frame as hard-edged greyscale bytes.
 *
 * Each glyph advances by the width of the glyph actually drawn, plus explicit
 * tracking. The first compact pass used scaled widths from a different font;
 * that let pairs such as UN, Cl, fl and 10 collide. Long rows give up only the
 * extra tracking needed to fit, never the final glyph. Thresholding removes
 * canvas antialiasing, which otherwise turns soft on the four-bit display.
 */
function renderPanel(lines: string[]): number[] {
  const canvas = document.createElement('canvas')
  canvas.width = COMPACT_W
  canvas.height = COMPACT_PANEL_H

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('compact display has no 2d canvas')

  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, COMPACT_W, COMPACT_PANEL_H)
  ctx.fillStyle = '#fff'
  ctx.font = `${FONT_PX}px sans-serif`
  ctx.textBaseline = 'alphabetic'

  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row]
    const widths = [...line].map(ch => ctx.measureText(ch).width)
    const tracking = [...line].map((ch, index) =>
      index === line.length - 1 ? 0 : ch === ' ' ? SPACE_TRACK_PX : LETTER_TRACK_PX,
    )
    const naturalWidth = widths.reduce((total, width) => total + width, 0)
    const desiredTracking = tracking.reduce<number>((total, width) => total + width, 0)
    const trackingRoom = Math.max(0, COMPACT_W - LEFT_PX * 2 - naturalWidth)
    const trackingScale = desiredTracking === 0 ? 0 : Math.min(1, trackingRoom / desiredTracking)

    let x = LEFT_PX
    const baseline = TOP_PX + FONT_PX + row * LINE_PX
    for (let index = 0; index < line.length; index += 1) {
      ctx.fillText(line[index], Math.round(x), baseline)
      x += widths[index] + tracking[index] * trackingScale
    }
  }

  const rgba = ctx.getImageData(0, 0, COMPACT_W, COMPACT_PANEL_H).data
  const gray = new Array<number>(COMPACT_W * COMPACT_PANEL_H)
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 1) {
    gray[target] = rgba[source] >= EDGE_THRESHOLD ? INK : 0
  }
  return gray
}

export function renderCompactDisplay(content: string): [number[], number[]] {
  const lines = content.split('\n').slice(0, COMPACT_ROWS)
  return [
    renderPanel(lines.slice(0, PANEL_ROWS)),
    renderPanel(lines.slice(PANEL_ROWS, COMPACT_ROWS)),
  ]
}
