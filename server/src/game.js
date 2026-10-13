/**
 * The life game: XP, levels, penalties and streaks.
 *
 * Everything here is a pure function of the checklist runs and the rule table
 * in game.config.json. There is no stored score. Every call recomputes from
 * the full history, so the same history and rules always give the same
 * number, a rule change re-scores the past consistently, and there is nothing
 * that can drift out of step with what actually happened. No AI is involved
 * at any point; Mike's standing rule is that judgement lives in config he can
 * read, not in a model.
 *
 * Sources, per run (runs.json is the final state, unticks already undone):
 *   step      +stepXP for each item checked in the run
 *   complete  +completeBonus when every item of the list is checked
 *   miss      -missPenalty per daily item still unchecked when its day ends,
 *             from startDay on, on the weekdays the list is due
 *   carry     -stepPenalty per committed step still unchecked when a day
 *             ends: a list named in a Start Day walk (its steps from the
 *             run's startIndex on), charged every day until done
 *   task-miss -taskPenalty per committed one-off task still open when a day
 *             ends, every day until done
 *   eat-out   +underXP / -overPenalty per settled Mon-Sun week of eating out,
 *             against the weekly target, on the week's Sunday (eatOut.js)
 * A list marked "ignore" in the rules neither earns nor costs anything.
 * Days are the checklists' operational days (shifted by resetHour), so a
 * 1am tick counts toward the day it belongs to, exactly as the lists do.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { eatOutEntries } from './eatOut.js'

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** "2026-10-13" -> "tue". Pure calendar maths on the key, no time zone. */
export function weekday(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number)
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

