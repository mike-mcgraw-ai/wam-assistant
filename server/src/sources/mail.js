import { execFile } from 'node:child_process'

const DEFAULT_TTL_SECONDS = 30 * 60
const MORNING_POLL_MS = 5 * 60_000
const OFF_HOURS_POLL_MS = 15 * 60_000
const SCRIPT_TIMEOUT_MS = 10_000
const UNREAD_SCRIPT = 'tell application "Mail" to get unread count of inbox'

function runAppleScript(script, { timeoutMs = SCRIPT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) return reject(error)
      resolve(String(stdout ?? '').trim())
    })
  })
}

function localMinutes(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

export function mailConfigFromEnv(env = process.env) {
  return {
    enabled: env.MAIL_BRIEF_ENABLED === '1',
    ttlSeconds: Math.max(5 * 60, Number(env.MAIL_BRIEF_TTL_SECONDS) || DEFAULT_TTL_SECONDS),
    timeoutMs: Math.max(1_000, Number(env.MAIL_BRIEF_TIMEOUT_MS) || SCRIPT_TIMEOUT_MS),
  }
}

export function mailRefreshDelayMs({ now = new Date(), timeZone = 'America/New_York', env = process.env } = {}) {
  const override = Number(env.MAIL_BRIEF_POLL_MS)
  if (Number.isFinite(override) && override >= 60_000) return override
  const minutes = localMinutes(now, timeZone)
  return minutes >= 4 * 60 + 30 && minutes <= 10 * 60 + 30
    ? MORNING_POLL_MS
    : OFF_HOURS_POLL_MS
}

export async function refreshMailBrief({
  morningBrief,
  env = process.env,
  now = Date.now(),
  runScript = runAppleScript,
  logger = console,
} = {}) {
  if (!morningBrief) throw new Error('morningBrief is required')
  const config = mailConfigFromEnv(env)
  if (!config.enabled) {
    return morningBrief.updateSource({
      id: 'mail',
      status: 'notConfigured',
      display: 'setup',
      source: 'apple-mail',
      confidence: 'unverified',
    }, { now })
  }

  try {
    const raw = await runScript(UNREAD_SCRIPT, { timeoutMs: config.timeoutMs })
    const count = Number(String(raw).trim())
    if (!Number.isInteger(count) || count < 0) throw new Error('Apple Mail returned an invalid unread count')
    return morningBrief.updateSource({
      id: 'mail',
      status: 'ok',
      kind: 'count',
      value: count,
      display: String(count),
      asOf: new Date(now).toISOString(),
      ttlSeconds: config.ttlSeconds,
      source: 'apple-mail',
      confidence: 'live',
      privacy: 'countOnly',
    }, { now })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Apple Mail count failed'
    logger?.warn?.(`[mail] ${message}`)
    const current = morningBrief.snapshot({ space: 'life', now }).sources.mail
    return morningBrief.updateSource({
      id: 'mail',
      status: 'error',
      display: current?.display && current.display !== 'setup' ? current.display : 'err',
      asOf: current?.asOf ?? null,
      source: 'apple-mail',
      confidence: current?.confidence ?? 'unverified',
      privacy: 'countOnly',
      error: message,
    }, { now })
  }
}
