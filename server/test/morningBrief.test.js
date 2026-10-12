import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { MorningBrief } from '../src/morningBrief.js'

test('morning brief creates a truthful all-source setup snapshot', () => {
  const brief = new MorningBrief({ timezone: 'America/New_York' })
  const snapshot = brief.snapshot({
    space: 'life',
    now: Date.UTC(2026, 9, 12, 11, 5),
    dayStatus: {
      day: '2026-10-12',
      started: false,
    },
  })

  assert.equal(snapshot.schemaVersion, 1)
  assert.equal(snapshot.space, 'life')
  assert.equal(snapshot.mode, 'morning')
  assert.deepEqual(Object.keys(snapshot.sources), ['texts', 'mail', 'linkedin', 'weather', 'money'])
  assert.equal(snapshot.sources.texts.display, 'setup')
  assert.equal(snapshot.sources.mail.display, 'setup')
  assert.equal(snapshot.sources.linkedin.status, 'disabled')
  assert.equal(snapshot.sources.weather.status, 'notConfigured')
  assert.equal(snapshot.sources.money.status, 'notConfigured')
  assert.deepEqual(snapshot.summary, {
    line1: 'Texts setup   Mail setup',
    line2: 'LinkedIn off   Weather setup',
    line3: 'Money setup',
    asOfLabel: 'as of 7:05a',
  })
})

test('source updates require freshness for ok values and become stale after ttl', () => {
  const brief = new MorningBrief({ timezone: 'America/New_York' })

  assert.deepEqual(
    brief.updateSource({ id: 'weather', status: 'ok', display: '61F rain' }),
    { ok: false, error: 'ttlSeconds is required for ok source updates' },
  )

  const updated = brief.updateSource({
    id: 'weather',
    status: 'ok',
    display: '61F rain',
    asOf: '2026-10-12T11:00:00.000Z',
    ttlSeconds: 300,
    source: 'nws',
    confidence: 'live',
  })
  assert.equal(updated.ok, true)

  const fresh = brief.snapshot({
    now: Date.UTC(2026, 9, 12, 11, 4),
    dayStatus: { day: '2026-10-12', started: false },
  })
  assert.equal(fresh.sources.weather.status, 'ok')
  assert.equal(fresh.summary.line2, 'LinkedIn off   Weather 61F rain')

  const stale = brief.snapshot({
    now: Date.UTC(2026, 9, 12, 11, 6),
    dayStatus: { day: '2026-10-12', started: false },
  })
  assert.equal(stale.sources.weather.status, 'stale')
  assert.equal(stale.summary.line2, 'LinkedIn off   Weather 61F rain?')
})

test('morning brief persists compact source summaries across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wam-brief-'))
  try {
    const storePath = join(dir, 'morning-brief.json')
    const first = new MorningBrief({ storePath, timezone: 'America/New_York' })
    assert.equal(first.updateSource({
      id: 'mail',
      status: 'ok',
      display: '3',
      value: 3,
      asOf: '2026-10-12T11:00:00.000Z',
      ttlSeconds: 3600,
      source: 'apple-mail',
    }).ok, true)

    const restored = new MorningBrief({ storePath, timezone: 'America/New_York' })
    const snapshot = restored.snapshot({
      now: Date.UTC(2026, 9, 12, 11, 5),
      dayStatus: { day: '2026-10-12', started: false },
    })

    assert.equal(snapshot.sources.mail.value, 3)
    assert.equal(snapshot.sources.mail.display, '3')
    assert.equal(snapshot.summary.line1, 'Texts setup   Mail 3')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('finance updates reject private-looking identifiers', () => {
  const brief = new MorningBrief()

  const rejected = brief.updateSource({
    id: 'money',
    status: 'ok',
    display: 'ready',
    asOf: '2026-10-12T11:00:00.000Z',
    ttlSeconds: 3600,
    accountNumber: 'redacted',
  })

  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /private field "accountNumber"/)
  assert.equal(
    brief.snapshot({ dayStatus: { day: '2026-10-12', started: false } }).sources.money.display,
    'setup',
  )
})
