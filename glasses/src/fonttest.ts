/**
 * Font alignment test card.
 *
 * ASCII art, the Pong field and the progress bars all assume characters are
 * the same width. The docs say the glasses ship a single LVGL font with no
 * monospace option, and LVGL's stock faces (Montserrat) are proportional — so
 * that assumption may not hold, and nothing in the SDK exposes font metrics to
 * check it from code.
 *
 * This is the cheapest possible way to find out. Every line below is exactly
 * 40 characters. On a monospace font all the right edges form a straight
 * vertical line and the rulers stack perfectly. On a proportional font the
 * `iiii` line will be visibly shorter than the `MMMM` line, and everything
 * built on a character grid needs to move to image containers instead.
 */

const WIDTH = 40

/** Every string here must be exactly WIDTH characters. */
const CARD = [
  '0123456789012345678901234567890123456789',
  '|---+----|---+----|---+----|---+----|--|',
  'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM',
  'iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii',
  'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
  '........................................',
  '[####----][####----][####----][##------]',
]

/**
 * Verified at module load rather than trusted: a card whose lines are not
 * actually equal length would fail the test for the wrong reason.
 */
export function cardIsWellFormed(): boolean {
  return CARD.every(line => line.length === WIDTH)
}

/**
 * Width ruler, in realistic text.
 *
 * The first attempt used dots and pipes and never reached the edge of the
 * screen, which measured nothing. This uses ordinary lowercase — what the app
 * is actually made of — so the number that fits is the number worth knowing.
 *
 * Every line ends with its own character count. Read down until a line stops
 * showing its number or wraps onto a second row.
 */
const WIDTHS = [36, 44, 52, 60, 68, 76]
const FILLER = 'the quick brown fox jumps over the lazy dog and then keeps going a while longer still '

function widthRuler(): string[] {
  return WIDTHS.map(n => {
    let line = ''
    while (line.length < n) line += FILLER
    const label = ` ${n}`
    return line.slice(0, n - label.length) + label
  })
}

/**
 * Widest-glyph ruler.
 *
 * M and W are the widest characters in the font, so this is the floor: the
 * number here holds for any content at all, including all-caps.
 */
const CAP_WIDTHS = [25, 30, 35, 40]

function capRuler(): string[] {
  return CAP_WIDTHS.map(n => {
    const label = String(n)
    return 'MW'.repeat(n).slice(0, n - label.length) + label
  })
}

/**
 * Line ruler. Numbered rows past any plausible limit; the highest number you
 * can actually see is the maximum. Deliberately not passed through the app's
 * line cap — the firmware is the thing being measured, not our guess at it.
 */
function lineRuler(): string[] {
  return Array.from({ length: 20 }, (_, i) => {
    const n = i + 1
    return `L${String(n).padStart(2, '0')} ${'-'.repeat(4)} line ${n}`
  })
}

export function renderFontTest(page: number): string {
  if (page === 0) {
    return [
      `FONT TEST  all lines ${WIDTH} chars`,
      '',
      ...CARD,
      '',
      'edges align = monospace   click: next',
    ].join('\n')
  }

  if (page === 2) {
    return ['TEXT WIDTH  last full number wins', ...widthRuler()].join('\n')
  }

  if (page === 4) {
    return ['CAPS WIDTH  the floor, any content', ...capRuler()].join('\n')
  }

  if (page === 3) {
    return ['LINES  highest number you see wins', ...lineRuler()].join('\n')
  }

  // Card 2: the glyphs the rest of the app depends on. Anything missing from
  // the firmware font is dropped silently, and a dropped status marker reads
  // as "fine" — the most expensive possible failure here.
  return [
    'GLYPH TEST  every char must appear',
    '',
    'status   . ! X ?',
    'boxes    [ ] [x] [>] (~) ( )',
    'bars     [########] [####----] [--------]',
    'art      .-----. ( ) \'-----\' | + = ~ :',
    'digits   0123456789  /  0:00  1h55  n=3',
    '',
    'anything blank is missing',
  ].join('\n')
}
