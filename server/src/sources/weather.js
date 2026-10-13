const DEFAULT_TTL_SECONDS = 75 * 60
const MORNING_POLL_MS = 30 * 60_000
const OFF_HOURS_POLL_MS = 2 * 60 * 60_000

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

export function weatherDisplayFromPeriod(period) {
  const temp = Math.round(Number(period?.temperature))
  if (!Number.isFinite(temp)) throw new Error('NWS hourly forecast missing temperature')
  const condition = conditionFromPeriod(period)
  return condition ? `${temp}F ${condition}` : `${temp}F`
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

    const display = weatherDisplayFromPeriod(period)
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

