/**
 * Keyboard control of the glasses, from the /mirror page.
 *
 * The mirror page posts a key as an action; the app on the glasses long-polls
 * for actions and handles each exactly as if the ring had sent it (see
 * glasses/src/remoteinput.ts). The hub only passes them along.
 *
 *   POST /input {action}      up | down | click | double | menu:<itemID>
 *   GET  /input?after=<seq>   waits up to 25s for anything newer than <seq>
 *
 * Unauthenticated, like /mirror and /screen: reachable only on your own
 * network or tailnet. Anyone who can open /mirror can also drive the app.
 */

const ACTION = /^(up|down|click|double|menu:\d{1,4})$/
/** A key press is only meaningful now. Anything older is dropped, not replayed. */
const FRESH_MS = 10_000
const WAIT_MS = 25_000
const KEEP = 50

let seq = 0
/** @type {{seq: number, action: string, at: number}[]} */
const queue = []
/** @type {Set<() => void>} */
const waiting = new Set()
/** When the app last asked. It asks again the moment it has handled a key, so
 * "nobody waiting right now" is not the same as "nobody listening". */
let lastPollAt = 0

function newer(after) {
  const cutoff = Date.now() - FRESH_MS
  return queue.filter(input => input.seq > after && input.at >= cutoff)
}

/**
 * Handle /input. Returns false for any other path so the caller carries on.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {{ json: Function, readBody: Function }} helpers
 */
export async function handleRemoteInput(req, res, url, { json, readBody }) {
  if (url.pathname !== '/input') return false

  if (req.method === 'POST') {
    let action = ''
    try {
      action = String(JSON.parse(await readBody(req, 1024)).action ?? '')
    } catch {
      json(res, 400, { error: 'expected {"action": "..."}' })
      return true
    }
    if (!ACTION.test(action)) {
      json(res, 400, { error: `unknown action "${action}"` })
      return true
    }
    seq += 1
    queue.push({ seq, action, at: Date.now() })
    if (queue.length > KEEP) queue.splice(0, queue.length - KEEP)
    for (const wake of waiting) wake()
    const listening = waiting.size > 0 || Date.now() - lastPollAt < WAIT_MS + 5_000
    json(res, 200, { ok: true, seq, listening })
    return true
  }

  if (req.method !== 'GET') {
    json(res, 405, { error: 'GET or POST' })
    return true
  }

  lastPollAt = Date.now()
  const after = Number(url.searchParams.get('after'))
  // A first call, or a hub restarted since the app last asked (its counter is
  // ahead of ours): hand back the current position and nothing to replay.
  if (!Number.isFinite(after) || after < 0 || after > seq) {
    json(res, 200, { seq, inputs: [] })
    return true
  }

  const ready = newer(after)
  if (ready.length) {
    json(res, 200, { seq, inputs: ready })
    return true
  }

  await new Promise(resolve => {
    const done = () => {
      clearTimeout(timer)
      waiting.delete(done)
      resolve(undefined)
    }
    const timer = setTimeout(done, WAIT_MS)
    waiting.add(done)
    // The response, not the request: a GET's request side 'closes' as soon
    // as it has been read, which would end every wait at once.
    res.on('close', done)
  })
  if (!res.writableEnded && !res.destroyed) json(res, 200, { seq, inputs: newer(after) })
  return true
}
