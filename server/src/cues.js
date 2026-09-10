import { createHash } from 'node:crypto'

const LINE = 44
const DEFAULT_INTERVAL_MS = 2 * 60_000

function clip(text, max = LINE) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function hash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

function mins(ms) {
  if (ms === null || ms === undefined) return '--'
  const total = Math.round(ms / 60_000)
  if (total < 60) return `${total}m`
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}`
}

function inSpace(value, space) {
  return value === undefined || value === null || value === space
}

function spaceLabel(space) {
  return space === 'ops' ? 'Ops' : 'Life'
}

function activeRuns(checklistsState, space) {
  return (checklistsState?.active ?? []).filter(run => !run.complete && inSpace(run.space, space))
}

function currentItem(run) {
  return run.items.find(item => item.id === run.currentItemId) ?? run.items.find(item => !item.done)
}

function dueWaitInSpace(wait, runs) {
  const run = runs.find(item => item.runId === wait.runId)
  if (!run) return null
  return { ...wait, run }
}

function inboxCount(groups) {
  return (groups ?? []).reduce((sum, group) => sum + (group.items?.length ?? 0), 0)
}

function firstAgendaRow(plan) {
  return (
    plan?.agenda?.find(row => row.kind === 'do' && row.open) ??
    plan?.agenda?.find(row => row.kind === 'do') ??
    null
  )
}

function taskNote(task) {
  const note = task?.notes?.at?.(-1)?.text || task?.note || ''
  return clip(note, 38)
}

function boardAlert(snapshot, space) {
  return (snapshot?.boards ?? []).find(board => inSpace(board.space, space) && board.status !== 'ok')
}

function lineSet(title, lines, { kind = 'recap', priority = 1, quiet = false } = {}) {
  return { title: clip(title, 30), lines: lines.map(line => clip(line)).filter(Boolean), kind, priority, quiet }
}

export function buildCue({
  space = 'life',
  snapshot,
  plan,
  checklistsState,
  inboxGroups,
  dueWaits = [],
  jobsSummary,
  now = Date.now(),
  intervalMs = DEFAULT_INTERVAL_MS,
} = {}) {
  const runs = activeRuns(checklistsState, space)
  const due = dueWaits.map(wait => dueWaitInSpace(wait, runs)).filter(Boolean)
  const label = spaceLabel(space)

  let cue

  if (due.length > 0) {
    const wait = due[0]
    const late = Math.max(0, Math.round((now - wait.endsAt) / 60_000))
    cue = lineSet(
      'Reminder due',
      [
        `${wait.name}: ${wait.label}`,
        late >= 2 ? `${late}m late` : 'Ready now',
        due.length > 1 ? `${due.length - 1} more wait due` : '',
      ],
      { kind: 'reminder', priority: 4 },
    )
  }

  if (!cue) {
    const longRun = runs
      .flatMap(run => run.items.map(item => ({ run, item })))
      .find(({ item }) => item.suspect)
    if (longRun) {
      cue = lineSet(
        'Check this timer',
        [
          `${longRun.run.name}: ${longRun.item.label}`,
          `${mins(longRun.item.elapsedMs)} running`,
          'Click the row to reset if it is bogus.',
        ],
        { kind: 'reminder', priority: 4 },
      )
    }
  }

  if (!cue) {
    const alert = boardAlert(snapshot, space)
    if (alert) {
      cue = lineSet(
        `${label} alert`,
        [`${alert.name}: ${alert.summary || alert.status}`, alert.metrics?.[0]?.note || 'Open the board for detail.'],
        { kind: 'ops', priority: 3 },
      )
    }
  }

  if (!cue) {
    const run = runs.find(item => currentItem(item))
    const item = run ? currentItem(run) : null
    if (run && item) {
      const right =
        item.stepKind === 'wait' && item.remainingSeconds !== null
          ? item.remainingSeconds <= 0
            ? 'DUE'
            : `${Math.ceil(item.remainingSeconds / 60)}m left`
          : item.running
            ? `${mins(item.elapsedMs)} in`
            : item.estimateMinutes
              ? `~${item.estimateMinutes}m`
              : ''
      cue = lineSet(
        'Next step',
        [`${run.name}: ${item.label}`, right, `${run.done}/${run.total} done`],
        { kind: 'recap', priority: 2 },
      )
    }
  }

  if (!cue) {
    const task = (plan?.tasks ?? []).find(item => item.open) ?? plan?.tasks?.[0]
    if (task) {
      const when = task.opensLabel ? `opens ${task.opensLabel}` : task.ms === null ? 'no estimate' : mins(task.ms)
      cue = lineSet(
        'Task in view',
        [task.label, when, taskNote(task)],
        { kind: 'task', priority: 2 },
      )
    }
  }

  if (!cue) {
    const count = inboxCount(inboxGroups)
    if (count > 0) {
      const first = (inboxGroups ?? []).find(group => group.items?.length)
      cue = lineSet(
        'Shared list',
        [`${count} item${count === 1 ? '' : 's'} open`, first ? `${first.name}: ${first.items.length}` : ''],
        { kind: 'list', priority: 1 },
      )
    }
  }

  if (!cue) {
    const row = firstAgendaRow(plan)
    if (row) {
      const state = row.open ? 'ready' : 'blocked'
      cue = lineSet(
        `${label} recap`,
        [`Next ${state}: ${row.chore}`, row.step, `${mins(row.ms)} work, ${mins(row.cumulativeWallMs)} wall`],
        { kind: 'recap', priority: 1 },
      )
    }
  }

  if (!cue) {
    const jobCount = Number(jobsSummary?.queued ?? 0) + Number(jobsSummary?.claimed ?? 0)
    cue = lineSet(
      `${label} clear`,
      [jobCount > 0 ? `${jobCount} background job${jobCount === 1 ? '' : 's'}` : 'Nothing pressing right now.'],
      { kind: 'recap', priority: 0, quiet: true },
    )
  }

  const interval = Math.max(30_000, Number(intervalMs) || DEFAULT_INTERVAL_MS)
  const bucket = Math.floor(now / interval)
  const basis = `${space}:${bucket}:${cue.kind}:${cue.title}:${cue.lines.join('|')}`
  const id = hash(basis)

  return {
    id,
    ...cue,
    createdAt: now,
    expiresAt: (bucket + 1) * interval,
    nextAfterMs: Math.max(5_000, (bucket + 1) * interval - now),
  }
}
