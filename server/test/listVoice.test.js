import test from 'node:test'
import assert from 'node:assert/strict'

import { confirmationText, itemKey, parseItem, parseListSpeech, spokenLabel, splitItems } from '../src/listVoice.js'

const adds = ops => ops.filter(op => op.type === 'add').map(op => [op.name, op.qty, op.unit])
const item = (id, name, extra = {}) => ({ id, name, text: name, status: 'raw', removedAt: null, ...extra })

test('one sentence adds several items, with quantities and units', () => {
  assert.deepEqual(adds(parseListSpeech('Milk, eggs and bread.')), [['milk', 1, null], ['eggs', 1, null], ['bread', 1, null]])
  assert.deepEqual(adds(parseListSpeech('Milk, eggs, and bread.')), [['milk', 1, null], ['eggs', 1, null], ['bread', 1, null]])
  // Multi-word products are never split on spaces.
  assert.deepEqual(adds(parseListSpeech('Paper towels and dish soap.')), [['paper towels', 1, null], ['dish soap', 1, null]])
  assert.deepEqual(adds(parseListSpeech('Two gallons of milk and a dozen eggs.')), [['milk', 2, 'gallon'], ['eggs', 1, 'dozen']])
  assert.deepEqual(adds(parseListSpeech('two loaves of bread')), [['bread', 2, 'loaf']])
  assert.deepEqual(adds(parseListSpeech('a couple of bags of ice')), [['ice', 2, 'bag']])
  assert.deepEqual(adds(parseListSpeech('3 cans of tomatoes')), [['tomatoes', 3, 'can']])
})

test('lead-ins and tails are stripped; compound names stay whole', () => {
  assert.deepEqual(adds(parseListSpeech('Add paper towels to the list.')), [['paper towels', 1, null]])
  assert.deepEqual(adds(parseListSpeech("We're out of coffee.")), [['coffee', 1, null]])
  assert.deepEqual(adds(parseListSpeech('We need batteries.')), [['batteries', 1, null]])
  assert.deepEqual(adds(parseListSpeech('Two gallons of milk from the store.')), [['milk', 2, 'gallon']])
  assert.deepEqual(adds(parseListSpeech('mac and cheese and salt and pepper')), [['mac and cheese', 1, null], ['salt and pepper', 1, null]])
  assert.deepEqual(adds(parseListSpeech('Um, okay, add half and half.')), [['half and half', 1, null]])
})

test('check off, remove, quantity and undo find the item already on the list', () => {
  const list = [item('m', 'milk', { qty: 2, unit: 'gallon' }), item('e', 'eggs'), item('b', 'bread')]
  assert.deepEqual(parseListSpeech('We got the eggs.', list).map(op => [op.type, op.itemId]), [['done', 'e']])
  assert.deepEqual(parseListSpeech('check off bread and milk', list).map(op => [op.type, op.itemId]), [['done', 'b'], ['done', 'm']])
  assert.deepEqual(parseListSpeech('Remove bread.', list).map(op => [op.type, op.itemId]), [['remove', 'b']])
  assert.deepEqual(parseListSpeech("We don't need eggs anymore.", list).map(op => [op.type, op.itemId]), [['remove', 'e']])
  assert.deepEqual(parseListSpeech('Make it three milk.', list).map(op => [op.type, op.itemId, op.qty]), [['qty', 'm', 3]])
  assert.deepEqual(parseListSpeech('Change eggs to two dozen.', list).map(op => [op.type, op.itemId, op.qty, op.unit]), [['qty', 'e', 2, 'dozen']])
  assert.deepEqual(parseListSpeech('Add another milk.', list).map(op => [op.type, op.itemId, op.delta]), [['qty', 'm', 1]])
  assert.deepEqual(parseListSpeech('Never mind.', list).map(op => op.type), ['undo'])
  // An item that is not on the list is reported, not invented.
  assert.deepEqual(parseListSpeech('we got the butter', list).map(op => [op.type, op.itemId]), [['done', null]])
})

test('urgent flags an existing item or adds a new one urgent; clear is its own intent', () => {
  const list = [item('m', 'milk')]
  assert.deepEqual(parseListSpeech('Milk, urgent.', list).map(op => [op.type, op.itemId, op.urgent]), [['urgent', 'm', true]])
  assert.deepEqual(parseListSpeech('Make milk urgent.', list).map(op => [op.type, op.itemId]), [['urgent', 'm']])
  assert.deepEqual(parseListSpeech('We urgently need diapers.').map(op => [op.type, op.name, op.urgent]), [['add', 'diapers', true]])
  assert.deepEqual(parseListSpeech('Clear the list.').map(op => op.type), ['clear'])
})

test('talk that is not a list is still kept, as said, never dropped', () => {
  const ops = parseListSpeech('uh the thing for the thing we talked about yesterday at dinner')
  assert.equal(ops.length, 1)
  assert.equal(ops[0].raw, true)
  assert.match(ops[0].name, /thing we talked about/)
})

test('helpers: item keys fold plurals; splitting keeps quantity phrases whole', () => {
  assert.equal(itemKey('Eggs'), itemKey('egg'))
  assert.equal(itemKey('tomatoes'), itemKey('tomato'))
  assert.equal(itemKey('berries'), itemKey('berry'))
  assert.equal(itemKey('glass'), 'glass')
  assert.deepEqual(splitItems('two loaves of bread and milk'), ['two loaves of bread', 'milk'])
  assert.deepEqual(parseItem('dozen eggs'), { name: 'eggs', qty: 1, unit: 'dozen' })
  assert.equal(
    confirmationText([{ type: 'add', label: 'milk' }, { type: 'add', label: 'eggs' }, { type: 'done', label: 'bread' }]),
    'Added milk and eggs. Checked off bread.',
  )
  assert.equal(spokenLabel({ name: 'milk', qty: 2, unit: 'gallon' }), '2 gallons of milk')
  assert.equal(spokenLabel({ name: 'eggs', qty: 1, unit: 'dozen' }), 'a dozen eggs')
  assert.equal(spokenLabel({ name: 'bread', qty: 2, unit: 'loaf' }), '2 loaves of bread')
})
