import test from 'node:test'
import assert from 'node:assert/strict'

import { Inbox } from '../src/inbox.js'
import { applyListSpeech } from '../src/householdList.js'
import { parseListSpeech } from '../src/listVoice.js'
import { Checklists } from '../src/checklists.js'

function household() {
  const inbox = new Inbox({ storePath: null, logPath: null })
  const tasks = new Map()
  const closed = []
  const reopened = []
  const deps = {
    inbox,
    openUrgentTask: item => { const id = `urgent-${item.id}`; tasks.set(id, `Get ${item.name} (urgent)`); return id },
    closeTask: id => closed.push(id),
    reopenTask: id => reopened.push(id),
  }
  const say = (text, by = 'Sam') =>
    applyListSpeech(parseListSpeech(text, inbox.active(200)), { ...deps, by })
  const list = () => inbox.active(200).map(i => Inbox.label(i)).sort()
  return { inbox, tasks, closed, reopened, say, list }
}

test('acceptance: add, merge, check off, remove, quantity, undo', () => {
  const h = household()
  assert.equal(h.say('Milk, eggs, and bread.').say, 'Added milk, eggs and bread.')
  assert.deepEqual(h.list(), ['bread', 'eggs', 'milk'])

  assert.equal(h.say('Add milk.').say, 'Now 2 milk.')
  assert.deepEqual(h.list(), ['2 × milk', 'bread', 'eggs'])

  h.say('We got the eggs.', 'Alex')
  assert.deepEqual(h.list(), ['2 × milk', 'bread'])
  assert.equal([...h.inbox.items.values()].find(i => i.name === 'eggs').doneBy, 'Alex')

  h.say('Remove bread.')
  assert.deepEqual(h.list(), ['2 × milk'])
  assert.ok([...h.inbox.items.values()].find(i => i.name === 'bread').removedAt, 'removed, not deleted')

  h.say('Make it three milk.')
  assert.deepEqual(h.list(), ['3 × milk'])
  assert.equal(h.say('Undo.').say, 'Undone.')
  assert.deepEqual(h.list(), ['2 × milk'])

  assert.equal(h.say('we got the butter').say, "Couldn't find butter.")
})

test('two gallons and a dozen keep their units; a different unit is a different row', () => {
  const h = household()
  h.say('Two gallons of milk and a dozen eggs.')
  assert.equal(h.say('a half gallon of milk').say, 'Added a half gallon of milk.')
  assert.deepEqual(h.list(), ['1 × eggs (dozen)'.replace('1 × ', ''), '2 × milk (gallon)', 'milk (half gallon)'].sort())
})

test('the same name on two rows: a bare name means the plain row', () => {
  const h = household()
  h.say('Two gallons of milk.')
  h.say('Milk.')
  assert.equal(h.say('Add another milk.').say, 'Updated 2 milk.')
  assert.deepEqual(h.list(), ['2 × milk', '2 × milk (gallon)'])
})

test('urgent: a Home task appears; checking off either side closes both; undo takes it back', () => {
  const h = household()
  h.say('Milk and bread.')
  const out = h.say('Milk, urgent.')
  assert.equal(out.say, 'Milk is urgent.')
  const milk = [...h.inbox.items.values()].find(i => i.name === 'milk')
  assert.equal(milk.urgent, true)
  assert.equal(h.tasks.get(milk.taskId), 'Get milk (urgent)')

  h.say('We got the milk.')
  assert.deepEqual(h.closed, [milk.taskId], 'checking off the item closes its task')
  h.say('Undo.')
  assert.deepEqual(h.reopened, [milk.taskId], 'undoing the check-off reopens its task')
  assert.deepEqual(h.list(), ['bread', 'milk'])

  const h2 = household()
  h2.say('We urgently need diapers.')
  const diapers = [...h2.inbox.items.values()].find(i => i.name === 'diapers')
  assert.ok(diapers.taskId)
  h2.say('Undo.')
  assert.deepEqual(h2.list(), [])
  assert.deepEqual(h2.closed, [diapers.taskId], 'undoing the urgent add removes its Home task')
})

test('clear is not applied by speech: the kiosk must confirm it', () => {
  const h = household()
  h.say('Milk.')
  const out = h.say('Clear the list.')
  assert.deepEqual(out.applied.map(a => [a.type, a.pending]), [['clear', true]])
  assert.deepEqual(h.list(), ['milk'])
})

test('an urgent item before Start Day does not start the day', () => {
  const checklists = new Checklists({ checklists: [] }, { runsPath: null, logPath: null, summaryPath: null })
  checklists.commitTasks('life', ['urgent-1'], 1_000, { startDay: false })
  assert.equal(checklists.dayStatus('life', 1_000).started, false)
  assert.deepEqual(checklists.committedTaskIds('life'), ['urgent-1'])
})
