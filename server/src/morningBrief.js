import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SOURCE_ORDER = ['texts', 'mail', 'linkedin', 'weather', 'money']
const SOURCE_LABELS = {
  texts: 'Texts',
  mail: 'Mail',
  linkedin: 'LinkedIn',
  weather: 'Weather',
  money: 'Money',
}
const SOURCE_KINDS = {
  texts: 'count',
  mail: 'count',
  linkedin: 'count',
  weather: 'weather',
  money: 'finance',
}
const STATUSES = new Set(['ok', 'stale', 'notConfigured', 'disabled', 'error'])
const PRIVACY_KEY = /(?:account|acct|card|institution|routing|last[-_ ]?(?:4|four)|transaction|raw|ssn|credential|password|secret)/i
const LONG_IDENTIFIER = /\b(?:\d[ -]?){12,19}\b/

function isoTime(value, field) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be an ISO timestamp`)
  }
  return date.toISOString()
}

function cleanText(value, fallback = '') {
  return String(value ?? fallback)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function localTimeLabel(iso, timeZone) {
  const date = new Date(iso)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date)
  const hour = parts.find(part => part.type === 'hour')?.value ?? ''
  const minute = parts.find(part => part.type === 'minute')?.value ?? '00'
  const dayPeriod = (parts.find(part => part.type === 'dayPeriod')?.value ?? '').toLowerCase()
  return `${hour}:${minute}${dayPeriod.slice(0, 1)}`
}

function defaultSource(id) {
  const status = id === 'linkedin' ? 'disabled' : 'notConfigured'
  const display = status === 'disabled' ? 'off' : 'setup'
  return {
    id,
    label: SOURCE_LABELS[id],
    status,
    kind: SOURCE_KINDS[id],
    value: null,
    display,
    asOf: null,
    staleAt: null,
    ttlSeconds: null,
    source: null,
    confidence: 'unverified',
    privacy: 'countOnly',
    error: null,
    slots: id === 'money'
      ? [
          { id: 'stackDelta', label: 'Stack delta', display: 'setup', asOf: null, confidence: 'unverified' },
          { id: 'personalStock', label: 'Personal stock', display: 'setup', asOf: null, confidence: 'unverified' },
        ]
      : undefined,
  }
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
}

function scanFinancePrivacy(value, path = '') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) scanFinancePrivacy(value[i], `${path}[${i}]`)
    return
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && LONG_IDENTIFIER.test(value)) {
      throw new Error(`finance payload contains a private-looking identifier at ${path || 'value'}`)
    }
    return
  }
  for (const [key, nested] of Object.entries(value)) {
    if (PRIVACY_KEY.test(key)) {
      throw new Error(`finance payload cannot include private field "${key}"`)
    }
    scanFinancePrivacy(nested, path ? `${path}.${key}` : key)
  }
}

function normalizeSlots(slots) {
  if (!Array.isArray(slots)) return undefined
  return slots.slice(0, 2).map((slot, index) => ({
    id: cleanText(slot?.id, index === 0 ? 'stackDelta' : 'personalStock').slice(0, 32),
    label: cleanText(slot?.label, index === 0 ? 'Stack delta' : 'Personal stock').slice(0, 32),
    display: cleanText(slot?.display, 'setup').slice(0, 32),
    asOf: slot?.asOf ? isoTime(slot.asOf, `slots[${index}].asOf`) : null,
    confidence: cleanText(slot?.confidence, 'unverified').slice(0, 32),
  }))
}

function sourceDisplay(source, nowMs) {
  const status = source.status === 'ok' && source.staleAt && new Date(source.staleAt).getTime() <= nowMs
    ? 'stale'
    : source.status
  if (status === 'disabled') return 'off'
  if (status === 'notConfigured') return 'setup'
  if (status === 'error') return source.display && source.display !== 'setup' ? `${source.display}?` : 'err'
  if (status === 'stale') return source.display && source.display !== 'setup' ? `${source.display}?` : 'stale'
  return source.display || 'ok'
}

function displayLine(source, nowMs) {
  return `${source.label} ${sourceDisplay(source, nowMs)}`
}

export class MorningBrief {
  constructor({ storePath = null, timezone = 'America/New_York' } = {}) {
    this.storePath = storePath
    this.timezone = timezone
    this.state = { snapshots: {}, sources: {} }
    this.#load()
  }

  #load() {
    if (!this.storePath || !existsSync(this.storePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'))
      if (raw && typeof raw === 'object') {
        this.state.snapshots = raw.snapshots && typeof raw.snapshots === 'object' ? raw.snapshots : {}
        this.state.sources = raw.sources && typeof raw.sources === 'object' ? raw.sources : {}
      }
    } catch (err) {
      console.warn(`[brief] could not read morning brief store: ${err.message}`)
    }
  }

  #persist() {
    if (!this.storePath) return
    try {
      mkdirSync(dirname(this.storePath), { recursive: true })
      writeFileSync(this.storePath, JSON.stringify(this.state, null, 2))
    } catch (err) {
      console.warn(`[brief] could not write morning brief store: ${err.message}`)
    }
  }

  #spaceSources(space) {
    const saved = this.state.sources[space] && typeof this.state.sources[space] === 'object'
      ? this.state.sources[space]
      : {}
    return Object.fromEntries(
      SOURCE_ORDER.map(id => [id, withoutUndefined({ ...defaultSource(id), ...(saved[id] ?? {}) })]),
    )
  }

  snapshot({ space = 'life', dayStatus = null, now = Date.now() } = {}) {
    const cleanSpace = space === 'ops' ? 'ops' : 'life'
    const generatedAt = new Date(now).toISOString()
    const day = dayStatus?.day ?? generatedAt.slice(0, 10)
    const key = `${cleanSpace}:${day}`
    if (!this.state.snapshots[key]) {
      this.state.snapshots[key] = {
        space: cleanSpace,
        day,
        snapshotAt: generatedAt,
      }
      this.#persist()
    }

    const sources = this.#spaceSources(cleanSpace)
    const nowMs = new Date(generatedAt).getTime()
    for (const source of Object.values(sources)) {
      if (source.status === 'ok' && source.staleAt && new Date(source.staleAt).getTime() <= nowMs) {
        source.status = 'stale'
      }
    }

    return {
      schemaVersion: 1,
      space: cleanSpace,
      day,
      generatedAt,
      snapshotAt: this.state.snapshots[key].snapshotAt,
      mode: dayStatus?.started ? 'started' : 'morning',
      started: Boolean(dayStatus?.started),
      summary: {
        line1: `${displayLine(sources.texts, nowMs)}   ${displayLine(sources.mail, nowMs)}`,
        line2: `${displayLine(sources.linkedin, nowMs)}   ${displayLine(sources.weather, nowMs)}`,
        line3: displayLine(sources.money, nowMs),
        asOfLabel: `as of ${localTimeLabel(generatedAt, this.timezone)}`,
      },
      sources,
    }
  }

  updateSource(payload, { now = Date.now() } = {}) {
    const id = String(payload?.id ?? payload?.sourceId ?? '').trim()
    if (!SOURCE_ORDER.includes(id)) return { ok: false, error: `unknown source "${id}"` }

    const space = payload?.space === 'ops' ? 'ops' : 'life'
    const status = String(payload?.status ?? 'ok')
    if (!STATUSES.has(status)) return { ok: false, error: `bad status "${status}"` }
    if (id === 'money') {
      try {
        scanFinancePrivacy(payload)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'finance payload failed privacy scan' }
      }
    }

    const ttlSeconds = payload?.ttlSeconds === undefined || payload?.ttlSeconds === null
      ? null
      : Number(payload.ttlSeconds)
    if (status === 'ok' && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
      return { ok: false, error: 'ttlSeconds is required for ok source updates' }
    }

    let asOf = payload?.asOf ? isoTime(payload.asOf, 'asOf') : null
    if ((status === 'ok' || status === 'stale') && !asOf) {
      asOf = new Date(now).toISOString()
    }

    const base = this.#spaceSources(space)[id]
    const staleAt = status === 'ok'
      ? new Date(new Date(asOf).getTime() + ttlSeconds * 1000).toISOString()
      : null
    const next = withoutUndefined({
      ...base,
      id,
      label: SOURCE_LABELS[id],
      status,
      kind: payload?.kind ? cleanText(payload.kind).slice(0, 32) : SOURCE_KINDS[id],
      value: ['string', 'number', 'boolean'].includes(typeof payload?.value) || payload?.value === null
        ? payload.value
        : null,
      display: cleanText(payload?.display, status === 'disabled' ? 'off' : status === 'notConfigured' ? 'setup' : status === 'error' ? 'err' : 'ok').slice(0, 32),
      asOf,
      staleAt,
      ttlSeconds,
      source: payload?.source ? cleanText(payload.source).slice(0, 32) : base.source,
      confidence: payload?.confidence ? cleanText(payload.confidence).slice(0, 32) : base.confidence,
      privacy: payload?.privacy ? cleanText(payload.privacy).slice(0, 32) : base.privacy,
      error: payload?.error ? cleanText(payload.error).slice(0, 80) : null,
      slots: id === 'money' ? (normalizeSlots(payload?.slots) ?? base.slots) : undefined,
    })

    this.state.sources[space] = {
      ...(this.state.sources[space] ?? {}),
      [id]: next,
    }
    this.#persist()
    return { ok: true, source: next }
  }
}
