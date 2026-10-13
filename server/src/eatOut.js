/**
 * Eating out, weekly, for the life game.
 *
 * The ledger feed (~/Downloads/wam/wam_ledger.py) owns the facts: one total
 * per Mon-Sun week, household, all cards, plus the date its bank data runs
 * through. It posts them to /ingest as `eatOut` with source "ledger". This
 * module only checks that shape, keeps the latest copy, and scores it against
 * the rule in game.config.json. No merchants, accounts or amounts other than
 * the weekly totals ever reach the hub.
 *
 * A week is scored once it has settled: `settleDays` after its Sunday (bank
 * data lands a day or three late), and only if the ledger's data runs through
 * that Sunday. A feed that stopped must never read as a cheap week.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const DAY = /^\d{4}-\d{2}-\d{2}$/
// Same calendar maths as game.js, kept here so game.js can import this file.
const utc = key => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d) }
const addDays = (key, n) => new Date(utc(key) + n * 86400000).toISOString().slice(0, 10)
const isMonday = key => new Date(utc(key)).getUTCDay() === 1

/** The ingest body's `eatOut`, cleaned, or { error }. */
export function cleanEatOut(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'eatOut must be an object' }
  if (!DAY.test(String(raw.through))) return { error: 'eatOut.through must be YYYY-MM-DD' }
  if (!Array.isArray(raw.weeks) || raw.weeks.length > 104) return { error: 'eatOut.weeks must be a list of at most 104 weeks' }
  const weeks = []
  for (const w of raw.weeks) {
    const week = String(w?.week)
    const spent = Number(w?.eatOut)
    if (!DAY.test(week) || !isMonday(week)) return { error: `eatOut week ${week} is not a Monday` }
    if (!Number.isFinite(spent) || spent < 0) return { error: `eatOut total for ${week} is not a dollar amount` }
    weeks.push({ week, eatOut: Math.round(spent * 100) / 100 })
  }
  return { through: raw.through, weeks }
}

export function loadEatOut(path) {
  if (!path || !existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function saveEatOut(path, data) {
  writeFileSync(path, JSON.stringify({ ...data, at: Date.now() }, null, 2) + '\n')
}

/**
 * Game entries for settled weeks, each on its Sunday.
 * @param {object} p
 * @param {{through: string, weeks: {week: string, eatOut: number}[]}|null} p.eatOut
 * @param {object} [p.rule]  game.config.json `eatOut`
 * @param {string} p.today   current operational day key
 */
export function eatOutEntries({ eatOut, rule, today }) {
  if (!rule || !eatOut?.weeks || !Number.isFinite(rule.weeklyTarget)) return []
  const { weeklyTarget, underXP = 0, overPenalty = 0, settleDays = 3, firstWeek = '' } = rule
  const out = []
  for (const w of eatOut.weeks) {
    if (w.week < firstWeek) continue
    const sunday = addDays(w.week, 6)
    if (addDays(sunday, settleDays) >= today) continue // still settling
    if (!eatOut.through || eatOut.through < sunday) continue // feed never reached the week's end
    const under = w.eatOut <= weeklyTarget
    const xp = under ? underXP : -overPenalty
    if (!xp) continue
    out.push({ day: sunday, kind: 'eat-out', week: w.week, spent: w.eatOut, target: weeklyTarget, under, xp })
  }
  return out
}
