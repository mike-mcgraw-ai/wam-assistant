import http from 'node:http'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { Store } from './state.js'
import { Checklists } from './checklists.js'
import { agenda, planBlock, reach } from './plan.js'
import { Inbox } from './inbox.js'
import { Tasks } from './tasks.js'
import { Triage, sweepInbox } from './triage.js'
import { Jobs, JOB } from './jobs.js'
import { Notifier, sweepWaits } from './notify.js'
import { applyMessage, verifySignature, startSocketMode } from './slack.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0'
const INGEST_TOKEN = process.env.INGEST_TOKEN || ''
const READ_TOKEN = process.env.READ_TOKEN || ''
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || ''
const PERSIST = process.env.PERSIST_PATH || join(HERE, '..', 'data', 'values.json')
const CONFIG_PATH = process.env.CONFIG_PATH || join(HERE, 'boards.config.json')

const CHECKLISTS_PATH = process.env.CHECKLISTS_PATH || join(HERE, 'checklists.config.json')
const DATA_DIR = process.env.DATA_DIR || join(HERE, '..', 'data')

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
const store = new Store(config, PERSIST)

const checklistConfig = JSON.parse(readFileSync(CHECKLISTS_PATH, 'utf8'))
const checklists = new Checklists(checklistConfig, {
  runsPath: join(DATA_DIR, 'runs.json'),
  logPath: join(DATA_DIR, 'checks.jsonl'),
  summaryPath: join(DATA_DIR, 'summaries'),
})

const notifier = new Notifier()

const inbox = new Inbox({
  storePath: join(DATA_DIR, 'inbox.json'),
  logPath: join(DATA_DIR, 'inbox.jsonl'),
})
const triage = new Triage()

let probeText = ''

const tasks = new Tasks(
  JSON.parse(readFileSync(process.env.TASKS_PATH || join(HERE, 'tasks.config.json'), 'utf8')),
  { storePath: join(DATA_DIR, 'tasks.json'), logPath: join(DATA_DIR, 'tasks.jsonl') },
)

const jobs = new Jobs({
  storePath: join(DATA_DIR, 'jobs.json'),
  logPath: join(DATA_DIR, 'jobs.jsonl'),
})

const AGENT_TOKEN = process.env.AGENT_TOKEN || ''
if (!AGENT_TOKEN) {
  console.warn('[warn] AGENT_TOKEN is empty — the job queue is unauthenticated.')
}

/**
 * How the hub decides work needs doing.
 *
 * It only ever *creates* jobs; it never does them. Whether anything gets
 * processed depends on an agent being alive somewhere, which is normally the
 * Mac at home. If nothing is running, raw items are still on the glasses —
 * processing is a second lane, not the critical path.
 */
function enqueueTriage() {
  const pending = inbox.pending()
  if (pending.length === 0) return

  // One job per batch, not per item: the thinking is cheaper in bulk, and a
  // batch is still small enough that one bad line cannot strand twenty.
  const open = [...jobs.jobs.values()].find(
    j => j.capability === 'triage' && [JOB.QUEUED, JOB.CLAIMED].includes(j.status),
  )
  if (open) return

  jobs.create({
    capability: 'triage',
    input: { items: pending.slice(0, 20).map(i => ({ id: i.id, text: i.text, by: i.by })) },
    idempotencyKey: `triage:${pending[0].id}:${pending.length}`,
  })
}

/** Apply a triage job's result back onto the inbox. */
function applyTriageResult(result) {
  const rows = Array.isArray(result) ? result : result?.items
  if (!Array.isArray(rows)) return 0
  let applied = 0
  for (const row of rows) {
    const id = row.itemId ?? row.id
    if (!id) continue
    const out = inbox.sort(id, {
      kind: row.kind,
      list: row.list,
      parts: Array.isArray(row.parts) ? row.parts : null,
      note: row.note ?? null,
    })
    if (out.ok) applied += 1
  }
  return applied
}

const WEB_DIR = join(HERE, 'web')

/**
 * Turn checklist stats into planner input, folding in whatever is already
 * underway: a wash with twelve minutes left means that chore cannot be touched
 * for twelve minutes, and planning as if it were fresh would be a lie.
 */
