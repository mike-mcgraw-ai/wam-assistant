const DEFAULT_TTL_SECONDS = 75 * 60
const MORNING_POLL_MS = 30 * 60_000
const OFF_HOURS_POLL_MS = 2 * 60 * 60_000
const RAIN_LOOKAHEAD_MS = 24 * 60 * 60_000

function numberEnv(env, key) {
  if (env[key] === undefined || env[key] === '') return null
  const value = Number(env[key])
  return Number.isFinite(value) ? value : NaN
}

function cleanLabel(value) {
  return String(value ?? 'manual')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || 'manual'
}

export function weatherConfigFromEnv(env = process.env) {
  if (env.WEATHER_ENABLED === '0') return { enabled: false, configured: true }

  const lat = numberEnv(env, 'WEATHER_LAT')
  const lon = numberEnv(env, 'WEATHER_LON')
  if (lat === null && lon === null) {
    return { enabled: true, configured: false, reason: 'missing WEATHER_LAT/WEATHER_LON' }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { enabled: true, configured: false, error: 'invalid weather coordinates' }
  }

  return {
    enabled: true,
    configured: true,
    lat,
    lon,
    label: cleanLabel(env.WEATHER_LOCATION_LABEL),
    ttlSeconds: Math.max(5 * 60, Number(env.WEATHER_TTL_SECONDS) || DEFAULT_TTL_SECONDS),
    userAgent: String(env.NWS_USER_AGENT || env.WEATHER_USER_AGENT || 'WAM Morning Brief (local)').slice(0, 120),
    timeZone: cleanLabel(env.WEATHER_TIMEZONE || 'America/New_York'),
  }
}

