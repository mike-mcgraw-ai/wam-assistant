const NON_SPEECH = /^(?:\([^)]*\)|\[[^\]]*\]|\*[^*]+\*)[.!?]*$/i
const DISPLAY_NOISE = new Set([
  'ah',
  'alright',
  'bye',
  'good',
  'good job',
  'hello',
  'hey',
  'hi',
  'hmm',
  'huh',
  'mm',
  'mm hmm',
  'my goodness',
  'nice',
  'oh',
  'oh my goodness',
  'ok',
  'okay',
  'oops',
  'right',
  'see ya',
  'thank you',
  'thanks',
  'uh',
  'um',
  'wow',
  'yeah',
  'yep',
  'yes',
])

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function isNonSpeechText(value) {
  return NON_SPEECH.test(cleanText(value))
}

function displayKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function isDisplayNoise(value) {
  const key = displayKey(value)
  if (!key || DISPLAY_NOISE.has(key)) return true
  if (/^(?:ha+|heh+|huh+|mm+|oh+|uh+|um+|wow+)(?:\s+(?:ha+|heh+|huh+|mm+|oh+|uh+|um+|wow+))*$/i.test(key)) return true
  const words = key.split(' ')
  return words.length > 1 && words.every(word => DISPLAY_NOISE.has(word))
}

/**
 * Remove transport debris and low-information reactions from the face view.
 *
 * This never mutates stored segments. The raw transcript remains the source
 * of truth; this is only the compact reading layer used while Listen is open.
 */
export function cleanTranscriptForDisplay(value) {
  const text = cleanText(value)
  if (!text) return ''
  const thoughts = text.match(/[^.!?]+[.!?]?/g) || [text]
  const kept = []
  let prior = ''

  for (const thought of thoughts) {
    const clean = cleanText(thought).replace(/^[-–—]\s*/, '')
    const key = displayKey(clean)
    if (!key || key === prior || isDisplayNoise(clean)) continue
    prior = key
    kept.push(clean)
  }

  const joined = kept.join(' ').replace(/\s+([,.!?])/g, '$1').trim()
  const intentAt = joined.search(
    /\b(?:we (?:also )?need to|i need to|i want(?:ed)? to|i was specifically wanting to|(?:a )?better way to|remind me to|the point is)\b/i,
  )
  return intentAt > 0 ? joined.slice(intentAt).trim() : joined
}

function appendChunk(left, right) {
  const next = cleanText(right)
  if (!left) return next
  if (!next) return left

  // Every two-second Deepgram request is punctuated as if it were complete.
  // A lowercase/connective next chunk is strong evidence that period was a
  // transport boundary, not the end of the speaker's sentence.
  const continues = /^(?:[a-z]|and\b|or\b|but\b|so\b|to\b|for\b|that\b|of\b|with\b|because\b)/.test(next)
  const prior = continues ? left.replace(/\.$/, '') : left
  return `${prior} ${next}`.replace(/\s+([,.!?])/g, '$1')
}

/**
 * Turn fixed-duration STT chunks into speech-sized blocks.
 *
 * Raw segments stay in the Coach store and transcript endpoint. Consumers
 * that need meaning or a readable live display use these blocks instead.
 * Speaker direction is intentionally not a block boundary: the glasses often
 * flips `me`/`someone` halfway through one sentence as the wearer moves.
 */
export function coalesceTranscriptSegments(segments, { gapMs = 4_500, maxChars = 900 } = {}) {
  const blocks = []

  for (const segment of Array.isArray(segments) ? segments : []) {
    if (segment?.final === false) continue
    const text = cleanText(segment?.text)
    if (!text || isNonSpeechText(text)) continue
    const at = Number(segment?.at) || Date.now()
    const prior = blocks.at(-1)
    const gap = prior ? at - prior.lastAt : Infinity

    if (!prior || gap > gapMs || prior.text.length + text.length + 1 > maxChars) {
      blocks.push({
        id: String(segment?.id || `speech-${at}`),
        clientId: null,
        speaker: segment?.speaker === 'me' ? 'me' : 'someone',
        text,
        final: true,
        at,
        lastAt: at,
        meChunks: segment?.speaker === 'me' ? 1 : 0,
        otherChunks: segment?.speaker === 'me' ? 0 : 1,
      })
      continue
    }

    prior.text = appendChunk(prior.text, text)
    prior.lastAt = at
    if (segment?.speaker === 'me') prior.meChunks += 1
    else prior.otherChunks += 1
    prior.speaker = prior.meChunks >= prior.otherChunks ? 'me' : 'someone'
  }

  return blocks.map(({ lastAt, meChunks, otherChunks, ...block }) => block)
}

export function displayTranscriptSegments(segments, { maxBlocks = 24 } = {}) {
  return coalesceTranscriptSegments(segments)
    .map(segment => ({ ...segment, text: cleanTranscriptForDisplay(segment.text) }))
    .filter(segment => segment.text)
    .slice(-Math.max(1, Number(maxBlocks) || 24))
}

export function transcriptText(segments, max = 2_000) {
  return coalesceTranscriptSegments(segments)
    .map(block => block.text)
    .join('\n\n')
    .replace(/\s+([,.!?])/g, '$1')
    .trim()
    .slice(0, max)
}

/** Only unmistakable, complete voice commands become tasks automatically. */
export function parseTaskCommand(text) {
  const raw = cleanText(text)
  if (!raw || raw.split(/\s+/).length > 24) return null
  const patterns = [
    /^(?:add|create|make)\s+(?:a\s+)?(?:task|to-?do|todo)\s+(?:to\s+)?(.+)$/i,
    /^(?:remind me to|remember to)\s+(.+)$/i,
  ]
  for (const pattern of patterns) {
    const label = raw.match(pattern)?.[1]?.trim()
    if (label) return label.replace(/[.!?]+$/g, '').slice(0, 80)
  }
  return null
}