function choresForPlan(requestedIds, space, now = Date.now()) {
  const active = checklists.snapshot(now).active
  const stats = checklists.allStats()

  return stats
    .filter(s => s.plan.length > 0)
    // One space at a time. Without this the running order was every checklist
    // in the config, so Storm Prep and Vendor Walk sat at the bottom of the
    // Life list — work lists on the screen you look at to decide whether you
    // have time to load the dishwasher.
    .filter(s => !space || (s.space ?? 'ops') === space)
    // Chores whose steps all have durations can be scheduled. The rest are
    // still returned — they are listed after the schedule with no time rather
    // than hidden, because "call the plumber" is exactly the kind of thing
    // that needs to stay in front of you.
    .map(s => ({ ...s, schedulable: s.plan.every(step => step.hasDuration) }))
    .filter(s => requestedIds.length === 0 || requestedIds.includes(s.checklistId))
    .map(s => {
      const run = active.find(r => r.checklistId === s.checklistId && !r.complete)
      let startIndex = 0
      let readyAt = 0

      if (run) {
        const index = s.plan.findIndex(step => step.id === run.currentItemId)
        startIndex = index === -1 ? 0 : index

        // A wait already running blocks this chore until it finishes.
        const current = run.items.find(i => i.id === run.currentItemId)
        if (current?.stepKind === 'wait' && current.remainingSeconds !== null) {
          readyAt = Math.max(0, current.remainingSeconds * 1000)
          startIndex += 1
        }
      }

      return {
        id: s.checklistId,
        name: s.name,
        space: s.space,
        steps: s.plan,
        startIndex,
        readyAt,
        schedulable: s.schedulable,
      }
    })
}

/**
 * Big-ticket tasks, as their own list.
 *
 * They were briefly folded into the agenda so the glasses needed no new view,
 * and the running total ran straight through them. That was wrong twice over:
 * these are not things you slot into a spare twenty minutes, and counting an
 * hour of tyre-fitting into the total made the number beside the dishwasher
 * useless for the one question it exists to answer.
 *
 * So: separate list, no cumulative column, different shape on screen.
 */
function taskRows(space) {
  return tasks
    .list()
    .filter(t => !space || t.space === space)
    .map(t => ({
    kind: 'task',
    taskId: t.id,
    label: t.label,
    note: t.note ?? '',
    ms: t.estimateMs,
    open: t.open,
    weight: t.weight,
    opensLabel: t.opensLabel,
    notes: t.notes,
  }))
}

/**
 * The running total down the chore list.
 *
 * Read down the column until it passes the time you have; everything above
 * the line is what you can get done. Big-ticket tasks are deliberately not in
 * it — they live above the list, not in it.
 */
function withRunningTotal(rows) {
  let busy = 0
  for (const row of rows) {
    if (row.kind === 'gap') {
      // A gap adds real time and no work. Both columns still get filled: a
      // blank row in the middle of the two totals breaks the scan down the
      // page, which is the only thing the columns are for.
      row.cumulativeBusyMs = busy
      row.cumulativeWallMs = row.at + row.ms
      continue
    }
    if (typeof row.ms === 'number') {
      busy += row.ms
      row.cumulativeBusyMs = busy
    } else {
      row.cumulativeBusyMs = null
    }
    // Wall clock: how long you have to actually be here to reach this step,
    // waits included. The busy total says you can put the laundry away after
    // 30 minutes of work; this says you will still be in the house at 1h40,
    // because the washer has to run. Both are true and they answer different
    // questions — "is this worth starting" and "can I leave".
    row.cumulativeWallMs = typeof row.endsAt === 'number' ? row.endsAt : null
  }
  return rows
}

function buildPlan(minutes, requestedIds, space) {
  const all = choresForPlan(requestedIds, space)
  const chores = all.filter(c => c.schedulable)
  const unestimated = all.filter(c => !c.schedulable)
  const plan = planBlock(chores, minutes)
  return {
    ...plan,
    // Tasks lead the screen, but as their own section above the list rather
    // than as rows in it. Scheduling by efficiency would bury every one of
    // them behind a dishwasher; folding them into the total corrupts it.
    tasks: taskRows(space),
    agenda: withRunningTotal(agenda(plan, unestimated)),
    // Solo reach per chore, so the "what fits" screen can answer
    // "how far do I get with just this one" without a second request.
    reach: chores.map(c => ({ choreId: c.id, name: c.name, ...reach(c, minutes) })),
  }
}

if (!INGEST_TOKEN) {
  console.warn('[warn] INGEST_TOKEN is empty — /ingest is unauthenticated. Set one before this leaves your bench.')
}

