import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

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
    if (!this.storePath) return true
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
      return true
    } catch (err) {
      console.warn(`[tasks] could not write store: ${err.message}`)
      return false
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

  has(id) {
    return Boolean(this.#taskById(id))
  }

  ensureTask(input = {}, now = Date.now()) {
    const id = String(input.id || '').trim()
    if (id) {
      const existing = this.#taskById(id)
      if (existing) return { ok: true, task: existing, existing: true }
    }
    return this.addTask(input, now)
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
          needsPlan: t.needsPlan === true,
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

  completed() {
    return this.taskDefs()
      .filter(task => this.done.has(task.id))
      .map(task => ({
        id: task.id,
        label: task.label,
        space: task.space ?? 'life',
        doneAt: this.done.get(task.id).doneAt,
        completedOn: this.done.get(task.id).completedOn ?? null,
        notes: this.notes(task.id),
      }))
      .sort((left, right) => right.doneAt - left.doneAt)
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

    const requestedId = String(input.id || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
    const base =
      requestedId ||
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
      ...(input.needsPlan === true ? { needsPlan: true } : {}),
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
    const body = String(text ?? '').trim().slice(0, 2_000)
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

  updateNote(id, noteId, text, by = 'listen-ai', now = Date.now()) {
    const existing = this.notes_.get(id)
    const note = existing?.find(row => row.id === noteId)
    if (!note) return { ok: false, error: 'unknown note' }
    const body = String(text ?? '').trim().slice(0, 2_000)
    if (!body) return { ok: false, error: 'empty note' }
    note.text = body
    note.by = String(by || note.by || 'me').slice(0, 16)
    this.#log({ type: 'task_note_update', id, noteId, text: body, by: note.by, at: now })
    this.#persist()
    return { ok: true }
  }

  removeNote(id, noteId) {
    const existing = this.notes_.get(id)
    if (!existing) return { ok: false, error: 'no notes' }
    const kept = existing.filter(n => n.id !== noteId)
    if (kept.length === existing.length) return { ok: false, error: 'unknown note' }
    this.notes_.set(id, kept)
    this.#log({ type: 'task_note_deleted', id, noteId, at: Date.now() })
    this.#persist()
    return { ok: true }
  }

  complete(id, done = true, now = Date.now()) {
    if (!this.#taskById(id)) {
      return { ok: false, error: `unknown task "${id}"` }
    }
    if (done === this.done.has(id)) return { ok: true, unchanged: true }
    if (done) this.done.set(id, { doneAt: now })
    else this.done.delete(id)
    this.#log({ type: done ? 'task_done' : 'task_reopen', id, at: now })
    this.#persist()
    return { ok: true }
  }

  previewCompletionDate(id, day, noteId, dayKeyOf, now = Date.now(), linkedEvidence = null) {
    const task = this.#taskById(id)
    const completion = this.done.get(id)
    if (!task || !completion) return { ok: false, error: 'task is not completed' }
    const note = linkedEvidence?.id === noteId
      ? linkedEvidence
      : this.notes(id).find(row => row.id === noteId && String(row.by).startsWith('listen'))
    if (!note) return { ok: false, error: 'linked voice note not found' }
    const validDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) &&
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
    if (!validDay) return { ok: false, error: 'invalid completion date' }
    const beforeDay = completion.completedOn ?? dayKeyOf(completion.doneAt)
    if (day > dayKeyOf(completion.doneAt) || day > dayKeyOf(now)) return { ok: false, error: 'date must be no later than recorded completion' }
    const reviewKey = createHash('sha256').update(JSON.stringify([
      id, day, noteId, note.text, completion.doneAt, completion.completedOn ?? null,
    ])).digest('hex')
    return { ok: true, taskId: id, label: task.label, note: { id: note.id, text: note.text }, beforeDay, proposedDay: day, expectedDoneAt: completion.doneAt, reviewKey }
  }

  correctCompletionDate(id, day, noteId, reviewKey, dayKeyOf, now = Date.now(), linkedEvidence = null) {
    const preview = this.previewCompletionDate(id, day, noteId, dayKeyOf, now, linkedEvidence)
    if (!preview.ok) return preview
    if (reviewKey !== preview.reviewKey) return { ok: false, error: 'completion review changed; review again' }
    const completion = this.done.get(id)
    const previous = { ...completion }
    completion.completedOn = day
    completion.correctedAt = now
    completion.correctionNoteId = noteId
    if (!this.#persist()) {
      this.done.set(id, previous)
      return { ok: false, error: 'could not save completion date' }
    }
    this.#log({ type: 'task_completion_date_corrected', id, beforeDay: preview.beforeDay, completedOn: day, noteId, at: now, by: 'human' })
    return { ok: true, taskId: id, completedOn: day }
  }
}

export function linkedCompletionEvidence(items, taskId) {
  return items
    .filter(item => (item.reviewState === 'reviewed' || item.reviewState === 'done') &&
      item.destinationRefs?.some(ref => (ref.kind === 'task' && ref.id === taskId) || ref.taskIds?.includes(taskId)))
    .map(item => ({ id: `spoken:${item.id}`, text: item.cleanedTranscript || item.rawTranscript?.text || item.summary || '', by: 'spoken-review' }))
    .filter(item => item.text)
}

/**
 * The open task a spoken clause names, if any. Fixed rules, no model: the
 * clause and the task label match once lowercased and stripped of
 * punctuation, or one contains the other as whole words and the shorter side
 * is at least two words. "call the dentist about the crown" finds a task
 * called "Call the dentist"; "call dentist" does not, because it never
 * guesses — a miss just makes a new task, which is cheap to spot.
 */
export function matchOpenTask(clause, openTasks) {
  const norm = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const c = norm(clause)
  if (!c) return null
  const words = value => value.split(' ').filter(Boolean).length
  const contains = (hay, needle) => ` ${hay} `.includes(` ${needle} `)
  return openTasks.find(t => {
    const l = norm(t.label)
    if (!l) return false
    if (l === c) return true
    if (words(l) >= 2 && contains(c, l)) return true
    if (words(c) >= 2 && contains(l, c)) return true
    return false
  }) ?? null
}
