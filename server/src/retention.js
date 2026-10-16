/**
 * Which spoken work is kept, from retention.config.json.
 *
 * In "dev" mode nothing with real speech in it ever expires: recordings and
 * ended Listen sessions are the raw material for building Review Spoken Work,
 * and losing them to a 14-day timer means losing the examples. Only trivial
 * captures — no recognised words, or a few seconds of nothing — still expire
 * after releaseDays. Kept review recordings remain kept until explicit purge.
 */
import { readFileSync } from 'node:fs'

const DAY_MS = 24 * 60 * 60 * 1000

function load() {
  try {
    return JSON.parse(readFileSync(new URL('./retention.config.json', import.meta.url), 'utf8'))
  } catch {
    return {}
  }
}

const config = load()
export const RETENTION_MODE = config.mode === 'release' ? 'release' : 'dev'
export const RELEASE_RETENTION_MS = (Number(config.releaseDays) > 0 ? Number(config.releaseDays) : 14) * DAY_MS
const MIN_WORDS = Number.isFinite(Number(config.trivial?.minWords)) ? Number(config.trivial.minWords) : 1
const MIN_SECONDS = Number.isFinite(Number(config.trivial?.minSeconds)) ? Number(config.trivial.minSeconds) : 3

export function wordCount(texts) {
  let n = 0
  for (const text of texts) n += String(text || '').split(/\s+/).filter(w => /\w/.test(w)).length
  return n
}

/** No recognised words, or too short to hold any. */
export function isTrivial({ words, seconds }) {
  return words < MIN_WORDS || (Number.isFinite(seconds) && seconds < MIN_SECONDS)
}

/** True when this capture must survive past its expiry date. */
export function keepPastExpiry(capture) {
  return RETENTION_MODE === 'dev' && !isTrivial(capture)
}
