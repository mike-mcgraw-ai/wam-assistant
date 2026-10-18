import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { itemKey, itemLabel } from './vendor/wam-home/listVoice.js'

/**
 * The inbox.
 *
 * One rule: capture never fails and never asks a question. A raw line of text
 * goes in, timestamped, attributed to whoever sent it, and that is the whole
 * transaction. No category, no list to pick, no required field.
 *
 * That is not laziness — it is the thing that decides whether a shared list
 * gets used. The moment capture asks "which list?", the other person stops
 * bothering, and a to-do system nobody adds to is worse than no system.
 *
 * Sorting happens later, separately, and is allowed to fail. If triage is
 * broken or wrong, the raw line is still sitting here.
 */

export const STATUS = {
  RAW: 'raw',
  SORTED: 'sorted',
  DONE: 'done',
}

export class Inbox {
  constructor({ storePath, logPath }) {
    this.storePath = storePath
    this.logPath = logPath
    /** @type {Map<string, any>} */
    this.items = new Map()
    /** Undo journal for list changes: newest last, the last 50 kept. */
    this.changes = []
    this.#load()
  }

  #load() {
    if (!this.storePath || !existsSync(this.storePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'))
      for (const item of raw.items || []) this.items.set(item.id, item)
      this.changes = Array.isArray(raw.changes) ? raw.changes : []
      console.log(`[inbox] restored ${this.items.size} items`)
    } catch (err) {
      console.warn(`[inbox] could not read store: ${err.message}`)
    }
  }

