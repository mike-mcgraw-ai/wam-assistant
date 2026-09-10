/**
 * Check a screen's layout against the font metrics, on a laptop.
 *
 * Prints each line with its pixel width and flags anything that would wrap, and
 * shows where the right edge of each column actually lands — which is the thing
 * a monospace terminal lies about.
 *
 * Usage:  node tools/ruler.mjs            checks the current running order
 *         node tools/ruler.mjs "text"     measures one line
 */
import { execFileSync } from 'node:child_process'

const script = `
import { measure, offsets, DISPLAY_PX, WIDTHS_MEASURED } from './src/metrics'
import { agendaRow, taskRow } from './src/format'
import { readFileSync } from 'node:fs'

const arg = process.argv.slice(2).join(' ')
const show = (label, text) => {
  const w = measure(text)
  const flag = w > DISPLAY_PX ? '  WRAPS' : ''
  console.log(String(Math.round(w)).padStart(4) + 'px  ' + JSON.stringify(text) + flag)
}

if (!WIDTHS_MEASURED) console.log('NOTE: widths are estimates until the calibration screen is read.\\n')

if (arg) { show('', arg); process.exit(0) }

const plan = JSON.parse(readFileSync('/tmp/plan.json', 'utf8'))
for (const t of plan.tasks) show('', ' ' + taskRow(t))
console.log('')
for (const r of plan.agenda) show('', ' ' + agendaRow(r))

// Where does each row's last column finish? Equal numbers mean a real column.
console.log('\\nright edge of the final column:')
for (const r of plan.agenda) {
  const line = ' ' + agendaRow(r)
  console.log('  ' + Math.round(measure(line.replace(/\\s+$/, ''))) + 'px   ' + line.trim().slice(0, 28))
}
`
execFileSync('npx', ['tsx', '-e', script, '--', ...process.argv.slice(2)], { stdio: 'inherit' })
