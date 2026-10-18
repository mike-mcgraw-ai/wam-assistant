/**
 * Apply parsed list speech to the household list (v0.171.0).
 *
 * listVoice.js decides what was asked; this does it, once, against the inbox
 * store, and returns what changed so the kiosk can show it, say it, and undo
 * it. Urgent items also become a Home task (Mike, 2026-10-18): the link is
 * `item.taskId`, and finishing either one finishes both.
 */
import { randomUUID } from 'node:crypto'
import { Inbox } from './inbox.js'
import { confirmationText, spokenLabel } from './listVoice.js'

/**
 * Keep the urgent link true after an undo, both ways: a task whose link the
 * undo removed is closed; an urgent item the undo brought back onto the list
 * (from checked off, removed or cleared) gets its Home task reopened.
 */
export function relinkAfterUndo(restored, { closeTask, reopenTask }) {
  for (const { before, after } of restored) {
    if (before?.taskId && before.taskId !== after?.taskId) closeTask?.(before.taskId)
    const backOnList = after && after.status !== 'done' && !after.removedAt
    const wasOff = before && (before.status === 'done' || before.removedAt)
    if (after?.taskId && after.urgent && backOnList && wasOff) reopenTask?.(after.taskId)
  }
}

/**
 * @param {object} deps
 * @param {import('./inbox.js').Inbox} deps.inbox
 * @param {(item: object) => string|null} deps.openUrgentTask  create + pin a Home task, return its id
 * @param {(taskId: string) => void} deps.closeTask            mark a linked task done
 */
export function applyListSpeech(ops, { inbox, by = 'Household', via = 'kiosk-voice', changeId = `chg-${randomUUID()}`, openUrgentTask, closeTask, reopenTask }) {
  const applied = []
  const label = item => Inbox.label(item)
  const makeUrgent = item => {
    if (item.taskId) return
    const taskId = openUrgentTask?.(item) ?? null
    if (taskId) inbox.update(item.id, { taskId }, { changeId })
  }

  for (const op of ops) {
    if (op.type === 'undo') {
      const undone = inbox.undo()
      if (!undone.ok) { applied.push({ type: 'missing', label: 'anything to undo' }); continue }
      relinkAfterUndo(undone.restored, { closeTask, reopenTask })
      applied.push({ type: 'undo', label: 'last change', changeId: undone.changeId })
      continue
    }
    if (op.type === 'clear') {
      applied.push({ type: 'clear', label: 'the list', pending: true })
      continue
    }
    if (op.type === 'add') {
      const out = inbox.addItem({ name: op.name, qty: op.qty, unit: op.unit, urgent: op.urgent, raw: op.raw, by, via, sourceText: op.text, changeId })
      if (!out.ok) continue
      if (out.item.urgent) makeUrgent(out.item)
      applied.push({
        type: out.merged ? 'merge' : 'add',
        label: op.raw ? `"${out.item.name}"` : label(out.item),
        spoken: op.raw ? out.item.name : spokenLabel(out.merged ? out.item : { name: out.item.name, qty: op.qty, unit: op.unit }),
        id: out.item.id,
        raw: Boolean(op.raw),
      })
      if (op.urgent) applied.push({ type: 'urgent', label: out.item.name, id: out.item.id })
      continue
    }
    const item = op.itemId ? inbox.items.get(op.itemId) : null
    if (!item) { applied.push({ type: 'missing', label: op.name }); continue }
    if (op.type === 'done') {
      inbox.complete(item.id, true, { by, changeId })
      if (item.taskId) closeTask?.(item.taskId)
      applied.push({ type: 'done', label: item.name, id: item.id })
    } else if (op.type === 'remove') {
      inbox.remove(item.id, { by, changeId })
      if (item.taskId) closeTask?.(item.taskId)
      applied.push({ type: 'remove', label: item.name, id: item.id })
    } else if (op.type === 'qty') {
      const qty = op.delta ? (item.qty || 1) + op.delta : op.qty
      inbox.update(item.id, { qty, ...(op.unit !== undefined ? { unit: op.unit } : {}) }, { changeId })
      applied.push({ type: 'qty', label: label(item), spoken: spokenLabel(item), id: item.id })
    } else if (op.type === 'urgent') {
      inbox.update(item.id, { urgent: true }, { changeId })
      makeUrgent(item)
      applied.push({ type: 'urgent', label: item.name, id: item.id })
    }
  }
  return { changeId, applied, say: confirmationText(applied) }
}
