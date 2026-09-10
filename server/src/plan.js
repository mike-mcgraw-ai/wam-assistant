/**
 * Block planner.
 *
 * The question: "I have 60 minutes — what can I actually get done?"
 *
 * Each chore is a chain of steps that alternate between needing you (`do`) and
 * needing only the clock (`wait`). You are the single scarce resource: one
 * `do` at a time. Waits are free and run in parallel with everything else.
 *
 * That makes this a single-machine scheduling problem with chain precedence
 * and fixed delays. Optimal makespan is NP-hard in general, but the real
 * instances here are tiny — a handful of chores, a handful of steps — and the
 * greedy rule below gets the thing that actually matters right: start the long
 * waits as early as possible, because a wash cycle you kick off at minute 4
 * finishes half an hour sooner than one you kick off at minute 34.
 */

/** Priority: the do-step that unlocks the longest wait goes first. */
function lookaheadWait(steps, index) {
  const next = steps[index + 1]
  return next && next.stepKind === 'wait' ? next.ms : 0
}

/**
 * @param {Array} chores  [{ id, name, steps: [{id,label,stepKind,ms,measured}], startIndex?, readyAt? }]
 *   startIndex / readyAt describe work already underway — a wash with 12
 *   minutes left is startIndex at the step after it, readyAt 12 minutes out.
 * @param {number} minutes  horizon to schedule out to. Default is long on
 *   purpose: the useful output is one continuous ordered list you read down as
 *   far as your time allows, not a plan truncated to a window someone picked
 *   in advance.
 */
export function planBlock(chores, minutes = 720) {
  const budget = minutes * 60_000

  const state = chores.map(chore => ({
    id: chore.id,
    name: chore.name,
    steps: chore.steps,
    index: chore.startIndex ?? 0,
    readyAt: chore.readyAt ?? 0,
    scheduled: 0,
    blocked: false,
  }))

  const timeline = []
  let clock = 0
  let busyMs = 0

  /**
   * Waits need nothing from you, so a chore that has reached one advances
   * through it on its own the moment it becomes reachable.
   */
  const advanceWaits = () => {
    for (const chore of state) {
      while (chore.index < chore.steps.length && chore.steps[chore.index].stepKind === 'wait') {
        const step = chore.steps[chore.index]
        const start = chore.readyAt
        timeline.push({
          at: start,
          endsAt: start + step.ms,
          choreId: chore.id,
          chore: chore.name,
          stepId: step.id,
          step: step.label,
          stepIndex: chore.index + 1,
          stepTotal: chore.steps.length,
          stepKind: 'wait',
          ms: step.ms,
          measured: step.measured,
          /** true when the wait is still running when the block ends */
          overruns: start + step.ms > budget,
        })
        chore.readyAt = start + step.ms
        chore.index += 1
        chore.scheduled += 1
      }
    }
  }

  advanceWaits()

  // Guard against a pathological config looping forever; every pass either
  // schedules a step or moves the clock, so this is a backstop, not a limit.
  for (let guard = 0; guard < 1000; guard += 1) {
    if (clock >= budget) break

    const ready = state.filter(
      c => !c.blocked && c.index < c.steps.length && c.readyAt <= clock,
    )

    if (ready.length === 0) {
      // Nothing to do right now. Jump to whenever the next chore frees up —
      // that gap is time you genuinely cannot fill from this list.
      const next = state
        .filter(c => !c.blocked && c.index < c.steps.length)
        .map(c => c.readyAt)
        .sort((a, b) => a - b)[0]
      if (next === undefined || next >= budget) break
      clock = next
      continue
    }

    ready.sort((a, b) => {
      const waitA = lookaheadWait(a.steps, a.index)
      const waitB = lookaheadWait(b.steps, b.index)
      if (waitA !== waitB) return waitB - waitA
      return a.steps[a.index].ms - b.steps[b.index].ms
    })

    const chore = ready[0]
    const step = chore.steps[chore.index]

    if (clock + step.ms > budget) {
      // Does not fit in what is left. Park this chore and see whether a
      // shorter step from another one does.
      chore.blocked = true
      continue
    }

    timeline.push({
      at: clock,
      endsAt: clock + step.ms,
      choreId: chore.id,
      chore: chore.name,
      stepId: step.id,
      step: step.label,
      stepIndex: chore.index + 1,
      stepTotal: chore.steps.length,
      stepKind: 'do',
      ms: step.ms,
      measured: step.measured,
      overruns: false,
    })

    clock += step.ms
    busyMs += step.ms
    chore.readyAt = clock
    chore.index += 1
    chore.scheduled += 1

    advanceWaits()
  }

  timeline.sort((a, b) => a.at - b.at)

  const progress = state.map(chore => {
    const doneWithin = chore.steps.filter((_, i) => i < chore.index).length
    const finishesAt = chore.index >= chore.steps.length ? chore.readyAt : null
    return {
      choreId: chore.id,
      name: chore.name,
      stepsDone: doneWithin,
      total: chore.steps.length,
      complete: chore.index >= chore.steps.length,
      /** may land past the end of the block: laundry keeps washing */
      finishesAt,
      stoppedAt: chore.steps[chore.index]?.label ?? null,
    }
  })

  return {
    minutes,
    budgetMs: budget,
    timeline,
    busyMs,
    /** time inside the block with nothing from this list to do */
    idleMs: Math.max(0, budget - busyMs),
    progress,
  }
}

