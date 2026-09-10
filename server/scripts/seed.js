/**
 * Pushes plausible values at the running server so you have something to look
 * at before any real system is wired up.
 *
 *   node scripts/seed.js                 # one round of values
 *   node scripts/seed.js --loop          # keep updating every 10s
 *   node scripts/seed.js --loop --chaos  # ...and let some metrics go bad/stale
 *
 * `--chaos` deliberately stops updating two metrics so you can watch them age
 * into `stale` on the glasses. That is the behaviour worth trusting before you
 * rely on this for anything real.
 */

const BASE = process.env.BASE || 'http://localhost:8787'
const TOKEN = process.env.INGEST_TOKEN || 'change-me-to-a-long-random-string'
const loop = process.argv.includes('--loop')
const chaos = process.argv.includes('--chaos')

const jitter = (base, spread) => +(base + (Math.random() - 0.5) * spread).toFixed(1)

function sample(tick) {
  const bad = chaos && tick > 2
  const metrics = [
    { id: 'ahu1.sat', value: bad ? jitter(70, 2) : jitter(56, 3) },
    { id: 'ahu1.static', value: jitter(1.3, 0.3) },
    { id: 'chw.supply', value: jitter(44, 2) },
    { id: 'zones.hot', value: bad ? 7 : Math.floor(Math.random() * 3) },
    { id: 'main.kw', value: jitter(780, 120) },
    { id: 'gen.status', value: 'READY' },
    { id: 'ups.load', value: jitter(58, 12) },
    { id: 'fp.pressure', value: jitter(102, 8) },
    { id: 'elev.down', value: 0 },
    { id: 'wo.open', value: 40 + Math.floor(Math.random() * 12) },
    { id: 'wo.urgent', value: Math.floor(Math.random() * 4) },
    { id: 'wo.overdue', value: 3 + Math.floor(Math.random() * 6) },
  ]

  // Under chaos, fa.panel simply stops being reported — it should go `?`.
  if (!bad) metrics.push({ id: 'fa.panel', value: 'NORMAL' })

  return metrics
}

async function push(tick) {
  const res = await fetch(`${BASE}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ source: 'seed', metrics: sample(tick) }),
  })
  const body = await res.json()
  if (!res.ok) {
    console.error(`[seed] ${res.status}`, body)
    return
  }
  console.log(`[seed] tick ${tick}: wrote ${body.written.length}` +
    (body.rejected.length ? `, rejected ${body.rejected.length}` : '') +
    (chaos && tick > 2 ? ' (chaos on: fa.panel going stale)' : ''))
}

let tick = 0
await push(++tick)
if (loop) setInterval(() => push(++tick), 10_000)
