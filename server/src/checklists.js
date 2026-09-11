import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Checklist runs.
 *
 * A *checklist* is a template. A *run* is one pass through it. Daily templates
 * open a run automatically each operational day; on-demand templates open one
 * when you start them.
 *
 * The operational day is shifted by resetHour, so a 01:00 check on a night
 * walk-through still counts toward the day that started at 05:00 the morning
 * before — rather than silently landing on tomorrow's list.
 *
 * Every check is also appended to a JSONL log. Runs get rewritten; the log is
 * append-only and is what any later summary or compliance answer is built from.
 */

export class Checklists {
  constructor(config, { runsPath, logPath, summaryPath }) {
    this.config = config
    this.timezone = config.timezone || 'America/New_York'
    this.resetHour = Number.isFinite(config.resetHour) ? config.resetHour : 5
    this.summaryHour = Number.isFinite(config.summaryHour) ? config.summaryHour : 6

    this.runsPath = runsPath
    this.logPath = logPath
    this.summaryPath = summaryPath

    this.templates = new Map()
    for (const list of config.checklists || []) {
      if (this.templates.has(list.id)) throw new Error(`Duplicate checklist id "${list.id}"`)
      this.templates.set(list.id, list)
    }

    /** @type {Map<string, any>} runId -> run */
    this.runs = new Map()
    this.lastRolledDay = null
    this.#load()
  }

  // ---- day maths ---------------------------------------------------------

  /** Local YYYY-MM-DD for an instant, shifted by resetHour. */
  dayKey(ts = Date.now()) {
    const shifted = new Date(ts - this.resetHour * 3600 * 1000)
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(shifted)
  }

