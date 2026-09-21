/**
 * Make a spoken transcript readable without a model.
 *
 * The Coach worker writes a real summary when it is running. When it is not —
 * out of credit, not installed, laptop asleep — the note fell back to the raw
 * transcript, which means the Notes list showed rows titled "uhh so I was
 * thinking that maybe we could". A note you cannot identify from its first
 * line is a note you will never open, so the fallback has to be better than
 * nothing even though it understands nothing.
 *
 * This is deliberately not clever. It removes what speech has and writing does
 * not — fillers, stutters, false starts — and takes the first real sentence as
 * the title. No interpretation, no invention: every word in the output was in
 * the input.
 */

/**
 * Standalone filler tokens. Only ever removed as whole words.
 *
 * `like` and `so` are missing on purpose: "like" carries meaning often enough
 * ("looks like the belt"), and a sentence starting "So the thing is" reads
 * fine. Silently dropping a word that mattered is worse than leaving a word
 * that did not.
 */
const FILLERS = ['uh', 'uhh', 'uhhh', 'um', 'umm', 'ummm', 'er', 'erm', 'ah', 'uhm', 'mm', 'mmm', 'hmm', 'mhm']

/** Phrases that only ever pad. Removed mid-sentence, not at the start. */
const PADDING = ['you know', 'i mean', 'sort of', 'kind of', 'i guess']

/** Words that start a spoken sentence and carry nothing into a written one. */
const WEAK_OPENERS = ['so', 'and', 'but', 'okay', 'ok', 'alright', 'right', 'well', 'anyway', 'yeah']

export function stripFillers(text) {
  let out = ` ${String(text || '').replace(/\s+/g, ' ').trim()} `

  for (const filler of FILLERS) {
    // Word-boundary only, with any trailing comma the transcriber added.
    out = out.replace(new RegExp(`\\s${filler},?(?=\\s)`, 'gi'), ' ')
  }
  for (const phrase of PADDING) {
    out = out.replace(new RegExp(`\\s${phrase},?(?=\\s)`, 'gi'), ' ')
  }

  // Stutters and doubled words: "the the belt", "I I think", "we we should".
  out = out.replace(/\s(\w+)(\s+\1\b)+(?=\s|$)/gi, ' $1')

  return out.replace(/\s+([,.!?])/g, '$1').replace(/\s+/g, ' ').trim()
}

/** Split on sentence enders, keeping anything the transcriber never punctuated. */
function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
}

function trimOpener(sentence) {
  let out = sentence
  for (;;) {
    const before = out
    for (const word of WEAK_OPENERS) {
      out = out.replace(new RegExp(`^${word},?\\s+`, 'i'), '')
    }
    if (out === before) return out || sentence
  }
}

/** Cut on a word boundary, never mid-word, and say nothing about the cut. */
function clampWords(text, max) {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, '')
}

export function titleFor(text, max = 64) {
  const clean = stripFillers(text)
  if (!clean) return ''

  // The first sentence with anything in it. A transcript often opens with a
  // fragment — "okay." — that is true, useless, and would become the title.
  for (const sentence of sentences(clean)) {
    const body = trimOpener(sentence).replace(/[.!?]+$/, '').trim()
    if (body.split(/\s+/).filter(Boolean).length < 2) continue
    const title = clampWords(body, max)
    return title.charAt(0).toUpperCase() + title.slice(1)
  }

  const fallback = clampWords(trimOpener(clean).replace(/[.!?]+$/, ''), max)
  return fallback.charAt(0).toUpperCase() + fallback.slice(1)
}

/**
 * A note whose first line can be read in a list.
 *
 * Title on line one, the cleaned transcript under it. The body is kept in
 * full: this pass is confident about what to *ignore* and knows nothing about
 * what matters, so it never decides something was not worth keeping.
 *
 * Returns null when there is nothing to work with, so callers can fall back.
 */
export function distillNote(text, max = 400) {
  const clean = stripFillers(text)
  if (!clean) return null

  const title = titleFor(clean)
  if (!title) return null

  // Already one short line — a title above it would just say it twice.
  if (clean.length <= title.length + 2) return clean.slice(0, max)

  return `${title}\n${clean}`.slice(0, max)
}
