import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cleanTranscriptForDisplay,
  coalesceTranscriptSegments,
  displayTranscriptSegments,
  mergeRawSegments,
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

test('face cleanup retains useful context before an explicit request', () => {
  assert.equal(
    cleanTranscriptForDisplay('Wow. The rain is really coming down. Anyway, I want to hide the screen with one gesture.'),
    'The rain is really coming down. Anyway, I want to hide the screen with one gesture.',
  )
})

test('fragmented speech becomes readable units while raw noise remains untouched', () => {
  const raw = chunks([
    'Um, we need to make the.',
    'Listen transcript easier to read.',
    'So the first thought stays together.',
    'Wow.',
    'Then we need the live words to come first.',
  ])
  const shown = displayTranscriptSegments(raw)
  assert.ok(shown.length < raw.length)
  assert.match(shown.map(segment => segment.text).join(' '), /make the Listen transcript easier to read/i)
  assert.doesNotMatch(shown.map(segment => segment.text).join(' '), /Wow/i)
  assert.equal(raw[3].text, 'Wow.')
  assert.match(transcriptText(raw), /Wow/)
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

test('final context restores archived early speech without duplicating live chunks', () => {
  const archive = chunks(['The live transcript needs to read like speech.', 'Keep the raw audio unchanged.'])
  const live = [archive[1], ...chunks(['The final review also needs the first request.']).map(segment => ({ ...segment, id: 'late', at: 20_000 }))]
  const merged = mergeRawSegments(live, archive)
  assert.equal(merged.length, 3)
  assert.match(merged[0].text, /live transcript/)
  assert.match(merged.at(-1).text, /final review/)
})
