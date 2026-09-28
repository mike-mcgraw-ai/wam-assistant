import test from 'node:test'
import assert from 'node:assert/strict'

import { Coach } from '../src/coach.js'

test('live Listen compass keeps explicit requests above ambient chatter', () => {
  const coach = new Coach({ storePath: null, logPath: null })
  const started = coach.startSession({ space: 'life', modeId: 'conversation', at: 1_000 })
  const id = started.session.id
  const speech = [
    'Wow.',
    'Good job.',
    'We need to keep the raw recording but clean the transcript on my face.',
    'Okay.',
    'I want to hide the screen with one gesture.',
  ]

  speech.forEach((text, index) => {
    coach.addSegment(id, {
      clientId: `segment-${index}`,
      speaker: 'me',
      text,
      final: true,
      at: 2_000 + index * 5_000,
    })
  })

  const session = coach.snapshot('life').session
  assert.match(session.runningNote.lines[0], /Thread: .*hide the screen/i)
  assert.ok(session.runningNote.lines.some(line => /raw recording|clean the transcript/i.test(line)))
  assert.equal(session.recentSegments.some(segment => /wow|good job|okay/i.test(segment.text)), false)
})