/**
 * CORS. The WebView enforces it regardless of the app.json whitelist, so both
 * gates have to pass. `*` is fine while READ_TOKEN is empty and the server is
 * on your LAN; set ALLOWED_ORIGIN once you know the plugin's origin.
 */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
}

function json(res, code, body) {
  const payload = JSON.stringify(body)
  cors(res)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function readBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Constant-time bearer check. */
function authorized(req, expected) {
  if (!expected) return true
  const header = req.headers.authorization || ''
  const given = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(given.padEnd(expected.length).slice(0, expected.length))
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b) && given.length === expected.length
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204)
    res.end()
    return
  }

  // ---- the capture page -------------------------------------------------
  // Deliberately unauthenticated: it is reachable only on your own network,
  // and a login screen between someone and adding "milk" is exactly the
  // friction that stops a shared list being used. Put it behind a tunnel or
  // your LAN, not behind a password.
  // Font measurement harness. Dev-only: holds one string for the probe page
  // to render so widths can be read off the simulator's pixels.
  if (url.pathname === '/probe') {
    if (req.method === 'POST') {
      const raw = await readBody(req)
      try {
        probeText = JSON.parse(raw).text ?? ''
      } catch {
        probeText = raw
      }
      return json(res, 200, { ok: true })
    }
    return json(res, 200, { text: probeText })
  }

  if (req.method === 'GET' && url.pathname === '/notes') {
    try {
      const html = readFileSync(join(WEB_DIR, 'tasks.html'))
      cors(res)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(html)
    } catch {
      return json(res, 404, { error: 'not found' })
    }
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = readFileSync(join(WEB_DIR, 'index.html'))
      cors(res)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
      return res.end(html)
    } catch (err) {
      return json(res, 500, { error: `page missing: ${err.message}` })
    }
  }

  if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
    cors(res)
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' })
    return res.end(
      JSON.stringify({
        name: 'The List',
        short_name: 'List',
        start_url: '/',
        display: 'standalone',
        background_color: '#111417',
        theme_color: '#111417',
      }),
    )
  }

  // ---- inbox ------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/inbox') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }
    const result = inbox.add(body.text, { by: body.by, clientId: body.clientId, at: body.at })
    // Queue the work immediately — creating a job costs nothing. How often it
    // actually runs is the agent's decision, which is where you want the cost
    // dial to live.
    if (result.ok && !result.duplicate) enqueueTriage()
    return json(res, result.ok ? 200 : 400, result)
  }

  if (req.method === 'GET' && url.pathname === '/inbox') {
    return json(res, 200, { items: inbox.active(), pending: inbox.pending().length })
  }

  const taskMatch = url.pathname.match(/^\/task\/([^/]+)\/(done|reopen|note)$/)
  if (req.method === 'POST' && taskMatch) {
    const id = decodeURIComponent(taskMatch[1])
    const action = taskMatch[2]

    if (action === 'note') {
      let body = {}
      try {
        const raw = await readBody(req)
        if (raw) body = JSON.parse(raw)
      } catch (err) {
        return json(res, 400, { error: `bad body: ${err.message}` })
      }
      const result = tasks.addNote(id, body.text, body.by, body.clientId)
      return json(res, result.ok ? 200 : 400, { ...result, tasks: tasks.list() })
    }

    const result = tasks.complete(id, action === 'done')
    return json(res, result.ok ? 200 : 404, { ...result, tasks: tasks.list() })
  }

  if (req.method === 'GET' && url.pathname === '/tasks') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    return json(res, 200, { tasks: tasks.list() })
  }

  const doneMatch = url.pathname.match(/^\/inbox\/([^/]+)\/done$/)
  if (req.method === 'POST' && doneMatch) {
    const result = inbox.complete(decodeURIComponent(doneMatch[1]))
    return json(res, result.ok ? 200 : 404, result)
  }

  // ---- job queue --------------------------------------------------------
  // Agents pull work from here. Nothing in this process ever does the work.
  if (url.pathname === '/jobs' || url.pathname.startsWith('/jobs/')) {
    if (!authorized(req, AGENT_TOKEN)) return json(res, 401, { error: 'unauthorized' })

    if (req.method === 'GET' && url.pathname === '/jobs') {
      const capability = url.searchParams.get('capability')
      return json(res, 200, { jobs: jobs.available(capability), summary: jobs.summary() })
    }

    if (req.method === 'POST' && url.pathname === '/jobs') {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch (err) {
        return json(res, 400, { error: `bad body: ${err.message}` })
      }
      const result = jobs.create(body)
      return json(res, result.ok ? 200 : 400, result)
    }

    const match = url.pathname.match(/^\/jobs\/([^/]+)\/(claim|heartbeat|result|fail)$/)
    if (req.method === 'POST' && match) {
      const [, id, action] = match
      let body = {}
      try {
        const raw = await readBody(req)
        if (raw) body = JSON.parse(raw)
      } catch (err) {
        return json(res, 400, { error: `bad body: ${err.message}` })
      }

      const agent = String(body.agent || '').slice(0, 40)
      let result

      if (action === 'claim') {
        result = jobs.claim(id, agent, body.leaseSeconds)
      } else if (action === 'heartbeat') {
        result = jobs.heartbeat(id, agent, body.leaseSeconds)
      } else if (action === 'result') {
        const job = jobs.get(id)
        result = jobs.finish(id, agent, body.result)
        // Triage results are applied here rather than by the agent: the agent
        // should not need to know what an inbox is.
        if (result.ok && job?.capability === 'triage') {
          const applied = applyTriageResult(body.result)
          console.log(`[triage] applied ${applied} item(s) from ${agent}`)
        }
      } else {
        result = jobs.fail(id, agent, body.error, body.retry !== false)
      }

      return json(res, result.ok ? 200 : result.code || 400, result)
    }

    return json(res, 404, { error: 'not found' })
  }

  // ---- health -----------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, metrics: store.index.size, uptime: process.uptime() })
  }

  // ---- read: the glasses poll this -------------------------------------
  if (req.method === 'GET' && url.pathname === '/state') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })

    const snapshot = store.snapshot()
    const boardId = url.searchParams.get('board')
    if (boardId) {
      const board = snapshot.boards.find(b => b.id === boardId)
      if (!board) return json(res, 404, { error: `no board "${boardId}"` })
      return json(res, 200, { generatedAt: snapshot.generatedAt, boards: [board] })
    }
    return json(res, 200, {
      ...snapshot,
      checklists: checklists.snapshot(),
      // Duration stats ride along so the "what fits in the time I have"
      // screen is instant rather than a second round trip.
      stats: checklists.allStats(),
      inbox: inbox.grouped(),
      tasks: tasks.list(),
      jobs: jobs.summary(),
    })
  }

  // ---- write: anything that speaks HTTP --------------------------------
  // curl -X POST localhost:8787/ingest -H 'Authorization: Bearer TOKEN' \
  //   -H 'Content-Type: application/json' \
  //   -d '{"metrics":[{"id":"ahu1.sat","value":58.2}]}'
  if (req.method === 'POST' && url.pathname === '/ingest') {
    if (!authorized(req, INGEST_TOKEN)) return json(res, 401, { error: 'unauthorized' })

    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }

    const items = Array.isArray(body) ? body : body.metrics || [body]
    const source = String(body.source || req.headers['x-source'] || 'http').slice(0, 32)

    const written = []
    const rejected = []
    for (const item of items) {
      const id = item.id ?? item.metric
      const result = store.set(id, item.value, { source, note: item.note })
      if (result.ok) written.push(id)
      else rejected.push({ id, error: result.error })
    }

    return json(res, rejected.length && !written.length ? 400 : 200, { written, rejected })
  }

  // ---- Slack Events API over HTTP (public URL required) ----------------
  if (req.method === 'POST' && url.pathname === '/slack/events') {
    const raw = await readBody(req)

    if (!SLACK_SIGNING_SECRET) {
      return json(res, 503, { error: 'SLACK_SIGNING_SECRET not configured' })
    }
    if (!verifySignature(SLACK_SIGNING_SECRET, req.headers, raw)) {
      return json(res, 401, { error: 'bad signature' })
    }

    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      return json(res, 400, { error: 'bad json' })
    }

    if (payload.type === 'url_verification') {
      return json(res, 200, { challenge: payload.challenge })
    }

    const event = payload.event
    if (event?.type === 'message' && !event.subtype && event.text) {
      applyMessage(event.text, event.channel, config, store)
    }
    // Slack retries anything that is not a prompt 200.
    return json(res, 200, { ok: true })
  }

  // ---- checklist writes -------------------------------------------------
  // Gated by READ_TOKEN: these come from the glasses app, not from machines,
  // so they carry the same credential the app already uses to read /state.
  if (req.method === 'POST' && ['/check', '/run/start', '/run/finish', '/step/begin', '/step/reset', '/remind'].includes(url.pathname)) {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })

    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (err) {
      return json(res, 400, { error: `bad body: ${err.message}` })
    }

    let result
    if (url.pathname === '/check') {
      result = checklists.check(body.runId, body.itemId, body.done !== false, Date.now(), body.by || 'glasses')
    } else if (url.pathname === '/run/start') {
      result = checklists.start(body.checklistId)
    } else if (url.pathname === '/step/begin') {
      result = checklists.beginStep(body.runId, body.itemId)
    } else if (url.pathname === '/step/reset') {
      result = checklists.resetStep(body.runId, body.itemId)
    } else if (url.pathname === '/remind') {
      // Ad-hoc reminder, for things the phone's own timer cannot know about.
      const delayMs = Math.max(0, Number(body.inMinutes ?? 0)) * 60_000
      const text = String(body.text || 'Check in').slice(0, 200)
      setTimeout(() => void notifier.send('Ops Board', text), delayMs)
      result = { ok: true }
    } else {
      result = checklists.finish(body.runId)
    }

    if (!result.ok) return json(res, 400, result)
    // Return the fresh checklist state so the glasses can repaint from the
    // server's view rather than guessing at what its own write did.
    return json(res, 200, { ok: true, checklists: checklists.snapshot() })
  }

  // ---- block plan -------------------------------------------------------
  // GET /plan?minutes=60&chores=laundry,dishes
  if (req.method === 'GET' && url.pathname === '/plan') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })

    // No window by default: schedule everything and let the reader stop where
    // their time runs out.
    const minutes = Math.max(5, Math.min(720, Number(url.searchParams.get('minutes')) || 720))
    const requested = (url.searchParams.get('chores') || '')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)

    // Default to Life: the running order is a Life screen, and an unfiltered
    // plan is how work lists ended up at the bottom of it.
    const space = url.searchParams.get('space') || 'life'
    return json(res, 200, buildPlan(minutes, requested, space === 'all' ? null : space))
  }

  // ---- daily summary ----------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/summary') {
    if (!authorized(req, READ_TOKEN)) return json(res, 401, { error: 'unauthorized' })
    const day = url.searchParams.get('day') || checklists.dayKey(Date.now() - 86400_000)
    const summary = checklists.readSummary(day) || checklists.rollup(day)
    return json(res, 200, summary)
  }

  json(res, 404, { error: 'not found' })
})

