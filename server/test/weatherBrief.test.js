import test from 'node:test'
import assert from 'node:assert/strict'

import { MorningBrief } from '../src/morningBrief.js'
import {
  refreshWeatherBrief,
  weatherConfigFromEnv,
  weatherDisplayFromPeriod,
  weatherRefreshDelayMs,
} from '../src/sources/weather.js'

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
  }
}

function fakeNwsFetch(routes, calls = []) {
  return async (url, options) => {
    calls.push({ url: String(url), headers: options?.headers ?? {} })
    const found = routes[String(url)]
    if (!found) return response({ error: 'missing route' }, 404)
    if (found instanceof Error) throw found
    return response(found.body, found.status ?? 200)
  }
}

test('weather config stays setup until manual coordinates are present', async () => {
  const brief = new MorningBrief({ timezone: 'America/New_York' })
  const result = await refreshWeatherBrief({
    morningBrief: brief,
    env: {},
    fetchImpl: async () => {
      throw new Error('should not fetch without coordinates')
    },
  })

  assert.equal(result.ok, true)
  const snapshot = brief.snapshot({
    now: Date.UTC(2026, 9, 12, 11, 5),
    dayStatus: { day: '2026-10-12', started: false },
  })
  assert.equal(snapshot.sources.weather.status, 'notConfigured')
  assert.equal(snapshot.summary.line1, '💬⚙ 📩⚙ 🔗– 🌤⚙ 💵⚙')
})

test('weather adapter keeps seeded weather visible until coordinates are present', async () => {
  const brief = new MorningBrief({ timezone: 'America/New_York' })
  assert.equal(brief.updateSource({
    id: 'weather',
    status: 'ok',
    display: '61F',
    value: 61,
    asOf: '2026-10-13T11:00:00.000Z',
    ttlSeconds: 3600,
    source: 'manual-seed',
    confidence: 'seeded',
  }).ok, true)

  const result = await refreshWeatherBrief({
    morningBrief: brief,
    env: {},
    fetchImpl: async () => {
      throw new Error('should not fetch without coordinates')
    },
    now: Date.UTC(2026, 9, 13, 11, 5),
  })

  assert.equal(result.ok, true)
  assert.equal(result.preserved, true)
  const snapshot = brief.snapshot({
    now: Date.UTC(2026, 9, 13, 11, 5),
    dayStatus: { day: '2026-10-13', started: false },
  })
  assert.equal(snapshot.sources.weather.status, 'ok')
  assert.equal(snapshot.sources.weather.display, '61F')
  assert.equal(snapshot.sources.weather.source, 'manual-seed')
  assert.equal(snapshot.summary.line1, '💬⚙ 📩⚙ 🔗– 🌤61° 💵⚙')
})

test('weather adapter reads NWS point and hourly forecast into the brief', async () => {
  const brief = new MorningBrief({ timezone: 'America/New_York' })
  const calls = []
  const fetchImpl = fakeNwsFetch({
    'https://api.weather.gov/points/40.0000,-75.0000': {
      body: {
        properties: {
          forecastHourly: 'https://api.weather.gov/gridpoints/PHI/1,2/forecast/hourly',
        },
      },
    },
    'https://api.weather.gov/gridpoints/PHI/1,2/forecast/hourly': {
      body: {
        properties: {
          periods: [
            {
              startTime: '2026-10-12T07:00:00-04:00',
              temperature: 61,
              relativeHumidity: { value: 88 },
              probabilityOfPrecipitation: { value: 90 },
              shortForecast: 'Rain Showers',
              windSpeed: '7 mph',
            },
            {
              startTime: '2026-10-12T08:00:00-04:00',
              temperature: 62,
              relativeHumidity: { value: 86 },
              probabilityOfPrecipitation: { value: 70 },
              shortForecast: 'Rain Showers',
            },
            {
              startTime: '2026-10-12T09:00:00-04:00',
              temperature: 63,
              relativeHumidity: { value: 76 },
              probabilityOfPrecipitation: { value: 15 },
              shortForecast: 'Mostly Cloudy',
            },
          ],
        },
      },
    },
  }, calls)

  const result = await refreshWeatherBrief({
    morningBrief: brief,
    env: {
      WEATHER_LAT: '40',
      WEATHER_LON: '-75',
      WEATHER_LOCATION_LABEL: 'Home',
      WEATHER_USER_AGENT: 'WAM test',
    },
    fetchImpl,
    now: Date.UTC(2026, 9, 12, 11, 5),
  })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].headers['User-Agent'], 'WAM test')
  const snapshot = brief.snapshot({
    now: Date.UTC(2026, 9, 12, 11, 5),
    dayStatus: { day: '2026-10-12', started: false },
  })
  assert.equal(snapshot.sources.weather.status, 'ok')
  assert.equal(snapshot.sources.weather.display, '61F H88 rain ends 9a')
  assert.equal(snapshot.sources.weather.value, 61)
  assert.equal(snapshot.summary.line1, '💬⚙ 📩⚙ 🔗– 🌤61°💧88☔→9a 💵⚙')
})

