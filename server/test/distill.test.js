import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripFillers, titleFor, distillNote } from '../src/distill.js'

test('strips standalone fillers, not words that contain them', () => {
  assert.equal(stripFillers('uh so um the belt is loose'), 'so the belt is loose')
  // "ah" inside a word must survive.
  assert.equal(stripFillers('the ahead sensor'), 'the ahead sensor')
  assert.equal(stripFillers('hmm, I think, um, we should go'), 'I think, we should go')
})

test('collapses stutters', () => {
  assert.equal(stripFillers('the the belt'), 'the belt')
  assert.equal(stripFillers('I I I think so'), 'I think so')
})

test('keeps words that only sometimes pad', () => {
  // "like" carries meaning here and must not be dropped.
  assert.match(stripFillers('it looks like the belt'), /like the belt/)
})

test('title takes the first sentence with something in it', () => {
  const raw = 'okay. uh so the dentist thing, I need to look up which one it actually is.'
  assert.equal(titleFor(raw), 'The dentist thing, I need to look up which one it actually is')
})

test('title skips a one-word opening fragment', () => {
  assert.equal(titleFor('Right. The tyres have a warranty at the place three hours away.'), 'The tyres have a warranty at the place three hours away')
})

test('title cuts on a word boundary', () => {
  const t = titleFor('we need to remember to include drive time and time off work for the tyre place', 40)
  assert.ok(t.length <= 40, t)
  assert.ok(!t.endsWith(' '), t)
  assert.match(t, /^We need to remember/)
})

test('distilled note leads with the title and keeps the body', () => {
  const raw = 'uh so, um, the car tyre thing. I have to drive three hours because the warranty is there.'
  const note = distillNote(raw)
  const [first, ...rest] = note.split('\n')
  assert.equal(first, 'The car tyre thing')
  assert.match(rest.join('\n'), /drive three hours/)
  assert.ok(!note.includes(' uh '), note)
})

test('a single short line is not repeated as its own title', () => {
  assert.equal(distillNote('call the plumber'), 'call the plumber')
})

test('nothing in, nothing out', () => {
  assert.equal(distillNote('   '), null)
  assert.equal(distillNote('uh um uhh'), null)
})
