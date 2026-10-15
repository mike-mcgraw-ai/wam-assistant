import { displayTranscriptSegments } from './transcript.js'
import { titleFor } from './distill.js'

export function composeListenSummary(board, recapLines = [], fallbackLines = []) {
  const clean = lines => (Array.isArray(lines) ? lines : [])
    .map(line => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const recap = clean(recapLines).slice(0, 3)
  if (board?.overallTopic) {
    const sections = clean(board.sections)
    const roadmap = sections.length > 1 ? `Roadmap: ${sections.join(' > ')}` : ''
    return [board.overallTopic, roadmap, ...recap, ...clean(board.currentSummary)]
      .filter(Boolean)
      .join('\n')
      .slice(0, 2_000)
  }
  return (recap.length ? recap : clean(fallbackLines).slice(0, 3)).join('\n').slice(0, 2_000) || null
}

export function sessionRecap(session) {
  const blocks = displayTranscriptSegments(session?.segments, { maxBlocks: 240 })
  const thoughts = blocks.flatMap(block => block.text.match(/[^.!?]+[.!?]?/g) || [])
    .map(text => text.replace(/\s+/g, ' ').trim())
    .filter(text => text.split(/\s+/).length >= 4 || /\b(?:call|send|ask|decided|agreed|need to|remind me)\b/i.test(text))
  if (thoughts.length === 0) return { title: 'Session recap', lines: [] }

  const picks = new Set([0, thoughts.length - 1])
  thoughts.forEach((text, index) => {
    if (/\b(?:decided|decision|agreed|plan is|need to|remind me to|remember to|follow up|should)\b/i.test(text)) picks.add(index)
  })
  const selected = [...picks].sort((left, right) => left - right)
  const kept = selected.length > 5 ? [selected[0], ...selected.slice(-4)] : selected
  const lines = kept.map(index => thoughts[index].slice(0, 88))
  return { title: 'Session recap', lines }
}

export function fallbackListenSummary(segments) {
  const lines = sessionRecap({ segments }).lines
  if (lines.length === 0) return null
  return [titleFor(lines[0]), ...lines.slice(1)].filter(Boolean).join('\n').slice(0, 2_000)
}
