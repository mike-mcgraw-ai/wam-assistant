import test from 'node:test'
import assert from 'node:assert/strict'

import { composeListenSummary, fallbackListenSummary, sessionRecap } from '../src/listenSummary.js'
import { coalesceTranscriptSegments } from '../src/transcript.js'

test('final note includes early and late sections from the complete consolidated session', () => {
  const raw = Array.from({ length: 35 }, (_, index) => ({
    id: `chunk-${index}`,
    text: index === 0 ? 'The project needs a readable live transcript.'
      : index === 34 ? 'The saved note must include the final review decision.'
        : `We discussed requirement number ${index} for the project.`,
    final: true,
    at: 1_000 + index * 2_000,
  }))
  const consolidated = coalesceTranscriptSegments(raw)
  assert.match(consolidated[0].text, /readable live transcript/)
  assert.match(consolidated.at(-1).text, /final review decision/)

  const saved = composeListenSummary({
    overallTopic: 'Listen quality',
    sections: ['Readable live transcript', 'Final review'],
    currentSummary: ['The saved note includes the final review decision.'],
  }, ['Live words remain the first display priority.'])
  assert.match(saved, /Readable live transcript.*Final review/)
  assert.match(saved, /final review decision/)
  const review = sessionRecap({ segments: raw })
  assert.match(review.lines.join(' '), /readable live transcript/)
  assert.match(review.lines.join(' '), /final review decision/)
  const withoutWorker = fallbackListenSummary(raw)
  assert.match(withoutWorker, /readable live transcript/i)
  assert.match(withoutWorker, /final review decision/i)
})
