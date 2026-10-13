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
const SOURCE_ICONS = {
  texts: '💬',
  mail: '📩',
  linkedin: '🔗',
  weather: '🌤',
  money: '💵',
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
const FINANCE_PLACEHOLDER = /^(?:setup|seeded|ready|ok|n\/a|none|unknown|--)?$/i
const FINANCE_SIGNAL = /[$%+\-]|\d{2,}|\d+\.\d|\b\d+(?:\.\d+)?[kmb]\b/i
const MONEY_SLOT_LABELS = {
  stackDelta: 'Stack',
  personalStock: 'Stock',
}

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

function financeDisplayLooksUseful(value) {
  const text = cleanText(value)
  if (!text || FINANCE_PLACEHOLDER.test(text)) return false
  if (/^\d$/.test(text)) return false
  return FINANCE_SIGNAL.test(text)
}

function moneySlotLabel(slot, index) {
  const id = cleanText(slot?.id)
  if (MONEY_SLOT_LABELS[id]) return MONEY_SLOT_LABELS[id]
  const label = cleanText(slot?.label, index === 0 ? 'Stack' : 'Stock')
  return label.split(' ')[0].slice(0, 8) || (index === 0 ? 'Stack' : 'Stock')
}

function moneyDisplayFromSlots(slots) {
  if (!Array.isArray(slots)) return ''
  return slots
    .map((slot, index) => {
      const display = cleanText(slot?.display).slice(0, 16)
      return financeDisplayLooksUseful(display)
        ? `${moneySlotLabel(slot, index)} ${display}`
        : ''
    })
    .filter(Boolean)
    .join(' ')
    .slice(0, 32)
}

function moneyDisplay(source, fallback = 'setup') {
  const slotDisplay = moneyDisplayFromSlots(source?.slots)
  if (slotDisplay) return slotDisplay
  const display = cleanText(source?.display)
  return financeDisplayLooksUseful(display) ? display.slice(0, 32) : fallback
}

function compactMoneyDisplay(source) {
  const slots = Array.isArray(source?.slots)
    ? source.slots
        .map(slot => cleanText(slot?.display).slice(0, 16))
        .filter(financeDisplayLooksUseful)
    : []
  if (slots.length) return slots.join('/').slice(0, 24)
  return moneyDisplay(source)
}

function sourceDisplay(source, nowMs) {
  const status = source.status === 'ok' && source.staleAt && new Date(source.staleAt).getTime() <= nowMs
    ? 'stale'
    : source.status
  if (status === 'disabled') return 'off'
  if (status === 'notConfigured') return 'setup'
  const display = source.id === 'money' ? moneyDisplay(source) : source.display
  if (status === 'error') return display && display !== 'setup' ? `${display}?` : 'err'
  if (status === 'stale') return display && display !== 'setup' ? `${display}?` : 'stale'
  return display || 'ok'
}

function displayLine(source, nowMs) {
  return `${source.label} ${sourceDisplay(source, nowMs)}`
}

function compactWeatherDisplay(display) {
  return cleanText(display)
    .replace(/(\d+)F\b/g, '$1°')
    .replace(/\bH(\d+)\b/g, '💧$1')
    .replace(/\brain ends ([^\s?]+)/, '☔→$1')
    .replace(/\brain ([^\s?]+)/, '☔$1')
    .replace(/\bno rain\b/, '☔0')
    .replace(/\brain\b/, '☔')
    .replace(/\bice\b/, '🧊')
    .replace(/\bsnow\b/, '❄')
    .replace(/\bheat\b/, '🔥')
    .replace(/\bwind\b/, '💨')
    .replace(/\bfog\b/, '🌫')
    .replace(/\s+/g, '')
    .slice(0, 24)
}

function compactSourceValue(source, nowMs) {
  const display = sourceDisplay(source, nowMs)
  if (display === 'setup') return '⚙'
  if (display === 'off') return '–'
  if (display === 'err') return '!'
  if (display === 'stale') return '?'
  if (source.id === 'weather') return compactWeatherDisplay(display)
  if (source.id === 'money') return compactMoneyDisplay(source) === 'setup' ? '⚙' : compactMoneyDisplay(source)
  return cleanText(display).slice(0, 12)
}

function compactSummaryLine(sources, nowMs) {
  return SOURCE_ORDER
    .map(id => `${SOURCE_ICONS[id]}${compactSourceValue(sources[id], nowMs)}`)
    .join(' ')
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
        line1: compactSummaryLine(sources, nowMs),
        line2: '',
        line3: '',
        asOfLabel: `@${localTimeLabel(generatedAt, this.timezone)}`,
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
    const fallbackDisplay = (() => {
      if (status === 'disabled') return 'off'
      if (status === 'notConfigured') return 'setup'
      if ((status === 'error' || status === 'stale') && base.display && base.display !== 'setup') return base.display
      if (status === 'error') return 'err'
      if (status === 'stale') return 'stale'
      if (id === 'money') return 'setup'
      return 'ok'
    })()
    const slots = id === 'money' ? (normalizeSlots(payload?.slots) ?? base.slots) : undefined
    const display = (() => {
      const cleaned = cleanText(payload?.display, fallbackDisplay).slice(0, 32)
      return id === 'money'
        ? moneyDisplay({ display: cleaned, slots }, fallbackDisplay)
        : cleaned
    })()
    const next = withoutUndefined({
      ...base,
      id,
      label: SOURCE_LABELS[id],
      status,
      kind: payload?.kind ? cleanText(payload.kind).slice(0, 32) : SOURCE_KINDS[id],
      value: ['string', 'number', 'boolean'].includes(typeof payload?.value) || payload?.value === null
        ? payload.value
        : null,
      display,
      asOf,
      staleAt,
      ttlSeconds,
      source: payload?.source ? cleanText(payload.source).slice(0, 32) : base.source,
      confidence: payload?.confidence ? cleanText(payload.confidence).slice(0, 32) : base.confidence,
      privacy: payload?.privacy ? cleanText(payload.privacy).slice(0, 32) : base.privacy,
      error: payload?.error ? cleanText(payload.error).slice(0, 80) : null,
      slots,
    })

    this.state.sources[space] = {
      ...(this.state.sources[space] ?? {}),
      [id]: next,
    }
    this.#persist()
    return { ok: true, source: next }
  }
}