  #persist() {
    if (!this.storePath) return
    try {
      mkdirSync(dirname(this.storePath), { recursive: true })
      // Keep completed items for a fortnight; the log holds the rest forever.
      const cutoff = Date.now() - 14 * 86400 * 1000
      const items = [...this.items.values()].filter(
        i => i.status !== STATUS.DONE || i.updatedAt > cutoff,
      )
      writeFileSync(this.storePath, JSON.stringify({ items, changes: this.changes.slice(-50) }, null, 2))
    } catch (err) {
      console.warn(`[inbox] could not write store: ${err.message}`)
    }
  }

  #log(event) {
    if (!this.logPath) return
    try {
      mkdirSync(dirname(this.logPath), { recursive: true })
      appendFileSync(this.logPath, JSON.stringify(event) + '\n')
    } catch {
      // Logging is best effort; never let it break capture.
    }
  }

  /**
   * Add a raw line. The only validation is "is there any text at all", and
   * even a duplicate is accepted — deciding two similar lines are the same
   * thing is triage's job, not capture's.
   *
   * @param {string} text what was said
   * @param {object} opts by: who added it, clientId: for dedupe on retry
   */
  add(text, { by = 'someone', clientId = null, at = Date.now() } = {}) {
    const body = String(text ?? '').trim().slice(0, 500)
    if (!body) return { ok: false, error: 'empty' }

    // An offline queue retries, so the same add can arrive twice. The client
    // stamps each one, and a repeat is a no-op rather than a duplicate item.
    if (clientId) {
      const existing = [...this.items.values()].find(i => i.clientId === clientId)
      if (existing) return { ok: true, item: existing, duplicate: true }
    }

    const item = {
      id: randomUUID(),
      clientId,
      text: body,
      by: String(by).slice(0, 24),
      createdAt: at,
      updatedAt: at,
      status: STATUS.RAW,
      /** filled in by triage; null until then, and null is a fine resting state */
      kind: null,
      list: null,
      parts: null,
      note: null,
    }

    this.items.set(item.id, item)
    this.#log({ type: 'add', id: item.id, text: body, by, at })
    this.#persist()
    return { ok: true, item }
  }

  /** Items triage has not looked at yet. */
  pending() {
    return [...this.items.values()]
      .filter(i => i.status === STATUS.RAW)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Everything still live, newest first — what the phone page shows back. */
  active(limit = 50) {
    return [...this.items.values()]
      .filter(i => i.status !== STATUS.DONE && !i.removedAt)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  }

  /** Apply a triage result. Unknown ids are ignored rather than throwing. */
  sort(id, { kind, list, parts, note }) {
    const item = this.items.get(id)
    if (!item) return { ok: false, error: 'unknown item' }
    item.kind = kind ?? item.kind
    item.list = list ?? item.list
    item.parts = parts ?? item.parts
    item.note = note ?? item.note
    item.status = STATUS.SORTED
    item.updatedAt = Date.now()
    this.#log({ type: 'sort', id, kind: item.kind, list: item.list, at: item.updatedAt })
    this.#persist()
    return { ok: true, item }
  }

  complete(id, done = true, { by = null, changeId = null } = {}) {
    const item = this.items.get(id)
    if (!item) return { ok: false, error: 'unknown item' }
    if (changeId) this.#remember(changeId, id)
    item.doneBy = done ? (by ? String(by).slice(0, 24) : item.doneBy ?? null) : null
    item.status = done ? STATUS.DONE : (item.kind || item.list ? STATUS.SORTED : STATUS.RAW)
    item.updatedAt = Date.now()
    this.#log({ type: done ? 'done' : 'reopen', id, at: item.updatedAt })
    this.#persist()
    return { ok: true, item }
  }

  // ---- household list (v0.171.0, docs/SHOPPING-LIST-SPEC.md) ----------------

  /** "2 × milk (gallon)" — what every surface shows for a list item. */
  static label(item) {
    return itemLabel(item)
  }

  /** Remember an item's state once per change, so the change can be undone. */
  #remember(changeId, itemId, created = false) {
    let change = this.changes.find(c => c.id === changeId)
    if (!change) {
      change = { id: changeId, at: Date.now(), before: [] }
      this.changes.push(change)
      if (this.changes.length > 50) this.changes.splice(0, this.changes.length - 50)
    }
    if (change.before.some(b => b.itemId === itemId)) return
    const current = this.items.get(itemId)
    change.before.push({ itemId, snapshot: created || !current ? null : JSON.parse(JSON.stringify(current)) })
  }

  /** The live item this name refers to (same item, same unit), if any. */
  findLive(name, unit = null) {
    const key = itemKey(name)
    return [...this.items.values()].find(i =>
      i.status !== STATUS.DONE && !i.removedAt && itemKey(i.name || i.text) === key && (i.unit ?? null) === (unit ?? null)) ?? null
  }

  /**
   * Add a parsed list item, or merge it into the same item already on the
   * list ("milk" twice is 2 × milk, never two rows).
   */
  addItem({ name, qty = 1, unit = null, urgent = false, raw = false, by = 'someone', via = 'kiosk', sourceText = '', list = 'Groceries', changeId = null, clientId = null, at = Date.now() } = {}) {
    const text = String(name ?? '').trim().slice(0, 120)
    if (!text) return { ok: false, error: 'empty' }
    if (clientId) {
      const existing = [...this.items.values()].find(i => i.clientId === clientId)
      if (existing) return { ok: true, item: existing, duplicate: true }
    }
    const same = raw ? null : this.findLive(text, unit)
    if (same) {
      if (changeId) this.#remember(changeId, same.id)
      same.qty = (same.qty || 1) + (qty || 1)
      if (urgent) same.urgent = true
      same.updatedAt = at
      this.#log({ type: 'merge', id: same.id, qty: same.qty, by, at })
      this.#persist()
      return { ok: true, item: same, merged: true }
    }
    const item = {
      id: randomUUID(),
      clientId,
      text,
      name: text,
      qty: qty || 1,
      unit: unit ?? null,
      urgent: Boolean(urgent),
      raw: Boolean(raw),
      taskId: null,
      by: String(by).slice(0, 24),
      via,
      sourceText: String(sourceText).slice(0, 300),
      createdAt: at,
      updatedAt: at,
      status: STATUS.SORTED,
      kind: 'shopping',
      list,
      parts: null,
      note: raw ? 'added as said' : null,
      doneBy: null,
      removedAt: null,
    }
    this.items.set(item.id, item)
    if (changeId) this.#remember(changeId, item.id, true)
    this.#log({ type: 'add', id: item.id, text, qty: item.qty, unit: item.unit, urgent: item.urgent, by, via, at })
    this.#persist()
    return { ok: true, item }
  }

  update(id, patch = {}, { changeId = null } = {}) {
    const item = this.items.get(id)
    if (!item) return { ok: false, error: 'unknown item' }
    if (changeId) this.#remember(changeId, id)
    if (patch.qty !== undefined) item.qty = Math.max(1, Math.min(99, Number(patch.qty) || 1))
    if (patch.unit !== undefined) item.unit = patch.unit
    if (patch.urgent !== undefined) item.urgent = Boolean(patch.urgent)
    if (patch.taskId !== undefined) item.taskId = patch.taskId
    if (patch.list !== undefined) item.list = String(patch.list).slice(0, 40)
    item.updatedAt = Date.now()
    this.#log({ type: 'update', id, patch, at: item.updatedAt })
    this.#persist()
    return { ok: true, item }
  }

  /** Removed is not deleted: the item leaves the list and keeps its history. */
  remove(id, { by = null, changeId = null } = {}) {
    const item = this.items.get(id)
    if (!item) return { ok: false, error: 'unknown item' }
    if (changeId) this.#remember(changeId, id)
    item.removedAt = Date.now()
    item.removedBy = by
    item.updatedAt = item.removedAt
    this.#log({ type: 'remove', id, by, at: item.removedAt })
    this.#persist()
    return { ok: true, item }
  }

  /** Put every item a change touched back the way it was. Newest change if no id. */
  undo(changeId = null) {
    const change = changeId ? this.changes.find(c => c.id === changeId) : this.changes[this.changes.length - 1]
    if (!change) return { ok: false, error: 'nothing to undo' }
    const restored = []
    for (const { itemId, snapshot } of change.before) {
      const current = this.items.get(itemId)
      if (snapshot) this.items.set(itemId, snapshot)
      else this.items.delete(itemId)
      restored.push({ itemId, before: current ?? null, after: snapshot })
    }
    this.changes = this.changes.filter(c => c !== change)
    this.#log({ type: 'undo', change: change.id, at: Date.now() })
    this.#persist()
    return { ok: true, changeId: change.id, restored }
  }

  /** Grouped for display: shopping together, tasks together, unsorted last. */
  grouped() {
    const active = this.active(200).filter(i => i.status !== STATUS.DONE)
    const groups = new Map()
    for (const item of active) {
      const key = item.list ?? (item.kind === null ? 'Unsorted' : 'Other')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }
    return [...groups.entries()]
      .map(([name, items]) => ({ name, items }))
      // Unsorted last: it is a holding pen, not a destination.
      .sort((a, b) => (a.name === 'Unsorted' ? 1 : 0) - (b.name === 'Unsorted' ? 1 : 0))
  }
}
