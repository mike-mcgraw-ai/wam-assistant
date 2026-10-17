/**
 * Dated follow-ups.
 *
 * Mike, 2026-10-15/17: when the main step of a task is done (texted the
 * doctor) but a dated step remains (the appointment), "remove, then calendar
 * reminder + it shows up on my list closer to the date — the 7 days reminder —
 * and just an easy check off like shower for those."
 *
 * So a follow-up is a label and a calendar day. It stays out of sight until
 * LEAD_DAYS before that day, then sits on Home as a one-click check-off until
 * it is done (overdue ones stay). Two phone reminders, each sent once: when it
 * comes into view, and on the day. All fixed rules — no model decides
 * anything here.
 *
 * Days are operational day keys (`YYYY-MM-DD`, from checklists.dayKey), so
 * "today" turns over at the same 05:00 as everything else on Home.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const LEAD_DAYS = 7
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

function dayNumber(day) {
  const m = DAY.exec(String(day ?? ''))
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  // Reject impossible dates ("2026-02-31") rather than letting them roll over.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return Math.round(t / 86_400_000)
}

/** Calendar days from `from` to `to` (both `YYYY-MM-DD`); null if either is bad. */
export function daysBetween(from, to) {
  const a = dayNumber(from)
  const b = dayNumber(to)
  return a === null || b === null ? null : b - a
}

/** `YYYY-MM-DD` plus n calendar days. */
export function addDays(day, n) {
  const base = dayNumber(day)
  if (base === null) return null
  return new Date((base + Number(n)) * 86_400_000).toISOString().slice(0, 10)
}

