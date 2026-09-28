#!/usr/bin/env node
/**
 * Validate a screen mockup against the G2's hard limits.
 *
 *   node tools/checkscreen.mjs my-screen.txt
 *   cat my-screen.txt | node tools/checkscreen.mjs
 *
 * Accepts either raw lines or a mockup wrapped in a +---+ / | ... | frame;
 * the frame is stripped before checking so a design can be pasted straight
 * out of a chat.
 *
 * The limits are read from the app, not typed in here — they were typed in
 * once, and went stale the day the display moved to twelve lines:
 *   config.maxLines, config.maxChars      src/config.ts
 *   measure(), USABLE_PX                  src/metrics.ts
 *   COMPACT_ROWS                          src/compactdisplay.ts
 *
 * What this cannot check: the width of a row as drawn in the compact bitmap.
 * That depends on the phone's font, and Node has no font renderer. The screens
 * page (`npm run screens`) draws every row with the real compact path and
 * flags any row that runs off the edge.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const limitsFile = join(here, '..', 'node_modules', '.cache', 'checkscreen-limits.mjs')
await build({
  stdin: {
    contents: [
      "export { config } from '../src/config'",
      "export { measure, USABLE_PX } from '../src/metrics'",
      "export { COMPACT_ROWS } from '../src/compactdisplay'",
    ].join('\n'),
    resolveDir: here,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: limitsFile,
  logLevel: 'error',
})
const { config, measure, USABLE_PX, COMPACT_ROWS } = await import(pathToFileURL(limitsFile).href)

const MAX_LINES = Math.min(config.maxLines, COMPACT_ROWS)
const MAX_CHARS = config.maxChars

const path = process.argv[2]
const raw = path ? readFileSync(path, 'utf8') : readFileSync(0, 'utf8')

/** Strip a +---+ / | ... | frame if the mockup is wrapped in one. */
function unframe(text) {
  const lines = text.split('\n')
  const framed = lines.filter(l => l.trim().startsWith('|') && l.trimEnd().endsWith('|'))
  if (framed.length < 2) return lines.filter(l => !/^\s*\+-+\+\s*$/.test(l))
  return framed.map(l => {
    const inner = l.trim().slice(1, -1)
    // The frame adds one space of padding each side.
    return inner.replace(/^ /, '').replace(/ $/, '').replace(/\s+$/, '')
  })
}

// A trailing newline is not a line on the glasses.
const lines = unframe(raw)
while (lines.length && lines[lines.length - 1] === '') lines.pop()
const problems = []
const warnings = []

if (lines.length > MAX_LINES) {
  problems.push(`${lines.length} lines — max ${MAX_LINES}. Rows past ${MAX_LINES} are not drawn at all.`)
}

lines.forEach((line, i) => {
  const n = i + 1
  const px = Math.round(measure(line))
  if (px > USABLE_PX) {
    warnings.push(
      `line ${n}: ${px}px in the firmware font — over ${USABLE_PX}px, so the native text fallback wraps it. ` +
        `Check the compact width on the screens page.`,
    )
  }

  for (const ch of line) {
    const code = ch.codePointAt(0)
    if (code < 32 || code > 126) {
      problems.push(
        `line ${n}: non-ASCII ${JSON.stringify(ch)} (U+${code.toString(16).toUpperCase().padStart(4, '0')}) — ` +
          `the native text fallback drops it silently`,
      )
      break
    }
  }
})

const total = lines.join('\n').length
if (total > MAX_CHARS) problems.push(`${total} characters — max ${MAX_CHARS}`)

const hasCursor = lines.some(l => l.trimStart().startsWith('>'))
if (!hasCursor) warnings.push('no ">" cursor on any row — every scrollable screen needs one')

const widest = Math.max(0, ...lines.map(l => Math.round(measure(l))))
console.log(`${lines.length}/${MAX_LINES} lines, ${total}/${MAX_CHARS} chars, widest ${widest}px of ${USABLE_PX}px (firmware font)`)
for (const w of warnings) console.log(`  warn  ${w}`)
for (const p of problems) console.log(`  FAIL  ${p}`)
console.log(problems.length === 0 ? '\nOK — within the hard limits.' : `\n${problems.length} problem(s).`)
process.exit(problems.length ? 1 : 0)
