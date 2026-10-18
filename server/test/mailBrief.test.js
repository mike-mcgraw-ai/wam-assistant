import test from 'node:test'
import assert from 'node:assert/strict'

import { MorningBrief } from '../src/morningBrief.js'
import { mailConfigFromEnv, mailRefreshDelayMs, refreshMailBrief } from '../src/sources/mail.js'

test('mail adapter stores only the unread count', async () => {
  const brief = new MorningBrief({ timezone: 'America/New_York' })
  let seenScript = ''
  const result = await refreshMailBrief({
    morningBrief: brief,
    env: { MAIL_BRIEF_ENABLED: '1' },
    now: Date.UTC(2026, 9, 18, 16, 30),
    runScript: async script => {
      seenScript = script
      return '319\n'
    },
  })

  assert.equal(result.ok, true)
  assert.match(seenScript, /unread count of inbox/)
  const source = brief.snapshot({ now: Date.UTC(2026, 9, 18, 16, 31) }).sources.mail
  assert.deepEqual({ status: source.status, value: source.value, display: source.display }, {
    status: 'ok',
    value: 319,
    display: '319',
  })
  assert.equal(JSON.stringify(source).includes('subject'), false)
  assert.equal(JSON.stringify(source).includes('sender'), false)
})

test('mail adapter is setup when disabled and preserves a prior count on failure', async () => {
  const brief = new MorningBrief({ timezone: 'America/New_York' })
  await refreshMailBrief({ morningBrief: brief, env: {}, runScript: async () => '99' })
  assert.equal(brief.snapshot().sources.mail.status, 'notConfigured')

  await refreshMailBrief({
    morningBrief: brief,
    env: { MAIL_BRIEF_ENABLED: '1' },
    now: Date.UTC(2026, 9, 18, 16, 30),
    runScript: async () => '12',
  })
  await refreshMailBrief({
    morningBrief: brief,
    env: { MAIL_BRIEF_ENABLED: '1' },
    now: Date.UTC(2026, 9, 18, 16, 31),
    runScript: async () => { throw new Error('automation denied') },
    logger: { warn() {} },
  })
  const failed = brief.snapshot({ now: Date.UTC(2026, 9, 18, 16, 31) }).sources.mail
  assert.equal(failed.status, 'error')
  assert.equal(failed.display, '12')
  assert.equal(failed.error, 'automation denied')
})

test('mail adapter config and cadence are bounded', () => {
  assert.equal(mailConfigFromEnv({}).enabled, false)
  assert.equal(mailConfigFromEnv({ MAIL_BRIEF_ENABLED: '1' }).ttlSeconds, 1800)
  assert.equal(mailRefreshDelayMs({
    now: new Date('2026-10-18T12:00:00.000Z'),
    timeZone: 'America/New_York',
    env: {},
  }), 5 * 60_000)
  assert.equal(mailRefreshDelayMs({
    now: new Date('2026-10-18T18:00:00.000Z'),
    timeZone: 'America/New_York',
    env: {},
  }), 15 * 60_000)
})
