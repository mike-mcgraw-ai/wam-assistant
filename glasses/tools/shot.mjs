/**
 * Render a screen in the Even simulator and save the pixels.
 *
 * The whole loop on one machine: build the screen text, push it to the probe
 * page, screenshot the glasses display, look at it. No packing, no install, no
 * squinting at a pair of glasses to find out a column is 5px out.
 *
 * Usage: node tools/shot.mjs [out.png]
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const out = process.argv[2] ?? '/tmp/screen.png'

const text = execFileSync('npx', ['tsx', '-e', `
import { readFileSync } from 'node:fs'
import { agendaRow, taskRow } from './src/format'
const p = JSON.parse(readFileSync('/tmp/plan.json','utf8'))
const lines = ['Sep 9/9/26 WED  6:20p', '   LIFE']
p.tasks.forEach((t, i) => lines.push((i === 0 ? '>' : ' ') + taskRow(t)))
lines.push('')
p.agenda.slice(0, 5).forEach(r => lines.push(' ' + agendaRow(r)))
process.stdout.write(lines.join('\\n'))
`], { encoding: 'utf8' })

await fetch('http://127.0.0.1:8787/probe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text }),
})
await new Promise(r => setTimeout(r, 1200))
const png = await (await fetch('http://127.0.0.1:9898/api/screenshot/glasses')).arrayBuffer()
writeFileSync(out, Buffer.from(png))
console.log('saved', out)
