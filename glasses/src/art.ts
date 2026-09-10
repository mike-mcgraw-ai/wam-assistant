/**
 * ASCII art, sized for a 44-column monochrome canvas.
 *
 * Strictly plain ASCII. The firmware drops glyphs outside its font set without
 * complaint, and half a dropped picture looks like a bug rather than a
 * decision. Every character used here is in the 32-126 range.
 */

/** Shown on the index when nothing needs you — earned, not decorative. */
export const ALL_CLEAR = [
  '        .-------------------.',
  '       (      ALL CLEAR      )',
  "        '-------------------'",
  '',
  '     no alerts, nothing stale,',
  '        every list finished',
].join('\n')

/** Title card for the game. */
export const PONG_TITLE = [
  '  ___   ___   _  _   ___ ',
  ' | _ \\ / _ \\ | \\| | / __|',
  ' |  _/| (_) || .` || (_ |',
  ' |_|   \\___/ |_|\\_| \\___|',
].join('\n')