function localMinutes(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

export function weatherRefreshDelayMs({ now = new Date(), timeZone = 'America/New_York', env = process.env } = {}) {
  const override = Number(env.WEATHER_POLL_MS)
  if (Number.isFinite(override) && override >= 60_000) return override

  const minutes = localMinutes(now, timeZone)
  return minutes >= 4 * 60 + 30 && minutes <= 10 * 60 + 30
    ? MORNING_POLL_MS
    : OFF_HOURS_POLL_MS
}

function nwsHeaders(userAgent) {
  return {
    Accept: 'application/geo+json',
    'User-Agent': userAgent,
  }
}

async function fetchJson(url, { fetchImpl = globalThis.fetch, userAgent, timeoutMs = 10_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      headers: nwsHeaders(userAgent),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`NWS ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function conditionFromPeriod(period) {
  const text = `${period?.shortForecast ?? ''} ${period?.detailedForecast ?? ''}`.toLowerCase()
  const temp = Number(period?.temperature)
  const wind = `${period?.windSpeed ?? ''} ${period?.windDirection ?? ''}`.toLowerCase()

  if (/freezing|sleet|ice|icy|frost/.test(text)) return 'ice'
  if (/snow|blizzard|flurr/.test(text)) return 'snow'
  if (/rain|shower|drizzle|thunder|storm/.test(text)) return 'rain'
  if (/fog|mist|haze/.test(text)) return 'fog'
  if (Number.isFinite(temp) && temp >= 90) return 'heat'
  if (/wind|gust/.test(text) || /\b([3-9]\d|1\d\d)\s?mph\b/.test(wind)) return 'wind'
  return ''
}

function percentValue(value) {
  const n = Number(value?.value ?? value)
  return Number.isFinite(n) ? Math.round(n) : null
}

function humidityDisplay(period) {
  const humidity = percentValue(period?.relativeHumidity)
  return humidity === null ? '' : `H${Math.max(0, Math.min(100, humidity))}`
}

function periodMs(period, field = 'startTime') {
  const ms = new Date(period?.[field]).getTime()
  return Number.isFinite(ms) ? ms : null
}

function localDateKey(value, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

function briefTimeLabel(value, { now = Date.now(), timeZone = 'America/New_York' } = {}) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date)
  const hour = parts.find(part => part.type === 'hour')?.value ?? ''
  const minute = parts.find(part => part.type === 'minute')?.value ?? '00'
  const suffix = (parts.find(part => part.type === 'dayPeriod')?.value ?? '').toLowerCase().slice(0, 1)
  const time = minute === '00' ? `${hour}${suffix}` : `${hour}:${minute}${suffix}`
  return localDateKey(date, timeZone) === localDateKey(now, timeZone) ? time : `tom ${time}`
}

function rainLikely(period) {
  const condition = conditionFromPeriod(period)
  const text = `${period?.shortForecast ?? ''} ${period?.detailedForecast ?? ''}`.toLowerCase()
  const chance = percentValue(period?.probabilityOfPrecipitation)
  if (condition === 'rain') return true
  if (/rain|shower|drizzle|thunder|storm/.test(text)) return true
  return chance !== null && chance >= 50 && !/snow|ice|sleet|freezing/.test(text)
}

function rainTimingDisplay(periods, { now = Date.now(), timeZone = 'America/New_York' } = {}) {
  if (!Array.isArray(periods) || periods.length < 2) return ''
  const currentStart = periodMs(periods[0]) ?? new Date(now).getTime()
  const maxStart = currentStart + RAIN_LOOKAHEAD_MS
  const upcoming = periods.filter(period => {
    const start = periodMs(period)
    return start === null || start <= maxStart
  })

  if (rainLikely(upcoming[0])) {
    const end = upcoming.find((period, index) => index > 0 && !rainLikely(period))
    const endLabel = briefTimeLabel(end?.startTime, { now, timeZone })
    return endLabel ? `rain ends ${endLabel}` : 'rain now'
  }

  const next = upcoming.find((period, index) => index > 0 && rainLikely(period))
  const nextLabel = briefTimeLabel(next?.startTime, { now, timeZone })
  return nextLabel ? `rain ${nextLabel}` : 'no rain'
}

export function weatherDisplayFromPeriod(period, { periods = null, now = Date.now(), timeZone = 'America/New_York' } = {}) {
  const temp = Math.round(Number(period?.temperature))
  if (!Number.isFinite(temp)) throw new Error('NWS hourly forecast missing temperature')
  const condition = conditionFromPeriod(period)
  const parts = [`${temp}F`]
  const humidity = humidityDisplay(period)
  if (humidity) parts.push(humidity)
  if (condition && condition !== 'rain') parts.push(condition)
  const rainTiming = rainTimingDisplay(periods, { now, timeZone })
  if (rainTiming) parts.push(rainTiming)
  else if (condition === 'rain') parts.push('rain')
  return parts.join(' ')
}

function currentWeatherSource(morningBrief) {
  try {
    return morningBrief.snapshot({ space: 'life' }).sources.weather
  } catch {
    return null
  }
}

function errorDisplay(current) {
  return current?.display && current.display !== 'setup' && current.display !== 'err'
    ? current.display
    : 'err'
}

function preserveWithoutCoordinates(current) {
  return current
    && ['ok', 'stale'].includes(current.status)
    && current.source
    && current.source !== 'nws'
    && current.display
    && current.display !== 'setup'
}

export async function refreshWeatherBrief({
  morningBrief,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  logger = console,
} = {}) {
  if (!morningBrief) throw new Error('morningBrief is required')
  const config = weatherConfigFromEnv(env)

  if (!config.enabled) {
    return morningBrief.updateSource({
      id: 'weather',
      status: 'disabled',
      display: 'off',
      source: 'nws',
      confidence: 'disabled',
    }, { now })
  }

  if (!config.configured) {
    const current = currentWeatherSource(morningBrief)
    if (!config.error && preserveWithoutCoordinates(current)) {
      return { ok: true, source: current, preserved: true }
    }
    return morningBrief.updateSource({
      id: 'weather',
      status: config.error ? 'error' : 'notConfigured',
      display: config.error ? 'err' : 'setup',
      source: 'nws',
      confidence: 'unverified',
      error: config.error ?? config.reason,
    }, { now })
  }

  try {
    const coords = `${config.lat.toFixed(4)},${config.lon.toFixed(4)}`
    const point = await fetchJson(`https://api.weather.gov/points/${coords}`, {
      fetchImpl,
      userAgent: config.userAgent,
    })
    const hourlyUrl = point?.properties?.forecastHourly
    if (!hourlyUrl) throw new Error('NWS point lookup missing hourly forecast')

    const hourly = await fetchJson(hourlyUrl, {
      fetchImpl,
      userAgent: config.userAgent,
    })
    const period = hourly?.properties?.periods?.[0]
    if (!period) throw new Error('NWS hourly forecast has no periods')

    const display = weatherDisplayFromPeriod(period, {
      periods: hourly.properties.periods,
      now,
      timeZone: config.timeZone,
    })
    return morningBrief.updateSource({
      id: 'weather',
      status: 'ok',
      kind: 'weather',
      value: Math.round(Number(period.temperature)),
      display,
      asOf: period.startTime || new Date(now).toISOString(),
      ttlSeconds: config.ttlSeconds,
      source: 'nws',
      confidence: 'live',
      privacy: 'locationApprox',
    }, { now })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'weather refresh failed'
    logger?.warn?.(`[weather] ${message}`)
    const current = currentWeatherSource(morningBrief)
    return morningBrief.updateSource({
      id: 'weather',
      status: 'error',
      display: errorDisplay(current),
      asOf: current?.asOf ?? null,
      source: 'nws',
      confidence: current?.confidence ?? 'unverified',
      error: message,
    }, { now })
  }
}