test('weather adapter preserves last display when provider fails', async () => {
  const brief = new MorningBrief({ timezone: 'America/New_York' })
  assert.equal(brief.updateSource({
    id: 'weather',
    status: 'ok',
    display: '61F rain',
    value: 61,
    asOf: '2026-10-12T11:00:00.000Z',
    ttlSeconds: 3600,
    source: 'nws',
  }).ok, true)

  const result = await refreshWeatherBrief({
    morningBrief: brief,
    env: { WEATHER_LAT: '40', WEATHER_LON: '-75' },
    fetchImpl: async () => {
      throw new Error('NWS offline')
    },
    now: Date.UTC(2026, 9, 12, 11, 5),
    logger: { warn() {} },
  })

  assert.equal(result.ok, true)
  const snapshot = brief.snapshot({
    now: Date.UTC(2026, 9, 12, 11, 5),
    dayStatus: { day: '2026-10-12', started: false },
  })
  assert.equal(snapshot.sources.weather.status, 'error')
  assert.equal(snapshot.sources.weather.display, '61F rain')
  assert.equal(snapshot.summary.line1, '💬⚙ 📩⚙ 🔗– 🌤61°☔? 💵⚙')
})

test('weather display picks only decision-changing conditions', () => {
  assert.equal(weatherDisplayFromPeriod({ temperature: 72, shortForecast: 'Sunny' }), '72F')
  assert.equal(weatherDisplayFromPeriod({ temperature: 28, shortForecast: 'Freezing Rain' }), '28F ice')
  assert.equal(weatherDisplayFromPeriod({ temperature: 91, shortForecast: 'Mostly Sunny' }), '91F heat')
  assert.equal(weatherDisplayFromPeriod({ temperature: 54, shortForecast: 'Fog' }), '54F fog')
})

test('weather display includes humidity and rain start or stop timing', () => {
  const now = Date.UTC(2026, 9, 12, 11, 5)
  const dryThenRain = [
    {
      startTime: '2026-10-12T07:00:00-04:00',
      temperature: 72,
      relativeHumidity: { value: 54 },
      probabilityOfPrecipitation: { value: 5 },
      shortForecast: 'Sunny',
    },
    {
      startTime: '2026-10-12T08:00:00-04:00',
      temperature: 74,
      relativeHumidity: { value: 56 },
      probabilityOfPrecipitation: { value: 15 },
      shortForecast: 'Partly Cloudy',
    },
    {
      startTime: '2026-10-12T14:00:00-04:00',
      temperature: 69,
      relativeHumidity: { value: 82 },
      probabilityOfPrecipitation: { value: 80 },
      shortForecast: 'Rain Showers',
    },
  ]
  assert.equal(
    weatherDisplayFromPeriod(dryThenRain[0], {
      periods: dryThenRain,
      now,
      timeZone: 'America/New_York',
    }),
    '72F H54 rain 2p',
  )

  const rainingThenDry = [
    {
      startTime: '2026-10-12T07:00:00-04:00',
      temperature: 61,
      relativeHumidity: { value: 88 },
      probabilityOfPrecipitation: { value: 90 },
      shortForecast: 'Rain Showers',
    },
    {
      startTime: '2026-10-12T08:00:00-04:00',
      temperature: 64,
      relativeHumidity: { value: 70 },
      probabilityOfPrecipitation: { value: 10 },
      shortForecast: 'Mostly Cloudy',
    },
  ]
  assert.equal(
    weatherDisplayFromPeriod(rainingThenDry[0], {
      periods: rainingThenDry,
      now,
      timeZone: 'America/New_York',
    }),
    '61F H88 rain ends 8a',
  )

  const dry = [
    dryThenRain[0],
    {
      startTime: '2026-10-12T08:00:00-04:00',
      temperature: 74,
      relativeHumidity: { value: 53 },
      probabilityOfPrecipitation: { value: 10 },
      shortForecast: 'Sunny',
    },
  ]
  assert.equal(
    weatherDisplayFromPeriod(dry[0], {
      periods: dry,
      now,
      timeZone: 'America/New_York',
    }),
    '72F H54 no rain',
  )
})

test('weather config and cadence are explicit', () => {
  assert.deepEqual(weatherConfigFromEnv({ WEATHER_ENABLED: '0' }), { enabled: false, configured: true })
  assert.equal(weatherConfigFromEnv({ WEATHER_LAT: 'x', WEATHER_LON: '-75' }).error, 'invalid weather coordinates')
  assert.equal(
    weatherRefreshDelayMs({ now: new Date('2026-10-12T11:00:00Z'), timeZone: 'America/New_York', env: {} }),
    30 * 60_000,
  )
  assert.equal(
    weatherRefreshDelayMs({ now: new Date('2026-10-12T17:00:00Z'), timeZone: 'America/New_York', env: {} }),
    2 * 60 * 60_000,
  )
  assert.equal(weatherRefreshDelayMs({ env: { WEATHER_POLL_MS: '60000' } }), 60_000)
})