server.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT}`)
  console.log(`[server] ${store.index.size} metrics across ${config.boards.length} boards`)
  console.log(`[server] capture page at http://<your-lan-ip>:${PORT}/`)
  console.log(`[server] ${checklists.templates.size} checklists, day ${checklists.dayKey()} (reset ${checklists.resetHour}:00 ${checklists.timezone})`)
})

/**
 * Roll up the previous operational day once past summaryHour. Checked every
 * five minutes rather than scheduled for an exact time, so a restart or a
 * missed window still catches up instead of skipping a day silently.
 */
/**
 * Wait steps come due on their own schedule, so sweep often. Thirty seconds is
 * fine granularity for a wash cycle and costs nothing.
 */
setInterval(() => {
  sweepWaits(checklists, notifier).catch(err => console.warn(`[notify] sweep: ${err.message}`))
}, 30_000)

/**
 * Backstop sweep.
 *
 * Jobs are normally queued the moment something is captured; this catches
 * anything left behind by a restart or a failed batch. Raw items are on the
 * glasses immediately either way — sorted versions turn up whenever an agent
 * next runs, and hours later is fine.
 */
setInterval(enqueueTriage, 5 * 60_000)
enqueueTriage()

/**
 * Optional: let the hub do triage itself by calling the API directly.
 * Off unless TRIAGE_MODE=api, because the default is that thinking happens on
 * a machine you already pay for, not per token.
 */
if (process.env.TRIAGE_MODE === 'api') {
  console.log('[triage] TRIAGE_MODE=api — the hub will call the model itself')
  setInterval(() => {
    sweepInbox(inbox, triage).catch(err => console.warn(`[triage] sweep: ${err.message}`))
  }, 60_000)
}

checklists.maybeRollup()
setInterval(() => {
  try {
    checklists.maybeRollup()
  } catch (err) {
    console.warn(`[checklists] rollup failed: ${err.message}`)
  }
}, 5 * 60 * 1000)

startSocketMode({
  appToken: process.env.SLACK_APP_TOKEN,
  botToken: process.env.SLACK_BOT_TOKEN,
  config,
  store,
}).catch(err => console.warn(`[slack] ${err.message}`))
