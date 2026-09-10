import crypto from 'node:crypto'

/**
 * Slack ingestion.
 *
 * Two independent paths, because which one you can use depends on your network:
 *
 *   1. Socket Mode (recommended for a building network behind NAT) — outbound
 *      WebSocket, no public URL, no inbound firewall rule. Needs the optional
 *      @slack/socket-mode dependency and an app-level token.
 *   2. Events API over HTTP — requires a public HTTPS URL Slack can reach.
 *      Signature verification below is mandatory: without it anyone who finds
 *      the URL can write to your boards.
 */

const PAIR_RE = /([a-z0-9_]+(?:\.[a-z0-9_]+)+)\s*[=:]\s*(-?\d+(?:\.\d+)?|[A-Za-z]{1,24})/gi

/**
 * Pull metric updates out of one Slack message.
 * Explicit `metric.id = value` pairs win; configured regex patterns are the
 * fallback for messages written by humans or by a system you cannot reformat.
 */
export function parseMessage(text, channelConfig, store) {
  const updates = []
  if (!text) return updates

  for (const match of text.matchAll(PAIR_RE)) {
    const [, id, value] = match
    if (store.knows(id)) updates.push({ metric: id, value })
  }

  if (updates.length === 0 && channelConfig?.patterns) {
    for (const pattern of channelConfig.patterns) {
      let re
      try {
        re = new RegExp(pattern.match, 'i')
      } catch {
        console.warn(`[slack] bad pattern skipped: ${pattern.match}`)
        continue
      }
      const m = text.match(re)
      if (m) {
        const value = m[pattern.valueGroup ?? 1]
        if (value !== undefined && store.knows(pattern.metric)) {
          updates.push({ metric: pattern.metric, value })
        }
      }
    }
  }

  return updates
}

/** Apply parsed updates. Returns the ids actually written. */
export function applyMessage(text, channelId, config, store) {
  const channelConfig = config.slack?.channels?.[channelId]
  if (!channelConfig) return []

  const written = []
  for (const update of parseMessage(text, channelConfig, store)) {
    const result = store.set(update.metric, update.value, { source: `slack:${channelId}` })
    if (result.ok) written.push(update.metric)
    else console.warn(`[slack] ${result.error}`)
  }
  if (written.length) console.log(`[slack] updated ${written.join(', ')}`)
  return written
}

/**
 * Verify a Slack request signature (v0 scheme).
 * Uses timingSafeEqual and rejects anything older than five minutes to blunt
 * replay attempts.
 */
export function verifySignature(signingSecret, headers, rawBody) {
  const timestamp = headers['x-slack-request-timestamp']
  const signature = headers['x-slack-signature']
  if (!timestamp || !signature) return false

  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(age) || age > 300) return false

  const base = `v0:${timestamp}:${rawBody}`
  const expected =
    'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex')

  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Start Socket Mode if the optional dependency and tokens are present.
 * Absent either, this is a no-op and the HTTP path still works.
 */
export async function startSocketMode({ appToken, botToken, config, store }) {
  if (!appToken) {
    console.log('[slack] SLACK_APP_TOKEN not set — Socket Mode off')
    return null
  }

  let SocketModeClient
  try {
    ({ SocketModeClient } = await import('@slack/socket-mode'))
  } catch {
    console.warn('[slack] @slack/socket-mode not installed — run: npm install @slack/socket-mode')
    return null
  }

  const client = new SocketModeClient({ appToken })

  client.on('message', async ({ event, ack }) => {
    if (ack) await ack()
    if (!event || event.subtype === 'bot_message' || !event.text) return
    applyMessage(event.text, event.channel, config, store)
  })

  await client.start()
  console.log('[slack] Socket Mode connected')
  return client
}