export function addDays(dayKey, n) {
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Level from total XP. Lv1 starts at 0; each level costs `growth` more. */
export function levelFor(xp, { base = 100, growth = 50 } = {}) {
  let level = 1
  let floor = 0
  let size = base
  while (xp >= floor + size) {
    floor += size
    level += 1
    size = base + growth * (level - 1)
  }
  return { level, floor, size, into: xp - floor, toNext: floor + size - xp }
}

export function ruleFor(config, checklistId) {
  return { ...config.defaults, ...(config.checklists?.[checklistId] || {}) }
}

/** Daily lists due on a given day, per their penaltyDays. */
function dueDailies(templates, config, day) {
  const wd = weekday(day)
  return [...templates.values()].filter(t => {
    const rule = ruleFor(config, t.id)
    return t.kind === 'daily' && !rule.ignore && (rule.penaltyDays || []).includes(wd)
  })
}

/**
 * @param {object} p
 * @param {object[]} p.runs        checklist runs (runs.json shape)
 * @param {Map<string, object>} p.templates  checklistId -> template with items
 * @param {object} p.config        game.config.json
 * @param {string} p.today         current operational day key
 * @param {number} [p.historyDays] how many days of history to return
 * @param {object[]} [p.commitments] [{ day, runIds, taskIds }] from Start Day
 * @param {object} [p.taskInfo]    taskId -> { label, doneAt }
 * @param {(ts: number) => string} [p.dayKeyOf] instant -> operational day
 * @param {object} [p.eatOut]      the ledger's weekly eating-out totals
 */
export function computeGame({
  runs, templates, config, today, historyDays = 60,
  commitments = [], taskInfo = {}, dayKeyOf = ts => new Date(ts).toISOString().slice(0, 10),
  eatOut = null,
}) {
  const days = new Map()
  const bucket = day => {
    if (!days.has(day)) days.set(day, { day, earned: 0, penalty: 0, entries: [] })
    return days.get(day)
  }

  // ---- earning: every run, all history -----------------------------------
  const runIndex = new Map() // `${checklistId}:${day}` -> daily run
  for (const run of runs) {
    if (!run?.day) continue
    const tpl = templates.get(run.checklistId)
    const rule = ruleFor(config, run.checklistId)
    if (rule.ignore) continue
    const itemIds = tpl ? (tpl.items || []).map(i => i.id) : null
    const checked = Object.keys(run.checked || {}).filter(id => !itemIds || itemIds.includes(id))
    if (tpl?.kind === 'daily') runIndex.set(`${run.checklistId}:${run.day}`, run)

    const b = bucket(run.day)
    for (const itemId of checked) {
      b.earned += rule.stepXP
      b.entries.push({ kind: 'step', checklistId: run.checklistId, itemId, xp: rule.stepXP })
    }
    if (itemIds?.length && itemIds.every(id => run.checked?.[id])) {
      b.earned += rule.completeBonus
      b.entries.push({ kind: 'complete', checklistId: run.checklistId, xp: rule.completeBonus })
    }
  }

  // ---- penalties: only finished days, only from startDay ------------------
  const start = config.startDay || today
  for (let day = start; day < today; day = addDays(day, 1)) {
    for (const tpl of dueDailies(templates, config, day)) {
      const rule = ruleFor(config, tpl.id)
      if (!rule.missPenalty) continue
      const run = runIndex.get(`${tpl.id}:${day}`)
      const missed = (tpl.items || []).filter(i => !run?.checked?.[i.id]).map(i => i.id)
      if (!missed.length) continue
      const xp = -rule.missPenalty * missed.length
      const b = bucket(day)
      b.penalty += xp
      b.entries.push({ kind: 'miss', checklistId: tpl.id, items: missed, xp })
    }
  }

  // ---- commitments: carried every day until done --------------------------
  // A commitment's first day is the first Start Day walk that named it. From
  // then (and from startDay) every finished day it is still not done costs
  // again: the list keeps it in front of Mike and the score keeps it honest.
  const commit = { stepPenalty: 10, taskPenalty: 10, ...(config.commitments || {}) }
  const runById = new Map(runs.map(r => [r.runId, r]))
  const firstRun = new Map()
  const firstTask = new Map()
  for (const c of commitments) {
    for (const id of c.runIds || []) if (!firstRun.has(id) || c.day < firstRun.get(id)) firstRun.set(id, c.day)
    for (const id of c.taskIds || []) if (!firstTask.has(id) || c.day < firstTask.get(id)) firstTask.set(id, c.day)
  }
  const later = (a, b) => (a > b ? a : b)

  for (const [runId, from] of firstRun) {
    const run = runById.get(runId)
    const tpl = run && templates.get(run.checklistId)
    if (!tpl || ruleFor(config, run.checklistId).ignore || !commit.stepPenalty) continue
    const startIndex = Number.isInteger(run.startIndex) ? run.startIndex : 0
    const committed = (tpl.items || []).slice(startIndex)
    const finishedDay = run.finishedAt ? dayKeyOf(run.finishedAt) : null
    for (let day = later(from, start); day < today; day = addDays(day, 1)) {
      if (finishedDay && day > finishedDay) break
      const left = committed.filter(i => {
        const c = run.checked?.[i.id]
        return !c || dayKeyOf(c.at) > day
      })
      if (!left.length) break // done by the end of this day, and so of every later one
      const xp = -commit.stepPenalty * left.length
      const b = bucket(day)
      b.penalty += xp
      b.entries.push({ kind: 'carry', checklistId: run.checklistId, runId, items: left.map(i => i.id), xp, carried: day > from })
    }
  }

  for (const [taskId, from] of firstTask) {
    const info = taskInfo[taskId]
    if (!info || !commit.taskPenalty) continue
    const doneDay = info.doneAt ? dayKeyOf(info.doneAt) : null
    for (let day = later(from, start); day < today; day = addDays(day, 1)) {
      if (doneDay && doneDay <= day) break
      const b = bucket(day)
      b.penalty -= commit.taskPenalty
      b.entries.push({ kind: 'task-miss', taskId, label: info.label, xp: -commit.taskPenalty, carried: day > from })
    }
  }

  // ---- eating out: one result per settled week, on its Sunday -------------
  for (const { day, ...entry } of eatOutEntries({ eatOut, rule: config.eatOut, today })) {
    const b = bucket(day)
    if (entry.xp > 0) b.earned += entry.xp
    else b.penalty += entry.xp
    b.entries.push(entry)
  }

  // ---- running total, floored at zero -------------------------------------
  // A floor rather than debt: a bad week can cost levels, but never leaves a
  // hole so deep that showing up stops visibly moving the number.
  const ordered = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
  let total = 0
  for (const d of ordered) {
    d.net = d.earned + d.penalty
    total = Math.max(0, total + d.net)
    d.total = total
  }

  // ---- streaks ------------------------------------------------------------
  const complete = day => {
    const due = dueDailies(templates, config, day)
    if (!due.length) return null // nothing due: neutral
    return due.every(tpl => {
      const run = runIndex.get(`${tpl.id}:${day}`)
      return (tpl.items || []).length > 0 && (tpl.items || []).every(i => run?.checked?.[i.id])
    })
  }
  let streak = 0
  for (let day = complete(today) ? today : addDays(today, -1), n = 0; n < 1000; day = addDays(day, -1), n++) {
    const c = complete(day)
    if (c === null) continue
    if (!c) break
    streak += 1
  }
  let best = 0
  let run = 0
  const first = ordered[0]?.day || today
  for (let day = first; day <= today; day = addDays(day, 1)) {
    const c = complete(day)
    if (c === null) continue
    run = c ? run + 1 : 0
    best = Math.max(best, run)
  }

  const todayRow = days.get(today) || { day: today, earned: 0, penalty: 0, net: 0, entries: [] }
  return {
    today,
    startDay: start,
    xp: total,
    ...levelFor(total, config.levels),
    streak,
    bestStreak: Math.max(best, streak),
    todayEarned: todayRow.earned,
    // The day's misses land when it ends, so "today" never shows a penalty;
    // the newest landed one is yesterday's.
    lastPenalty: ordered.filter(d => d.penalty < 0).at(-1) || null,
    days: ordered.slice(-historyDays).reverse(),
  }
}

/** What the glasses need: small and stable. */
export function gameSummary(g) {
  return {
    level: g.level,
    xp: g.xp,
    into: g.into,
    size: g.size,
    toNext: g.toNext,
    streak: g.streak,
    todayEarned: g.todayEarned,
  }
}

/**
 * Level-up and streak-milestone pings, at most once each.
 *
 * Remembers the last level and milestone it announced in a small JSON file.
 * The first run after install records the current values silently, so a
 * backfilled history does not fire a burst of pings. A level lost to
 * penalties is recorded without a ping; regaining it pings again.
 */
export class GameAnnouncer {
  constructor({ statePath, notifier, config }) {
    this.statePath = statePath
    this.notifier = notifier
    this.config = config
    this.state = null
    if (statePath && existsSync(statePath)) {
      try { this.state = JSON.parse(readFileSync(statePath, 'utf8')) } catch { this.state = null }
    }
  }

  #save() {
    if (this.statePath) writeFileSync(this.statePath, JSON.stringify(this.state, null, 2) + '\n')
  }

  async observe(game) {
    const milestones = this.config.streak?.milestones || []
    const reached = milestones.filter(m => game.streak >= m).at(-1) || 0
    if (!this.state) {
      this.state = { level: game.level, milestone: reached }
      this.#save()
      return []
    }
    const sent = []
    if (game.level > this.state.level && this.config.pings?.levelUp !== false) {
      sent.push(`Level ${game.level} reached: ${game.xp} XP. ${game.toNext} to Level ${game.level + 1}.`)
    }
    if (reached > (this.state.milestone || 0) && this.config.pings?.streakMilestone !== false) {
      sent.push(`${reached}-day streak: every daily list done ${reached} days running.`)
    }
    // A broken streak resets the milestone so the next climb announces again.
    const milestone = game.streak === 0 ? 0 : Math.max(reached, this.state.milestone || 0)
    if (game.level !== this.state.level || milestone !== this.state.milestone) {
      this.state = { level: game.level, milestone }
      this.#save()
    }
    for (const text of sent) await this.notifier.send('WAM', text)
    return sent
  }
}
