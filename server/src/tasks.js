import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * One-off tasks.
 *
 * Distinct from checklists, which are recurring procedures with steps. These
 * are the jobs that matter and do not repeat: a phone call, a trip, a thing
 * you have been avoiding.
 *
 * They lead the running order by design. Scheduling by efficiency sorts on
 * what is easy to plan, which systematically buries anything without a tidy
 * estimate — so the dishwasher floats to the top and the dentist sinks. That
 * is precisely backwards.
 */

const WINDOWS = {
  business: { days: [1, 2, 3, 4, 5], from: 9, to: 17, label: 'M-F' },
  evening: { days: [0, 1, 2, 3, 4, 5, 6], from: 17, to: 21, label: 'eve' },
  anytime: null,
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "9am" on its own, "9a" when it has a day name in front of it. */
function hourLabel(hour, short = false) {
  const suffix = hour < 12 ? 'a' : 'p'
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return short ? `${h12}${suffix}` : `${h12}${suffix}m`
}

export class Tasks {
  constructor(config, { storePath, logPath }) {
    this.config = config
    this.storePath = storePath
    this.logPath = logPath
    /** @type {Map<string, {doneAt: number}>} */
    this.done = new Map()
    /**
     * Notes, newest last, per task id.
     *
     * A chore is a checkbox. A one-off is usually not: "Call dentist" is
     * blocked on finding out which dentist, and "Replace car tire" is really
     * three hours of driving and a day off work. Without somewhere to put that,
     * the row is a guilt generator — it tells you to do a thing it cannot tell
     * you how to start.
     *
     * @type {Map<string, Array<{id: string, text: string, by: string, at: number}>>}
     */
    this.notes_ = new Map()
    this.customTasks = []
    this.#load()
  }

  #load() {
    if (!this.storePath || !existsSync(this.storePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'))
      for (const [id, value] of Object.entries(raw.done || {})) this.done.set(id, value)
      for (const [id, value] of Object.entries(raw.notes || {})) {
        if (Array.isArray(value)) this.notes_.set(id, value)
      }
      if (Array.isArray(raw.customTasks)) this.customTasks = raw.customTasks.filter(task => task?.id && task?.label)
    } catch (err) {
      console.warn(`[tasks] could not read store: ${err.message}`)
    }
  }

  #persist() {
    if (!this.storePath) return
    try {
      mkdirSync(dirname(this.storePath), { recursive: true })
      writeFileSync(
        this.storePath,
        JSON.stringify(
          {
            done: Object.fromEntries(this.done),
            notes: Object.fromEntries(this.notes_),
            customTasks: this.customTasks,
          },
          null,
          2,
        ),
      )
    } catch (err) {
      console.warn(`[tasks] could not write store: ${err.message}`)
    }
  }

  #log(event) {
    if (!this.logPath) return
    try {
      mkdirSync(dirname(this.logPath), { recursive: true })
      appendFileSync(this.logPath, JSON.stringify(event) + '\n')
    } catch {
      // best effort
    }
  }

  taskDefs() {
    return [...(this.config.tasks || []), ...this.customTasks]
  }

  #taskById(id) {
    return this.taskDefs().find(t => t.id === id)
  }

  /**
   * Is this task actionable right now?
   *
   * A task outside its window is still listed — hiding it is how something
   * gets forgotten for a month — but it is marked, and it says when it opens.
   */
  #windowState(task, now) {
    const window = WINDOWS[task.window ?? 'anytime']
    if (!window) return { open: true, opensLabel: null }

    const date = new Date(now)
    const hour = date.getHours() + date.getMinutes() / 60

    if (window.days.includes(date.getDay()) && hour >= window.from && hour < window.to) {
      return { open: true, opensLabel: null }
    }

    // Say when it opens rather than that it is shut. "9am" is a plan you can
    // make; "closed" just invites you to keep re-checking the same row.
    for (let ahead = 0; ahead < 8; ahead += 1) {
      const day = new Date(now)
      day.setDate(day.getDate() + ahead)
      if (!window.days.includes(day.getDay())) continue
      if (ahead === 0 && hour >= window.from) continue
      return {
        open: false,
        opensLabel:
          ahead === 0
            ? hourLabel(window.from)
            : `${DAYS[day.getDay()]}${hourLabel(window.from, true)}`,
      }
    }

    return { open: false, opensLabel: window.label }
  }

  /**
   * Everything not done, in order.
   *
   * Nothing is hidden. While the list is still being built, seeing a row you
   * cannot act on right now is the point — you are checking that it is there
   * at all. `filters.hideClosed` is the switch for later; it stays off until
   * the list is trusted enough that hiding something is not the same as
   * losing it.
   */
  list(now = Date.now()) {
    const hideClosed = this.config.filters?.hideClosed === true
    return this.taskDefs()
      .filter(t => !this.done.has(t.id))
      .map(t => {
        const win = this.#windowState(t, now)
        return {
          id: t.id,
          label: t.label,
          weight: t.weight === 'big' ? 'big' : 'normal',
          estimateMs: t.estimateMinutes ? t.estimateMinutes * 60_000 : null,
          note: t.note ?? null,
          window: t.window ?? 'anytime',
          open: win.open,
          opensLabel: win.opensLabel,
          space: t.space ?? 'life',
          notes: this.notes(t.id),
        }
      })
      .filter(t => !hideClosed || t.open)
      // Big first, then shortest — the easiest win among the things that
      // matter is on top.
      //
      // The time window deliberately does NOT sort. It used to, and the effect
      // was that at 11pm the dentist call sank below everything: the one row
      // that most needs to stay in your face got quietly demoted for the
      // twelve hours you were most likely to be looking at the screen. The
      // window is shown ("9am") and never ranked. Suppressing things that are
      // genuinely impossible right now is a filter, and filters come later,
      // on purpose — see `filters` below.
      .sort(
        (a, b) =>
          (b.weight === 'big' ? 1 : 0) - (a.weight === 'big' ? 1 : 0) ||
          (a.estimateMs ?? Infinity) - (b.estimateMs ?? Infinity),
      )
  }

  /** Seeded notes from config first, then anything added since. */
  notes(id) {
    const task = this.#taskById(id)
    const seeded = (task?.notes || []).map((text, i) => ({
      id: `seed-${i}`,
      text,
      by: 'config',
      at: 0,
    }))
    return [...seeded, ...(this.notes_.get(id) ?? [])]
  }

  addTask(input = {}, now = Date.now()) {
    const label = String(input.label ?? input.text ?? '').trim().slice(0, 80)
    if (!label) return { ok: false, error: 'empty task' }

    const clientId = String(input.clientId || '').trim()
    if (clientId) {
      const existing = this.customTasks.find(t => t.clientId === clientId)
      if (existing) return { ok: true, duplicate: true, task: existing }
    }

    const base =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || `task-${now.toString(36)}`
    const ids = new Set(this.taskDefs().map(t => t.id))
    let id = base
    let suffix = 2
    while (ids.has(id)) {
      id = `${base}-${suffix}`
      suffix += 1
    }

    const estimate = Number(input.estimateMinutes)
    const task = {
      id,
      label,
      weight: input.weight === 'normal' ? 'normal' : 'big',
      window: ['business', 'evening', 'anytime'].includes(input.window) ? input.window : 'anytime',
      space: input.space === 'ops' ? 'ops' : 'life',
      ...(Number.isFinite(estimate) && estimate > 0 ? { estimateMinutes: Math.round(estimate) } : {}),
      ...(String(input.note || '').trim() ? { note: String(input.note).trim().slice(0, 120) } : {}),
      ...(clientId ? { clientId } : {}),
    }

    this.customTasks.push(task)
    this.#log({ type: 'task_add', id, label, by: input.by || 'me', at: now })
    this.#persist()

    const firstNote = String(input.firstNote || '').trim()
    if (firstNote) this.addNote(id, firstNote, input.by, `${clientId || id}:note`, now)

    return { ok: true, task }
  }

  /**
   * Add a note.
   *
   * `clientId` makes it idempotent: the capture page queues offline and
   * retries, and a retry must not leave you with the same sentence twice.
   */
  addNote(id, text, by = 'me', clientId = null, now = Date.now()) {
    if (!this.#taskById(id)) {
      return { ok: false, error: `unknown task "${id}"` }
    }
    const body = String(text ?? '').trim().slice(0, 400)
    if (!body) return { ok: false, error: 'empty note' }

    const existing = this.notes_.get(id) ?? []
    const noteId = clientId || `n${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
    if (existing.some(n => n.id === noteId)) return { ok: true, duplicate: true }

    existing.push({ id: noteId, text: body, by: String(by || 'me').slice(0, 16), at: now })
    this.notes_.set(id, existing)
    this.#log({ type: 'task_note', id, noteId, text: body, by, at: now })
    this.#persist()
    return { ok: true }
  }

  removeNote(id, noteId) {
    const existing = this.notes_.get(id)
    if (!existing) return { ok: false, error: 'no notes' }
    const kept = existing.filter(n => n.id !== noteId)
    if (kept.length === existing.length) return { ok: false, error: 'unknown note' }
    this.notes_.set(id, kept)
    this.#persist()
    return { ok: true }
  }

  complete(id, done = true, now = Date.now()) {
    if (!this.#taskById(id)) {
      return { ok: false, error: `unknown task "${id}"` }
    }
    if (done) this.done.set(id, { doneAt: now })
    else this.done.delete(id)
    this.#log({ type: done ? 'task_done' : 'task_reopen', id, at: now })
    this.#persist()
    return { ok: true }
  }
}
