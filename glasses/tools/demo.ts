/**
 * `npm run demo` — every screen as ASCII, in milliseconds, no build, no device.
 *
 * The state lives in demo-screens.ts so the screens page (screens.html) shows
 * exactly these frames as pixels. Add a new screen there, not here.
 */
import { demoScreens } from './demo-screens'
import { LINE_CHARS } from '../src/format'
import { cardIsWellFormed } from '../src/fonttest'

const frame = (title: string, body: string) => {
  const lines = body.split('\n')
  const bar = '-'.repeat(LINE_CHARS + 2)
  console.log(`\n### ${title}`)
  console.log(`+${bar}+`)
  for (const line of lines) console.log(`| ${line.padEnd(LINE_CHARS)} |`)
  console.log(`+${bar}+`)
  console.log(`${body.length} chars / ${lines.length} lines`)
}

for (const screen of demoScreens()) frame(screen.title, screen.text)

console.log('\nfont test card lines all equal length:', cardIsWellFormed())
