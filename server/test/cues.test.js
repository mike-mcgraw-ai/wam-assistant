import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCue } from '../src/cues.js'

const base = {
  space: 'life', snapshot: {}, plan: {}, checklistsState: {},
  inboxGroups: [], dueWaits: [], jobsSummary: {}, now: 200_000,
}

test('live modes honor cue switches and never show placeholder answers', () => {
  for (const mode of [
    { id: 'conversation', cueTypes: { answers: true, followups: true }, periodicRecap: false },
    { id: 'listening', cueTypes: { answers: false, followups: true }, periodicRecap: false },
    { id: 'meeting', cueTypes: { answers: true, followups: false }, periodicRecap: false },
    { id: 'notes', cueTypes: {}, periodicRecap: false },
  ]) {
    const cue = buildCue({ ...base, coach: {
      mode,
      session: {
        active: true, startedAt: 1_000, recentSegments: [
          { text: 'What did the budget close at?', at: 100_000 },
          { text: 'We should review the numbers tomorrow.', at: 102_000 },
        ],
        runningNote: { lines: ['Thread: Budget review', 'Now: Review numbers tomorrow'] },
      },
    } })
    assert.equal(cue.quiet, true, mode.id)
    assert.equal(cue.lines.length, 0, mode.id)
  }
})

test('recap needs the mode switch and two useful compass lines', () => {
  const mode = { id: 'meeting', name: 'Meeting', cueTypes: {}, periodicRecap: true, recapMinutes: 2 }
  const coach = { mode, session: {
    active: true, startedAt: 1_000, recentSegments: [
      { text: 'We agreed on the budget review.', at: 10_000 },
      { text: 'Dana will bring the final numbers.', at: 12_000 },
    ],
    runningNote: { lines: ['Thread: Budget review', 'Hold: Dana brings final numbers'] },
  } }
  assert.equal(buildCue({ ...base, coach }).kind, 'recap')
  assert.equal(buildCue({ ...base, coach: { ...coach, mode: { ...mode, periodicRecap: false } } }).quiet, true)
})
