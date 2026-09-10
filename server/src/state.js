import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * In-memory metric store with disk persistence.
 *
 * Values are whatever a source sends (number or short string). Status is derived
 * on read, never stored, so a metric goes stale on its own with no cron job:
 * if nothing has written to it inside its ttlSeconds it reports `stale`.
 */

const STATUS_RANK = { ok: 0, stale: 1, warn: 2, alert: 3 }

export class Store {
  /**
   * @param {object} config parsed boards.config.json
   * @param {string} persistPath where to snapshot values
   */
  constructor(config, persistPath) {
    this.config = config
    this.persistPath = persistPath
    /** @type {Map<string, {value: any, at: number, source: string, note?: string}>} */
    this.values = new Map()
    this.index = new Map()

    for (const board of config.boards) {
      for (const metric of board.metrics) {
        if (this.index.has(metric.id)) {
          throw new Error(`Duplicate metric id "${metric.id}" — ids must be unique across all boards`)
        }
        this.index.set(metric.id, { board, metric })
      }
    }

    this.#load()
  }

  #load() {
    if (!this.persistPath || !existsSync(this.persistPath)) return
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8'))
      for (const [id, entry] of Object.entries(raw)) {
        // Drop values for metrics no longer in the config.
        if (this.index.has(id)) this.values.set(id, entry)
      }
      console.log(`[store] restored ${this.values.size} values from ${this.persistPath}`)
    } catch (err) {
      console.warn(`[store] could not read ${this.persistPath}: ${err.message}`)
    }
  }

  #persist() {
    if (!this.persistPath) return
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true })
      writeFileSync(this.persistPath, JSON.stringify(Object.fromEntries(this.values), null, 2))
    } catch (err) {
      console.warn(`[store] could not write ${this.persistPath}: ${err.message}`)
    }
  }

  knows(metricId) {
    return this.index.has(metricId)
  }

  /**
   * Record a metric value.
   * @returns {{ok: true} | {ok: false, error: string}}
   */
  set(metricId, value, { source = 'unknown', note = '', at = Date.now() } = {}) {
    if (!this.index.has(metricId)) {
      return { ok: false, error: `unknown metric "${metricId}"` }
    }
    if (value === null || value === undefined || value === '') {
      return { ok: false, error: 'value is required' }
    }
    const num = typeof value === 'number' ? value : Number(String(value).trim())
    const stored = Number.isFinite(num) ? num : String(value).trim().slice(0, 24)

    this.values.set(metricId, { value: stored, at, source, note: String(note || '').slice(0, 60) })
    this.#persist()
    return { ok: true }
  }

  /** Evaluate one threshold rule against a value. */
  #breaches(rule, value) {
    if (!rule) return false
    const num = typeof value === 'number' ? value : Number(value)
    const hasNum = Number.isFinite(num)

    if ('gt'  in rule) return hasNum && num >  rule.gt
    if ('gte' in rule) return hasNum && num >= rule.gte
    if ('lt'  in rule) return hasNum && num <  rule.lt
    if ('lte' in rule) return hasNum && num <= rule.lte
    if ('eq'  in rule) return String(value) === String(rule.eq)
    if ('neq' in rule) return String(value) !== String(rule.neq)
    if ('outside' in rule) {
      const [lo, hi] = rule.outside
      return hasNum && (num < lo || num > hi)
    }
    return false
  }

  #statusFor(metric, entry, now) {
    if (!entry) return 'stale'
    const ttl = (metric.ttlSeconds ?? 900) * 1000
    if (now - entry.at > ttl) return 'stale'

    const t = metric.thresholds
    if (t) {
      if (this.#breaches(t.alert, entry.value)) return 'alert'
      if (this.#breaches(t.warn, entry.value)) return 'warn'
    }
    return 'ok'
  }

  /**
   * Full snapshot, shaped for the glasses client.
   * Boards and metrics are sorted worst-status-first so the thing that needs
   * attention is on the first line, not three scrolls down.
   */
  snapshot(now = Date.now()) {
    const boards = this.config.boards.map(board => {
      const metrics = board.metrics.map(metric => {
        const entry = this.values.get(metric.id)
        const status = this.#statusFor(metric, entry, now)
        return {
          id: metric.id,
          label: metric.label,
          unit: metric.unit ?? '',
          value: entry ? entry.value : null,
          status,
          ageSeconds: entry ? Math.round((now - entry.at) / 1000) : null,
          source: entry ? entry.source : null,
          note: entry?.note || '',
        }
      })

      metrics.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])

      const counts = metrics.reduce((acc, m) => {
        acc[m.status] = (acc[m.status] || 0) + 1
        return acc
      }, {})

      const worst = metrics.reduce(
        (w, m) => (STATUS_RANK[m.status] > STATUS_RANK[w] ? m.status : w),
        'ok',
      )

      return {
        id: board.id,
        name: board.name,
        // 'ops' or 'life'; the glasses show one space at a time.
        space: board.space ?? 'ops',
        status: worst,
        counts,
        summary: summarize(counts, metrics.length),
        metrics,
      }
    })

    boards.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])

    return { generatedAt: new Date(now).toISOString(), boards }
  }
}

function summarize(counts, total) {
  const parts = []
  if (counts.alert) parts.push(`${counts.alert} alert`)
  if (counts.warn) parts.push(`${counts.warn} warn`)
  if (counts.stale) parts.push(`${counts.stale} stale`)
  return parts.length ? parts.join(', ') : `${total} ok`
}
