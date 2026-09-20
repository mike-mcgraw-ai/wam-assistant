import test from 'node:test'
import assert from 'node:assert/strict'

import { Jobs } from '../src/jobs.js'

const makeJobs = () => new Jobs({ storePath: null, logPath: null })

test('Coach worker receives only the newest cue for an active session', () => {
  const jobs = makeJobs()
  jobs.create({ capability: 'coach.cue', input: { sessionId: 'active', text: 'old' }, idempotencyKey: 'old' })
  const latest = jobs.create({ capability: 'coach.cue', input: { sessionId: 'active', text: 'new' }, idempotencyKey: 'new' }).job
  jobs.create({ capability: 'coach.cue', input: { sessionId: 'ended' }, idempotencyKey: 'ended' })

  assert.deepEqual(jobs.availableCoachCues(['active']).map(job => job.id), [latest.id])
})

test('stale Coach cleanup never removes unrelated work', () => {
  const jobs = makeJobs()
  jobs.create({ capability: 'coach.cue', input: { sessionId: 'active' }, idempotencyKey: 'active' })
  jobs.create({ capability: 'coach.cue', input: { sessionId: 'ended' }, idempotencyKey: 'ended' })
  jobs.create({ capability: 'assistant.chat', input: {}, idempotencyKey: 'chat' })

  assert.equal(jobs.discardStaleCoachCues(['active']), 1)
  assert.equal(jobs.available('coach.cue').length, 1)
  assert.equal(jobs.available('assistant.chat').length, 1)
})