function cleanLabel(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

export class Followups {
  constructor({ storePath = null, logPath = null } = {}) {
    this.storePath = storePath
    this.logPath = logPath
    this.items = new Map()
    this.#load()
  }

  #load() {
    if (!this.storePath || !existsSync(this.storePath)) return
    try {
      const saved = JSON.parse(readFileSync(this.storePath, 'utf8'))
      for (const item of saved.items ?? []) this.items.set(item.id, item)
    } catch (err) {
      console.warn(`[followups] could not read store: ${err.message}`)
    }
  }

  #persist() {
    if (!this.storePath) return
    mkdirSync(dirname(this.storePath), { recursive: true })
    const temp = `${this.storePath}.tmp`
    writeFileSync(temp, JSON.stringify({ items: [...this.items.values()] }, null, 2), { mode: 0o600 })
    renameSync(temp, this.storePath)
  }

  #log(event) {
    if (!this.logPath) return
    try {
      mkdirSync(dirname(this.logPath), { recursive: true })
      appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 })
    } catch (err) {
      console.warn(`[followups] could not log: ${err.message}`)
    }
  }

  list() {
    return [...this.items.values()]
      .filter(item => !item.deletedAt)
      .sort((a, b) => a.dueDay.localeCompare(b.dueDay) || a.createdAt - b.createdAt)
  }

  get(id) {
    const item = this.items.get(String(id))
    return item && !item.deletedAt ? item : null
  }

  add({ label, dueDay, taskId = null, space = 'life', clientId = null } = {}, now = Date.now()) {
    const text = cleanLabel(label)
    if (!text) return { ok: false, error: 'label required' }
    if (dayNumber(dueDay) === null) return { ok: false, error: 'dueDay must be YYYY-MM-DD' }
    if (clientId) {
      const existing = this.list().find(item => item.clientId === String(clientId))
      if (existing) return { ok: true, followup: existing, duplicate: true }
    }
    const item = {
      id: `fu-${randomUUID()}`,
      label: text,
      dueDay,
      taskId: taskId ? String(taskId) : null,
      space: space === 'ops' ? 'ops' : 'life',
      clientId: clientId ? String(clientId).slice(0, 120) : null,
      createdAt: now,
      updatedAt: now,
      doneAt: null,
      doneDay: null,
      leadNotifiedAt: null,
      dueNotifiedAt: null,
      deletedAt: null,
    }
    this.items.set(item.id, item)
    this.#log({ type: 'followup_add', id: item.id, dueDay, taskId: item.taskId, at: now })
    this.#persist()
    return { ok: true, followup: item }
  }

  update(id, { label, dueDay } = {}, now = Date.now()) {
    const item = this.get(id)
    if (!item) return { ok: false, error: 'unknown follow-up' }
    if (label !== undefined) {
      const text = cleanLabel(label)
      if (!text) return { ok: false, error: 'label required' }
      item.label = text
    }
    if (dueDay !== undefined) {
      if (dayNumber(dueDay) === null) return { ok: false, error: 'dueDay must be YYYY-MM-DD' }
      if (dueDay !== item.dueDay) {
        item.dueDay = dueDay
        // A new date is a new schedule: both reminders are owed again.
        item.leadNotifiedAt = null
        item.dueNotifiedAt = null
      }
    }
    item.updatedAt = now
    this.#log({ type: 'followup_update', id: item.id, label: item.label, dueDay: item.dueDay, at: now })
    this.#persist()
    return { ok: true, followup: item }
  }

  setDone(id, done, today, now = Date.now()) {
    const item = this.get(id)
    if (!item) return { ok: false, error: 'unknown follow-up' }
    item.doneAt = done ? now : null
    item.doneDay = done ? today : null
    item.updatedAt = now
    this.#log({ type: done ? 'followup_done' : 'followup_reopen', id: item.id, at: now })
    this.#persist()
    return { ok: true, followup: item }
  }

  remove(id, now = Date.now()) {
    const item = this.get(id)
    if (!item) return { ok: false, error: 'unknown follow-up' }
    item.deletedAt = now
    this.#log({ type: 'followup_delete', id: item.id, at: now })
    this.#persist()
    return { ok: true }
  }

  /**
   * What Home shows today: open follow-ups within LEAD_DAYS of their day,
   * overdue ones, and ones ticked today (so a tick can be undone before it
   * leaves the screen).
   */
  visible(today, space = 'life') {
    return this.list()
      .filter(item => item.space === space)
      .map(item => ({ ...item, daysLeft: daysBetween(today, item.dueDay) }))
      .filter(item => item.daysLeft !== null)
      .filter(item => (item.doneAt ? item.doneDay === today : item.daysLeft <= LEAD_DAYS))
      .map(item => ({
        id: item.id, label: item.label, dueDay: item.dueDay, daysLeft: item.daysLeft,
        taskId: item.taskId, done: Boolean(item.doneAt), doneAt: item.doneAt,
      }))
  }

  /** Reminders owed today, each at most once: coming into view, and the day. */
  remindersDue(today) {
    const owed = []
    for (const item of this.list()) {
      if (item.doneAt) continue
      const days = daysBetween(today, item.dueDay)
      if (days === null) continue
      if (days <= 0 && !item.dueNotifiedAt) owed.push({ id: item.id, kind: 'due', item, days })
      else if (days > 0 && days <= LEAD_DAYS && !item.leadNotifiedAt) owed.push({ id: item.id, kind: 'lead', item, days })
    }
    return owed
  }

  markReminded(id, kind, now = Date.now()) {
    const item = this.get(id)
    if (!item) return
    if (kind === 'due') item.dueNotifiedAt = now
    else item.leadNotifiedAt = now
    this.#persist()
  }
}

/** "Doctor appointment — in 7 days (Oct 28)" / "— today" / "— 2 days late". */
export function reminderText({ item, days }) {
  const [y, m, d] = item.dueDay.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  if (days > 1) return `${item.label} — in ${days} days (${date})`
  if (days === 1) return `${item.label} — tomorrow (${date})`
  if (days === 0) return `${item.label} — today`
  return `${item.label} — ${-days} day${days === -1 ? '' : 's'} late (${date})`
}
