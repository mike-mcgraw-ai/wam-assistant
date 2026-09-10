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
 */

import { readFileSync } from 'node:fs'

const MAX_COLS = 44
const SAFE_COLS = 40
const MAX_LINES = 11
const MAX_CHARS = 900

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

const lines = unframe(raw)
const problems = []
const warnings = []

if (lines.length > MAX_LINES) {
  problems.push(`${lines.length} lines — max ${MAX_LINES}. Rows past ${MAX_LINES} are not on the glasses at all.`)
}

lines.forEach((line, i) => {
  const n = i + 1
  if (line.length > MAX_COLS) {
    problems.push(`line ${n}: ${line.length} chars — over ${MAX_COLS}, will wrap and cost a row`)
  } else if (line.length > SAFE_COLS) {
    warnings.push(`line ${n}: ${line.length} chars — over the ${SAFE_COLS} safe width; risky if the font is proportional`)
  }

  for (const ch of line) {
    const code = ch.codePointAt(0)
    if (code < 32 || code > 126) {
      problems.push(`line ${n}: non-ASCII ${JSON.stringify(ch)} (U+${code.toString(16).toUpperCase().padStart(4, '0')}) — dropped silently by the firmware`)
      break
    }
  }
})

const total = lines.join('\n').length
if (total > MAX_CHARS) problems.push(`${total} characters — max ${MAX_CHARS}`)

const hasCursor = lines.some(l => l.trimStart().startsWith('>') || l.startsWith('>'))
if (!hasCursor) warnings.push('no ">" cursor on any row — every scrollable screen needs one')

const footer = lines[lines.length - 1] ?? ''
if (!/click|dbl|scroll/i.test(footer)) {
  warnings.push('last line does not name the gestures — the footer is the only hint the user gets')
}

console.log(`${lines.length} lines, ${total} chars, widest ${Math.max(0, ...lines.map(l => l.length))}`)
for (const w of warnings) console.log(`  warn  ${w}`)
for (const p of problems) console.log(`  FAIL  ${p}`)
console.log(problems.length === 0 ? '\nOK — fits the glasses.' : `\n${problems.length} problem(s).`)
process.exit(problems.length ? 1 : 0)