  /** Local hour 0-23, unshifted — used to decide when to roll up. */
  localHour(ts = Date.now()) {
    return Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: this.timezone,
        hour: '2-digit',
        hour12: false,
      }).format(ts),
    )
  }

  // ---- persistence -------------------------------------------------------

  #load() {
    if (!this.runsPath || !existsSync(this.runsPath)) return
    try {
      const raw = JSON.parse(readFileSync(this.runsPath, 'utf8'))
      for (const run of raw.runs || []) this.runs.set(run.runId, run)
      this.lastRolledDay = raw.lastRolledDay ?? null
      console.log(`[checklists] restored ${this.runs.size} runs`)
    } catch (err) {
      console.warn(`[checklists] could not read runs: ${err.message}`)
    }
  }

  #persist() {
    if (!this.runsPath) return
    try {
      mkdirSync(dirname(this.runsPath), { recursive: true })
      // Keep the file bounded: finished runs older than 30 days live in the log.
      const cutoff = Date.now() - 30 * 86400 * 1000
      const runs = [...this.runs.values()].filter(r => !r.finishedAt || r.finishedAt > cutoff)
      writeFileSync(
        this.runsPath,
        JSON.stringify({ runs, lastRolledDay: this.lastRolledDay }, null, 2),
      )
    } catch (err) {
      console.warn(`[checklists] could not write runs: ${err.message}`)
    }
  }

  #log(event) {
    if (!this.logPath) return
    try {
      mkdirSync(dirname(this.logPath), { recursive: true })
      appendFileSync(this.logPath, JSON.stringify(event) + '\n')
    } catch (err) {
      console.warn(`[checklists] could not append log: ${err.message}`)
    }
  }

  // ---- runs --------------------------------------------------------------

  #newRun(template, day, now) {
    const run = {
      runId: randomUUID(),
      checklistId: template.id,
      name: template.name,
      kind: template.kind,
      day,
      startedAt: now,
      finishedAt: null,
      /** itemId -> {at, by} for checked items only */
      checked: {},
      /**
       * itemId -> {startedAt, endsAt|null}
       * A `do` step is started when you arrive at it, so its duration is real
       * elapsed time rather than a guess. A `wait` step is armed with an
       * endsAt, which is what the reminder sweep watches for.
       */
      timing: {},
      /** itemIds whose wait has already produced a reminder */
      notified: [],
    }
    this.runs.set(run.runId, run)
    this.#log({ type: 'run_start', runId: run.runId, checklistId: template.id, day, at: now })
    return run
  }

  /** Today's run for a daily template, created on first look. */
  dailyRun(template, now = Date.now()) {
    const day = this.dayKey(now)
    for (const run of this.runs.values()) {
      if (run.checklistId === template.id && run.day === day) return run
    }
    const run = this.#newRun(template, day, now)
    this.#persist()
    return run
  }

  /** Start an on-demand run. Returns the existing open one rather than duplicating. */
  start(checklistId, now = Date.now()) {
    const template = this.templates.get(checklistId)
    if (!template) return { ok: false, error: `unknown checklist "${checklistId}"` }

    const open = [...this.runs.values()].find(
      r => r.checklistId === checklistId && !r.finishedAt,
    )
    if (open) return { ok: true, run: open, existing: true }

    const run = this.#newRun(template, this.dayKey(now), now)
    this.#persist()
    return { ok: true, run }
  }

  /** The template step definition for an item, or undefined. */
  step(checklistId, itemId) {
    return this.templates.get(checklistId)?.items.find(i => i.id === itemId)
  }

  /**
   * Begin a step: record when it started, and for a `wait` step compute when
   * it comes due. Starting is idempotent — arriving at the same step twice
   * must not restart a wash cycle that is already running.
   */
  beginStep(runId, itemId, now = Date.now()) {
    const run = this.runs.get(runId)
    if (!run) return { ok: false, error: 'unknown run' }
    const step = this.step(run.checklistId, itemId)
    if (!step) return { ok: false, error: `unknown item "${itemId}"` }
    if (run.timing[itemId]) return { ok: true, already: true }

    const endsAt = step.kind === 'wait' && step.waitMinutes
      ? now + step.waitMinutes * 60_000
      : null

    // Lag: how long between finishing the previous step and starting this one.
    // This is the number that says whether a step needs an explicit start at
    // all — a step you always begin immediately can have the click removed.
    const items = this.templates.get(run.checklistId).items
    const index = items.findIndex(i => i.id === itemId)
    const previousAt = index > 0 ? run.checked[items[index - 1].id]?.at ?? null : null
    const lagMs = previousAt === null ? null : Math.max(0, now - previousAt)

    run.timing[itemId] = { startedAt: now, endsAt, lagMs }
    this.#log({ type: 'step_start', runId, checklistId: run.checklistId, itemId, kind: step.kind ?? 'do', at: now, endsAt, lagMs })
    this.#persist()
    return { ok: true }
  }

  check(runId, itemId, done = true, now = Date.now(), by = 'glasses') {
    const run = this.runs.get(runId)
    if (!run) return { ok: false, error: 'unknown run' }

    const template = this.templates.get(run.checklistId)
    if (!template?.items.some(i => i.id === itemId)) {
      return { ok: false, error: `unknown item "${itemId}"` }
    }

    const step = this.step(run.checklistId, itemId)

    if (done) {
      // If the step was never explicitly begun, fall back to the end of the
      // previous step so a duration is still recorded rather than lost.
      if (!run.timing[itemId]) {
        const items = template.items
        const index = items.findIndex(i => i.id === itemId)
        const previous = index > 0 ? run.checked[items[index - 1].id]?.at : null
        run.timing[itemId] = { startedAt: previous ?? run.startedAt, endsAt: null, inferred: true }
      }
      const timing = run.timing[itemId]
      timing.completedAt = now
      timing.durationMs = Math.max(0, now - timing.startedAt)
      run.checked[itemId] = { at: now, by }
    } else {
      delete run.checked[itemId]
      delete run.timing[itemId]
    }

    this.#log({
      type: done ? 'check' : 'uncheck',
      runId, checklistId: run.checklistId, itemId,
      kind: step?.kind ?? 'do',
      at: now, by,
      durationMs: done ? run.timing[itemId]?.durationMs ?? null : null,
    })
    this.#persist()

    // Finishing a step arms the next one only when the next one is a `wait`,
    // or is explicitly marked autoStart.
    //
    // A wait has no ambiguity: the machine is running whether or not you are
    // paying attention, so its clock should start the moment you load it. A
    // `do` step is the opposite — there is no guarantee you go straight from
    // one to the next, and auto-starting it would silently fold standing
    // around into the duration you are trying to measure.
    if (done) {
      const items = template.items
      const index = items.findIndex(i => i.id === itemId)
      const next = items[index + 1]
      if (next && ((next.kind ?? 'do') === 'wait' || next.autoStart === true)) {
        this.beginStep(runId, next.id, now)
      }
    }

    return { ok: true }
  }

  /**
   * Put a step back to not-started: clears its clock and its tick.
   * The discarded timing is logged rather than dropped, so a reset is
   * recoverable and does not quietly vanish from the record.
   */
  resetStep(runId, itemId, now = Date.now()) {
    const run = this.runs.get(runId)
    if (!run) return { ok: false, error: 'unknown run' }
    if (!this.step(run.checklistId, itemId)) return { ok: false, error: `unknown item "${itemId}"` }

    const discarded = run.timing[itemId] ?? null
    delete run.timing[itemId]
    delete run.checked[itemId]
    run.notified = run.notified.filter(id => id !== itemId)

    this.#log({ type: 'step_reset', runId, checklistId: run.checklistId, itemId, at: now, discarded })
    this.#persist()
    return { ok: true }
  }

  finish(runId, now = Date.now()) {
    const run = this.runs.get(runId)
    if (!run) return { ok: false, error: 'unknown run' }
    run.finishedAt = now
    this.#log({ type: 'run_finish', runId, checklistId: run.checklistId, at: now })
    this.#persist()
    return { ok: true }
  }

  // ---- read model --------------------------------------------------------

  #shape(run, now) {
    const template = this.templates.get(run.checklistId)

    const items = template.items.map(item => {
      const timing = run.timing[item.id]
      const stepKind = item.kind ?? 'do'
      const endsAt = timing?.endsAt ?? null

      return {
        id: item.id,
        label: item.label,
        stepKind,
        estimateMinutes: item.estimateMinutes ?? null,
        waitMinutes: item.waitMinutes ?? null,
        done: Boolean(run.checked[item.id]),
        at: run.checked[item.id]?.at ?? null,
        startedAt: timing?.startedAt ?? null,
        /** a `do` step whose clock is running but which is not finished */
        running: Boolean(timing?.startedAt) && !run.checked[item.id],
        elapsedMs: timing?.startedAt && !run.checked[item.id] ? now - timing.startedAt : null,
        /** how long it actually took, once done — the number worth keeping */
        tookMs:
          timing?.startedAt && timing?.completedAt ? timing.completedAt - timing.startedAt : null,
        /**
         * A `do` step running far longer than it should be.
         *
         * Almost always a step started by accident or forgotten, not a job
         * that really took five hours — and left alone it poisons the median
         * this whole thing is built on. Flagged so it can be reset rather than
         * completed with a fictional duration.
         */
        suspect:
          stepKind === 'do' &&
          Boolean(timing?.startedAt) &&
          !run.checked[item.id] &&
          now - timing.startedAt >
            Math.max(3 * (item.estimateMinutes ?? 15) * 60_000, 2 * 3600_000),
        lagMs: timing?.lagMs ?? null,
        autoStart: item.autoStart === true || stepKind === 'wait',
        endsAt,
        /** Negative once a wait has come due but not yet been ticked off. */
        remainingSeconds: endsAt === null ? null : Math.round((endsAt - now) / 1000),
        durationMs: timing?.durationMs ?? null,
      }
    })

    const done = items.filter(i => i.done).length

    // Active time is what you spend; wall time is when it is finally finished.
    // Planning "can I start this before I leave" needs both, and they can
    // differ by an order of magnitude on anything with a machine in it.
    const activeMs = items
      .filter(i => i.stepKind === 'do' && i.durationMs !== null)
      .reduce((sum, i) => sum + i.durationMs, 0)

    const lastAt = items.reduce((max, i) => (i.at && i.at > (max ?? 0) ? i.at : max), null)

    // Wall time runs from when the first step actually began, not from when the
    // record was created. Those differ whenever a list is opened and started
    // later — a daily run materialises at 05:00 whether or not you touch it.
    const firstStartedAt = items.reduce(
      (min, i) => (i.startedAt && (min === null || i.startedAt < min) ? i.startedAt : min),
      /** @type {number|null} */ (null),
    )
    const wallFrom = firstStartedAt ?? run.startedAt

    return {
      runId: run.runId,
      checklistId: run.checklistId,
      name: run.name,
      kind: run.kind,
      space: template.space ?? 'ops',
      day: run.day,
      done,
      total: items.length,
      complete: done === items.length,
      /** when the most recent step was ticked — "finished 2h ago" */
      lastAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      ageSeconds: Math.round((now - run.startedAt) / 1000),
      activeMs,
      wallMs: Math.max(0, (lastAt ?? now) - wallFrom),
      /** The step you are on: first not-done item. */
      currentItemId: items.find(i => !i.done)?.id ?? null,
      items,
    }
  }

  /** Median without pulling in a stats library; [] -> null. */
  static median(values) {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
  }

  /**
   * Duration stats for one checklist, from completed runs.
   *
   * Median rather than mean: one run where you got distracted for an hour
   * should not move the number you plan against. `samples` is returned so the
   * UI can say how much to trust it, and fall back to the configured estimate
   * while it is thin.
   */
  stats(checklistId) {
    const template = this.templates.get(checklistId)
    if (!template) return null

    const finished = [...this.runs.values()]
      .filter(r => r.checklistId === checklistId)
      .map(r => this.#shape(r, Date.now()))
      .filter(r => r.complete)

    const estimateMs = template.items
      .filter(i => (i.kind ?? 'do') === 'do')
      .reduce((sum, i) => sum + (i.estimateMinutes ?? 0) * 60_000, 0)

    const estimateWallMs = template.items.reduce(
      (sum, i) =>
        sum + ((i.kind === 'wait' ? i.waitMinutes : i.estimateMinutes) ?? 0) * 60_000,
      0,
    )

    const activeMedian = Checklists.median(finished.map(r => r.activeMs).filter(Boolean))
    const wallMedian = Checklists.median(finished.map(r => r.wallMs).filter(Boolean))

    // Three runs is where a median starts meaning anything. Below that the
    // configured estimate is the more honest number to show.
    const trusted = finished.length >= 3

    return {
      checklistId,
      name: template.name,
      space: template.space ?? 'ops',
      samples: finished.length,
      trusted,
      activeMs: trusted && activeMedian ? activeMedian : estimateMs,
      wallMs: trusted && wallMedian ? wallMedian : estimateWallMs,
      /**
       * Best available duration per step, in template order — a real median
       * where there is one, the configured estimate otherwise. This is what
       * the planner schedules against, so it must never contain a null.
       */
      plan: template.items.map(item => {
        const stepKind = item.kind ?? 'do'
        const durations = finished
          .map(r => r.items.find(i => i.id === item.id)?.durationMs)
          .filter(d => typeof d === 'number' && d > 0)
        const median = durations.length >= 3 ? Checklists.median(durations) : null
        const declared = stepKind === 'wait' ? item.waitMinutes : item.estimateMinutes
        return {
          id: item.id,
          label: item.label,
          stepKind,
          ms: median ?? (declared ?? 0) * 60_000,
          measured: median !== null,
          /**
           * Whether this step has a duration worth scheduling against. A list
           * with no estimates is not "5 minutes a step" — it is unknown, and
           * planning against a made-up number is worse than leaving it out.
           */
          hasDuration: median !== null || declared != null,
        }
      }),
      steps: template.items.map(item => {
        const shaped = finished.map(r => r.items.find(i => i.id === item.id))
        const durations = shaped
          .map(i => i?.durationMs)
          .filter(d => typeof d === 'number' && d > 0)
        const lags = shaped.map(i => i?.lagMs).filter(l => typeof l === 'number')

        const stepKind = item.kind ?? 'do'
        const medianLagMs = Checklists.median(lags)

        // If you always start this step the moment the previous one ends, the
        // start click is ceremony rather than measurement — mark it so it can
        // be turned into an autoStart. Suggested, never applied silently:
        // the whole point of the number is that you get to decide.
        const autoStartSuggested =
          stepKind === 'do' &&
          item.autoStart !== true &&
          lags.length >= 3 &&
          medianLagMs !== null &&
          medianLagMs < 45_000

        return {
          id: item.id,
          label: item.label,
          stepKind,
          samples: durations.length,
          medianMs: Checklists.median(durations),
          /** how long you typically wait before starting this step */
          medianLagMs,
          lagSamples: lags.length,
          autoStart: item.autoStart === true || stepKind === 'wait',
          autoStartSuggested,
        }
      }),
    }
  }

  /** Every checklist's stats, for the "what fits in the time I have" screen. */
  allStats() {
    return [...this.templates.keys()].map(id => this.stats(id))
  }

  /**
   * Armed wait steps that have come due and not yet been announced.
   * Returned rather than fired here so the caller owns delivery — and so a
   * failed send does not mark the reminder as done.
   */
  dueWaits(now = Date.now()) {
    const due = []
    for (const run of this.runs.values()) {
      if (run.finishedAt) continue
      for (const [itemId, timing] of Object.entries(run.timing)) {
        if (!timing.endsAt || timing.completedAt) continue
        if (timing.endsAt > now) continue
        if (run.notified.includes(itemId)) continue
        const step = this.step(run.checklistId, itemId)
        due.push({ runId: run.runId, checklistId: run.checklistId, name: run.name, itemId, label: step?.label ?? itemId, endsAt: timing.endsAt })
      }
    }
    return due
  }

  markNotified(runId, itemId) {
    const run = this.runs.get(runId)
    if (!run || run.notified.includes(itemId)) return
    run.notified.push(itemId)
    this.#log({ type: 'wait_notified', runId, checklistId: run.checklistId, itemId, at: Date.now() })
    this.#persist()
  }

  /**
   * Active runs plus the on-demand templates you could start.
   * Daily runs are materialised here, so simply opening the app on a new day
   * is what creates the day's list.
   */
  snapshot(now = Date.now()) {
    const active = []

    for (const template of this.templates.values()) {
      if (template.kind === 'daily') {
        active.push(this.#shape(this.dailyRun(template, now), now))
      }
    }

    for (const run of this.runs.values()) {
      if (run.kind === 'ondemand' && !run.finishedAt) active.push(this.#shape(run, now))
    }

    // Incomplete first, then most recently started.
    active.sort((a, b) => Number(a.complete) - Number(b.complete) || b.startedAt - a.startedAt)

    const startable = [...this.templates.values()]
      .filter(t => t.kind === 'ondemand')
      .filter(t => !active.some(r => r.checklistId === t.id))
      .map(t => ({ id: t.id, name: t.name, total: t.items.length, space: t.space ?? 'ops' }))

    return { active, startable }
  }

  // ---- daily rollup ------------------------------------------------------

  /** Summarise one operational day from the runs still in memory. */
  rollup(day, now = Date.now()) {
    const runs = [...this.runs.values()].filter(r => r.day === day).map(r => this.#shape(r, now))

    const summary = {
      day,
      generatedAt: new Date(now).toISOString(),
      runs: runs.map(r => ({
        checklistId: r.checklistId,
        name: r.name,
        kind: r.kind,
        done: r.done,
        total: r.total,
        complete: r.complete,
        missed: r.items.filter(i => !i.done).map(i => i.label),
        firstCheckAt: r.items.reduce(
          (min, i) => (i.at && (min === null || i.at < min) ? i.at : min),
          /** @type {number|null} */ (null),
        ),
        lastCheckAt: r.items.reduce((max, i) => (i.at && i.at > (max ?? 0) ? i.at : max), null),
      })),
    }

    summary.totals = summary.runs.reduce(
      (acc, r) => {
        acc.done += r.done
        acc.total += r.total
        acc.missed += r.total - r.done
        return acc
      },
      { done: 0, total: 0, missed: 0 },
    )

    if (this.summaryPath) {
      try {
        mkdirSync(this.summaryPath, { recursive: true })
        writeFileSync(join(this.summaryPath, `${day}.json`), JSON.stringify(summary, null, 2))
      } catch (err) {
        console.warn(`[checklists] could not write summary: ${err.message}`)
      }
    }
    this.#log({ type: 'rollup', day, at: now, totals: summary.totals })
    return summary
  }

  readSummary(day) {
    if (!this.summaryPath) return null
    try {
      return JSON.parse(readFileSync(join(this.summaryPath, `${day}.json`), 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * Called on a timer. Rolls up the previous day once the local clock passes
   * summaryHour. Idempotent: lastRolledDay guards against repeats, and a
   * restart mid-day will not re-summarise a day already done.
   */
  maybeRollup(now = Date.now()) {
    const today = this.dayKey(now)
    if (this.localHour(now) < this.summaryHour) return null
    if (this.lastRolledDay === today) return null

    // The day that just ended.
    const previous = this.dayKey(now - 24 * 3600 * 1000)
    const summary = this.rollup(previous, now)

    // Close out any on-demand run left open overnight; an abandoned storm-prep
    // list should not follow you into the next day as if it were live.
    for (const run of this.runs.values()) {
      if (run.kind === 'ondemand' && !run.finishedAt && run.day !== today) {
        run.finishedAt = now
        this.#log({ type: 'run_auto_close', runId: run.runId, checklistId: run.checklistId, at: now })
      }
    }

    this.lastRolledDay = today
    this.#persist()
    console.log(`[checklists] rolled up ${previous}: ${summary.totals.done}/${summary.totals.total}`)
    return summary
  }
}