/**
 * How far a single chore gets in a window, run on its own.
 * This is what turns "laundry is 28 minutes" into "in 30 minutes you get
 * 2 of 6 steps done" — which is the honest answer for anything with a
 * machine in the middle of it.
 */
export function reach(chore, minutes) {
  const plan = planBlock([chore], minutes)
  const p = plan.progress[0]
  return { stepsDone: p.stepsDone, total: p.total, complete: p.complete, stoppedAt: p.stoppedAt }
}


/**
 * The plan as one ordered list you can read top to bottom.
 *
 * Only `do` steps are actionable, so those are the rows. The gaps between them
 * are shown too, annotated with whatever is running — a 32-minute hole while
 * the washer goes is not dead time to hide, it is the most useful thing on the
 * screen. You stop reading wherever your available time runs out.
 */
export function agenda(plan, unestimated = []) {
  const dos = plan.timeline.filter(t => t.stepKind === 'do').sort((a, b) => a.at - b.at)
  const waits = plan.timeline.filter(t => t.stepKind === 'wait')

  const rows = []
  let clock = 0

  // Only the earliest remaining step of each chore can actually be started.
  // Everything after it is reachable only by doing the ones above it first,
  // and a list that does not say so invites picking a row you cannot do.
  const firstOpen = new Map()
  for (const step of dos) {
    if (!firstOpen.has(step.choreId)) firstOpen.set(step.choreId, step.stepId)
  }

  for (const step of dos) {
    if (step.at > clock) {
      // Name what is running and when the earliest of them frees up: that is
      // the moment the next row becomes doable, and it is why the gap exists.
      const running = waits.filter(w => w.at <= clock && w.endsAt > clock + 1)
      const soonest = running.slice().sort((a, b) => a.endsAt - b.endsAt)[0]
      rows.push({
        kind: 'gap',
        at: clock,
        ms: step.at - clock,
        running: [...new Set(running.map(w => w.chore))],
        /** the wait that ends first, i.e. what you are actually waiting on */
        nextFree: soonest
          ? { chore: soonest.chore, step: soonest.step, endsAt: soonest.endsAt }
          : null,
      })
    }

    rows.push({
      kind: 'do',
      at: step.at,
      endsAt: step.endsAt,
      ms: step.ms,
      chore: step.chore,
      choreId: step.choreId,
      step: step.step,
      stepId: step.stepId,
      stepIndex: step.stepIndex,
      stepTotal: step.stepTotal,
      measured: step.measured,
      /** false when an earlier step of the same chore has to happen first */
      open: firstOpen.get(step.choreId) === step.stepId,
      cumulativeBusyMs: 0,
    })
    clock = step.endsAt
  }

  let busy = 0
  for (const row of rows) {
    if (row.kind === 'do') {
      busy += row.ms
      row.cumulativeBusyMs = busy
    }
  }

  /**
   * Anything without a time estimate goes at the end, listed rather than
   * scheduled. Guessing a duration would corrupt the running total that the
   * "what fits in the time I have" question depends on — but hiding it means
   * the awkward jobs quietly disappear, which is worse.
   */
  for (const chore of unestimated) {
    const step = chore.steps[chore.startIndex ?? 0]
    if (!step) continue
    rows.push({
      kind: 'do',
      at: null,
      endsAt: null,
      ms: null,
      chore: chore.name,
      choreId: chore.id,
      step: step.label,
      stepId: step.id,
      stepIndex: (chore.startIndex ?? 0) + 1,
      stepTotal: chore.steps.length,
      measured: false,
      open: true,
      cumulativeBusyMs: null,
      estimated: false,
    })
  }

  return rows
}
