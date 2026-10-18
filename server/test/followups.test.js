import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Followups, LEAD_DAYS, addDays, daysBetween, reminderText } from '../src/followups.js'

test('calendar arithmetic is by day and rejects impossible dates', () => {
  assert.equal(daysBetween('2026-10-17', '2026-10-28'), 11)
  assert.equal(daysBetween('2026-10-28', '2026-10-17'), -11)
  assert.equal(daysBetween('2026-10-17', '2026-11-01'), 15) // across the DST change
  assert.equal(addDays('2026-10-28', -7), '2026-10-21')
  assert.equal(daysBetween('2026-10-17', '2026-02-31'), null)
})

test('a follow-up stays hidden until 7 days before its day, then sits on Home until done', () => {
  const f = new Followups()
  const { followup } = f.add({ label: 'Doctor appointment', dueDay: '2026-10-28', taskId: 'text-my-doctor' }, 1)
  assert.equal(LEAD_DAYS, 7)
  assert.deepEqual(f.visible('2026-10-20').map(x => x.id), [], '8 days out: hidden')
  assert.deepEqual(f.visible('2026-10-21').map(x => [x.label, x.daysLeft]), [['Doctor appointment', 7]])
  assert.equal(f.visible('2026-10-28')[0].daysLeft, 0)
  assert.equal(f.visible('2026-10-30')[0].daysLeft, -2, 'overdue stays')

  // Ticked: visible (done) for the rest of that day so it can be undone, then gone.
  f.setDone(followup.id, true, '2026-10-28', 2)
  assert.deepEqual(f.visible('2026-10-28').map(x => [x.id, x.done]), [[followup.id, true]])
  assert.deepEqual(f.visible('2026-10-29'), [])
  f.setDone(followup.id, false, '2026-10-29', 3)
  assert.equal(f.visible('2026-10-29')[0].done, false)
})

test('reminders: once when it comes into view, once on the day, never after done', () => {
  const f = new Followups()
  const { followup } = f.add({ label: 'Doctor appointment', dueDay: '2026-10-28' }, 1)
  assert.deepEqual(f.remindersDue('2026-10-20'), [])
  assert.deepEqual(f.remindersDue('2026-10-21').map(r => [r.kind, r.days]), [['lead', 7]])
  f.markReminded(followup.id, 'lead', 2)
  assert.deepEqual(f.remindersDue('2026-10-22'), [])
  assert.deepEqual(f.remindersDue('2026-10-28').map(r => r.kind), ['due'])
  f.markReminded(followup.id, 'due', 3)
  assert.deepEqual(f.remindersDue('2026-10-29'), [])

  // Moving the date makes both reminders owed again.
  f.update(followup.id, { dueDay: '2026-11-03' }, 4)
  assert.deepEqual(f.remindersDue('2026-10-29').map(r => r.kind), ['lead'])
  f.setDone(followup.id, true, '2026-10-29', 5)
  assert.deepEqual(f.remindersDue('2026-11-03'), [])

  assert.equal(reminderText({ item: { label: 'Vet', dueDay: '2026-10-28' }, days: 7 }), 'Vet — in 7 days (Oct 28)')
  assert.equal(reminderText({ item: { label: 'Vet', dueDay: '2026-10-28' }, days: 0 }), 'Vet — today')
  assert.equal(reminderText({ item: { label: 'Vet', dueDay: '2026-10-28' }, days: -1 }), 'Vet — 1 day late (Oct 28)')
})

test('validation, idempotent create, delete, and persistence across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wam-followups-'))
  try {
    const storePath = join(dir, 'followups.json')
    const f = new Followups({ storePath, logPath: join(dir, 'followups.jsonl') })
    assert.equal(f.add({ label: '', dueDay: '2026-10-28' }).ok, false)
    assert.equal(f.add({ label: 'X', dueDay: '10/28' }).ok, false)
    const first = f.add({ label: 'Doctor appointment', dueDay: '2026-10-28', clientId: 'tap-1' })
    const retry = f.add({ label: 'Doctor appointment', dueDay: '2026-10-28', clientId: 'tap-1' })
    assert.equal(retry.duplicate, true)
    assert.equal(retry.followup.id, first.followup.id)
    const other = f.add({ label: 'Vet checkup', dueDay: '2026-10-25' })
    f.remove(other.followup.id)

    const again = new Followups({ storePath })
    assert.deepEqual(again.list().map(x => x.label), ['Doctor appointment'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
