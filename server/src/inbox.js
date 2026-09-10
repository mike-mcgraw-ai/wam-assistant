import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

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
    this.#load()
  }

  #load() {
    if (!this.storePath || !existsSync(this.storePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'))
      for (const item of raw.items || []) this.items.set(item.id, item)
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
      writeFileSync(this.storePath, JSON.stringify({ items }, null, 2))
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
      .filter(i => i.status !== STATUS.DONE)
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

  complete(id, done = true) {
    const item = this.items.get(id)
    if (!item) return { ok: false, error: 'unknown item' }
    item.status = done ? STATUS.DONE : STATUS.SORTED
    item.updatedAt = Date.now()
    this.#log({ type: done ? 'done' : 'reopen', id, at: item.updatedAt })
    this.#persist()
    return { ok: true, item }
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
