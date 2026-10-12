import test from 'node:test'
import assert from 'node:assert/strict'

import { AssistantChat } from '../src/assistant.js'
import { Jobs } from '../src/jobs.js'

const make = () => ({
  assistant: new AssistantChat({ storePath: null, providerReady: { chatgpt: true, claude: true } }),
  jobs: new Jobs({ storePath: null, logPath: null }),
})

test('queued turns advance one at a time after the provider becomes idle', () => {
  const { assistant, jobs } = make()
  const first = assistant.addTurn({ space: 'life', provider: 'chatgpt', text: 'first', clientId: 'first' }, jobs)
  assert.equal(first.ok, true)

  const second = assistant.queueTurn({
    space: 'life',
    provider: 'chatgpt',
    text: 'second',
    clientId: 'second',
    source: { kind: 'note', clientId: 'second', label: 'Second note' },
  }, jobs)
  assert.equal(second.ok, true)
  assert.equal(second.chat.queued, 1)

  const firstJob = jobs.get(first.chat.pending.id)
  jobs.claim(firstJob.id, 'test')
  jobs.finish(firstJob.id, 'test', { text: 'first answer' })
  assistant.syncAll(jobs)

  const after = assistant.snapshot('life', 'chatgpt', jobs)
  assert.equal(after.queued, 0)
  assert.equal(after.busy, true)
  assert.equal(after.activeSource.label, 'Second note')
  assert.equal(after.messages.at(-2).text, 'first answer')
  assert.equal(after.messages.at(-1).text, 'second')
})

test('ChatGPT and Claude hold independent active jobs', () => {
  const { assistant, jobs } = make()
  assistant.addTurn({ space: 'life', provider: 'chatgpt', text: 'slow task', clientId: 'gpt' }, jobs)
  assistant.addTurn({ space: 'life', provider: 'claude', text: 'fast task', clientId: 'claude' }, jobs)

  const available = jobs.available('assistant.chat')
  assert.equal(available.length, 2)
  assert.deepEqual(new Set(available.map(job => job.input.provider)), new Set(['chatgpt', 'claude']))
  assert.equal(assistant.snapshot('life', 'chatgpt', jobs).busy, true)
  assert.equal(assistant.snapshot('life', 'claude', jobs).busy, true)
})

test('queue client ids are idempotent', () => {
  const { assistant, jobs } = make()
  const input = {
    space: 'life',
    provider: 'claude',
    text: 'one note',
    clientId: 'note:1:claude',
    source: { kind: 'note', clientId: 'note:1:claude', label: 'One note' },
  }
  assert.equal(assistant.queueTurn(input, jobs).existing, undefined)
  assert.equal(assistant.queueTurn(input, jobs).existing, true)
  assert.equal(jobs.available('assistant.chat').length, 1)
})
