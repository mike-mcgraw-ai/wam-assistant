import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cleanTranscriptForDisplay,
  coalesceTranscriptSegments,
  displayTranscriptSegments,
  parseTaskCommand,
  transcriptText,
} from '../src/transcript.js'

const chunks = texts => texts.map((text, index) => ({
  id: `s${index}`,
  text,
  speaker: index % 3 === 0 ? 'someone' : 'me',
  final: true,
  at: 1_000 + index * 2_000,
}))

test('joins transport chunks despite noisy speaker direction', () => {
  const blocks = coalesceTranscriptSegments(chunks([
    'We also need',
    'to make our later.',
    'a little bit more smart.',
    'I need to start the day.',
    'Look around the house.',
  ]))

  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /We also need to make our later/)
  assert.match(blocks[0].text, /I need to start the day\. Look around the house/)
})

test('non-speech labels stay out of meaning-sized text', () => {
  const text = transcriptText(chunks(['Refilling the ice machine.', '(birds chirping)', 'All the way to the top.']))
  assert.equal(text, 'Refilling the ice machine. All the way to the top.')
})

test('face transcript removes reactions but keeps the complete request', () => {
  const segments = chunks([
    'Wow.',
    'Yeah.',
    'We need a quick way to hide the screen.',
    'Thank you.',
  ])

  assert.equal(
    displayTranscriptSegments(segments).map(segment => segment.text).join(' '),
    'We need a quick way to hide the screen.',
  )
  assert.match(transcriptText(segments), /Wow/)
  assert.match(transcriptText(segments), /Thank you/)
})

test('face cleanup preserves short meaningful directions', () => {
  assert.equal(cleanTranscriptForDisplay('Okay. Go left. Wow!'), 'Go left.')
})

test('face cleanup leads with an explicit request buried after chatter', () => {
  assert.equal(
    cleanTranscriptForDisplay('Wow. The rain is really coming down. Anyway, I want to hide the screen with one gesture.'),
    'I want to hide the screen with one gesture.',
  )
})

test('ordinary need language is not a task command', () => {
  assert.equal(parseTaskCommand('I need to start the day.'), null)
  assert.equal(parseTaskCommand('I need to be added on here.'), null)
  assert.equal(parseTaskCommand('We need to make the meds workflow better.'), null)
})

test('short explicit commands remain supported', () => {
  assert.equal(parseTaskCommand('Add a task to call the dentist.'), 'call the dentist')
  assert.equal(parseTaskCommand('Remind me to refill the prescription.'), 'refill the prescription')
})

test('a command-looking fragment inside a longer thought is not classified alone', () => {
  const whole = transcriptText(chunks([
    'We also need to make Later smarter.',
    'I need to start the day.',
    'Look around the house and identify what actually needs doing.',
  ]))
  assert.equal(parseTaskCommand(whole), null)
})
