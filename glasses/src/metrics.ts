/**
 * Font metrics for the G2 firmware font.
 *
 * The firmware font is proportional, so counting characters says nothing about
 * where a column lands: `1` is 7px and `4` is 12px, which is exactly why a
 * space-padded column of times came out ragged no matter how carefully the
 * characters were counted.
 *
 * These widths are MEASURED, not estimated. tools/measure_font.py renders each
 * character once and then twenty-one times in the Even simulator, reads the
 * rightmost lit pixel off the screenshot, and divides the difference by twenty
 * — the side bearings cancel, so what comes out is the true advance width.
 * Re-run it whenever the firmware font changes; see tools/README-font.md.
 */
import FONT from './font.json'

/** The simulator's canvas, and the panel's, is 576px wide. */
export const DISPLAY_PX = 576

/**
 * How much of that a line may actually use.
 *
 * Deliberately below 576. The measurements come from the simulator, and the
 * one hardware check we have disagrees with it on absolute size — a line of 35
 * `m` wrapped on real glasses where these widths predict it fitting. Relative
 * widths are what alignment depends on and those transfer, but the total line
 * budget does not, so it is set from the hardware observation (30 `m` across)
 * rather than from the simulator. Raise it only against a real measurement.
 */
export const USABLE_PX = 480

export const WIDTH: Record<string, number> = FONT as Record<string, number>

/** Unlisted characters get the width of a lowercase `n`. */
export const DEFAULT_WIDTH = WIDTH['n'] ?? 11

export function charWidth(ch: string): number {
  return WIDTH[ch] ?? DEFAULT_WIDTH
}

export function measure(text: string): number {
  let total = 0
  for (const ch of text) total += charWidth(ch)
  return total
}

export function fits(text: string): boolean {
  return measure(text) <= USABLE_PX
}

/**
 * Pad with spaces until the line is at least `targetPx` wide.
 *
 * A space is 5px, the narrowest thing in the font, so the residual error is
 * under 5px — about half a digit. Good enough that a column of times reads as
 * a column.
 */
export function padToPx(text: string, targetPx: number): { text: string; errorPx: number } {
  const space = charWidth(' ')
  let width = measure(text)
  let out = text
  while (width + space <= targetPx) {
    out += ' '
    width += space
  }
  return { text: out, errorPx: targetPx - width }
}

export interface Cell {
  text: string
  /** left edge, in pixels */
  at?: number
  /** right edge, in pixels — wins over `at`, and is what a column of times wants */
  end?: number
}

/**
 * Lay cells out at fixed pixel offsets across one line.
 *
 * A cell that would overrun its neighbour starts late rather than being cut,
 * so a long label pushes the rest of the row along instead of vanishing.
 */
export function layout(cells: Cell[]): string {
  let line = ''
  for (const cell of cells) {
    const target = cell.end === undefined ? (cell.at ?? 0) : cell.end - measure(cell.text)
    if (target > measure(line)) line = padToPx(line, target).text
    line += cell.text
  }
  return line
}

/** Where each character starts, for checking a layout on a laptop. */
export function offsets(text: string): number[] {
  const out: number[] = []
  let x = 0
  for (const ch of text) {
    out.push(x)
    x += charWidth(ch)
  }
  return out
}
