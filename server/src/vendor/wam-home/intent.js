// Synced from WAM Home f78eef9 (core/src/intent.js). Edit it there, not here; then run tools/sync-wam-home.mjs.
/**
 * Start Day intent — which routines a spoken sentence names, and what is left
 * over as tasks, errands or fragments. Fixed rules, no model.
 *
 * Shared by WAM Home (the household app) and the WAM hub's Start Day walk on
 * the glasses. Moved here from the hub's checklists.js in WAM Home v0.1.0;
 * this is the one copy (the hub syncs it).
 *
 * No dependencies, so the same file runs in Node and in the browser.
 */
export function normalizeMatchText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function containsPhrase(text, phrase) {
  const clean = normalizeMatchText(phrase)
  if (!clean) return false
  return ` ${text} `.includes(` ${clean} `)
}

export function dayClauses(value) {
  return String(value ?? '')
    .replace(/\b(?:and then|after that|then|also)\b/gi, '|')
    .replace(/[.!?;,]+/g, '|')
    .split('|')
    .flatMap(part => (isShoppingList(part) ? [part] : part.split(/\band\b/gi)))
    .map(part => part.trim())
    .filter(Boolean)
}

/**
 * "Milk and eggs from the store" is one errand, not "Milk" + "eggs from the
 * store". Kept whole only when it names a store and none of its "and" parts is
 * an action of its own — "text my doctor and get bread from the store" still
 * splits into two.
 */
export function isShoppingList(part) {
  const pieces = String(part).split(/\band\b/i).map(piece => actionSource(piece)).filter(Boolean)
  if (pieces.length < 2) return false
  if (!new RegExp(`\\b${ERRAND_PLACE}`).test(pieces[pieces.length - 1])) return false
  return pieces.every(piece => {
    const [first] = piece.split(' ')
    return !ACTION_WORDS.has(first) && !NOT_AN_ERRAND_START.has(first)
  })
}

export function sameWork(left, right) {
  const key = value => normalizeMatchText(value).split(' ').filter(word => !['a', 'an', 'my', 'the'].includes(word)).join(' ')
  return key(left) === key(right)
}

export function cleanTaskClause(value) {
  const cleaned = String(value ?? '')
    .replace(/^(?:(?:okay|ok|so|today|please)\s+)+/i, '')
    .replace(/^(?:(?:i|we)\s+(?:need to|want to|have to|got to|gotta|should|must)\s+)/i, '')
    .replace(/^(?:need|remember)\s+to\s+/i, '')
    .replace(/^(?:add|put)\s+/i, '')
    .replace(/\s+(?:make\s+){1,2}(?:that|it)\s+(?:a\s+)?task\b.*$/i, '')
    .replace(/\s+(?:to|on)\s+(?:my|the)\s+(?:list|plan)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned || cleaned.length < 3) return ''
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

export const ACTION_WORDS = new Set([
  'apply',
  'answer',
  'book',
  'bring',
  'buy',
  'call',
  'change',
  'check',
  'clean',
  'clear',
  'drop',
  'email',
  'empty',
  'feed',
  'fill',
  'get',
  'grab',
  'find',
  'finish',
  'fix',
  'fold',
  'load',
  'make',
  'message',
  'move',
  'order',
  'organize',
  'pack',
  'pay',
  'pick',
  'put',
  'refill',
  'replace',
  'repair',
  'return',
  'schedule',
  'send',
  'set',
  'shop',
  'sort',
  'start',
  'take',
  'text',
  'unload',
  'wash',
  'water',
])

export function actionSource(value) {
  return normalizeMatchText(value).replace(/^(?:(?:okay|ok|so|today|please)\s+)+/, '')
}

/**
 * Errands said without a verb: "two gallons of milk from the store".
 *
 * Mike's Start Day walk heard exactly that on 2026-10-17 and the milk never
 * reached the list: only clauses starting with an action word became tasks,
 * so it stayed an excluded fragment. Fixed rules, no model — a clause is an
 * errand when it starts with a quantity and a unit ("two gallons", "2 dozen",
 * "a loaf"), or names a store ("from the store", "at the market") and opens
 * with the thing to get rather than with "back", "I", "we"...
 */
const ERRAND_QUANTITY = '(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a couple of|couple of|some|\\d+)'
const ERRAND_UNIT = '(?:gallons?|half gallons?|quarts?|pints?|liters?|litres?|pounds?|lbs?|ounces?|oz|dozen|bags?|boxes?|packs?|packages?|cans?|bottles?|cartons?|jugs?|jars?|loaf|loaves|rolls?|bunch(?:es)?|cases?|sticks?|heads?|bars?)'
const ERRAND_PLACE = '(?:from|at)\\s+(?:the\\s+)?(?:store|grocery(?:\\s+store)?|groceries|market|supermarket|pharmacy|drug\\s*store|hardware\\s+store|gas\\s+station|costco|walmart|target|aldi|wegmans|shoprite|cvs|walgreens|home\\s+depot|lowes|sams(?:\\s+club)?|trader\\s+joes|whole\\s+foods|price\\s+chopper|hannaford)\\b'
const NOT_AN_ERRAND_START = new Set([
  'back', 'came', 'come', 'coming', 'just', 'already', 'still', 'i', 'im', 'we', 'you', 'he', 'she', 'they',
  'it', 'this', 'that', 'there', 'was', 'were', 'been', 'got', 'home', 'went', 'go', 'going',
])

export function isErrandClause(raw) {
  const source = actionSource(raw)
  if (!source) return false
  if (new RegExp(`^${ERRAND_QUANTITY}\\s+${ERRAND_UNIT}\\b`).test(source)) return true
  const [first] = source.split(' ')
  return new RegExp(`\\b${ERRAND_PLACE}`).test(source) && !NOT_AN_ERRAND_START.has(first) && source.split(' ').length <= 10
}

/** "Two gallons of milk from the store" → "Get two gallons of milk from the store". */
export function errandLabel(raw) {
  const label = cleanTaskClause(raw)
  if (!label) return ''
  const [first] = actionSource(raw).split(' ')
  if (ACTION_WORDS.has(first)) return label
  return `Get ${label.charAt(0).toLowerCase()}${label.slice(1)}`
}

export function isActionableTaskClause(raw) {
  const source = actionSource(raw)
  if (!source) return false
  if (isErrandClause(raw)) return true
  if (/^(?:(?:i|we)\s+(?:need|want|have|got|gotta|should|must)\s+(?:to\s+)?|(?:need|remember)\s+to\s+)/.test(source)) {
    return true
  }
  const [first] = source.split(' ')
  return ACTION_WORDS.has(first)
}

/**
 * Match one spoken walk-through to routines.
 *
 * @param {string} text
 * @param {Array<{id: string, name: string, aliases?: string[], items: Array<{label: string, aliases?: string[]}>}>} templates
 *   the routines that can be named (the hub passes today's on-demand ones for a space)
 * @returns {{ transcript: string, matches: Array<{template: object, startIndex: number, source: string}>,
 *   unmatched: string[], unmatchedSources: string[], unmatchedErrands: boolean[], fragments: Array<{label: string, source: string}> }}
 */
export function matchDayIntent(text, templates) {
  const transcript = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 4_000)
  const byId = new Map()
  const unmatched = []
  const unmatchedSources = []
  // Errands ("two gallons of milk from the store") go to the household list
  // at commit rather than becoming Home tasks (Mike, 2026-10-18).
  const unmatchedErrands = []
  const fragments = []

  for (const rawClause of dayClauses(transcript)) {
    const clause = normalizeMatchText(rawClause)
    const found = templates.filter(template => {
      const phrases = [template.name, template.id, ...(Array.isArray(template.aliases) ? template.aliases : [])]
      return phrases.some(phrase => containsPhrase(clause, phrase))
    })

    if (found.length === 0) {
      const label = isErrandClause(rawClause) ? errandLabel(rawClause) : cleanTaskClause(rawClause)
      if (!label) continue
      if (!isActionableTaskClause(rawClause)) {
        fragments.push({ label, source: rawClause })
        continue
      }
      unmatched.push(label)
      unmatchedSources.push(rawClause)
      unmatchedErrands.push(isErrandClause(rawClause))
      continue
    }

    for (const template of found) {
      let startIndex = 0
      // A step named like its routine ("Vacuum" in Vacuum) is not a cue to
      // skip ahead: "vacuum" starts at the top (v0.172.0).
      const routinePhrases = new Set([template.name, template.id, ...(Array.isArray(template.aliases) ? template.aliases : [])]
        .map(normalizeMatchText))
      for (let i = 0; i < template.items.length; i += 1) {
        const item = template.items[i]
        const phrases = [item.label, ...(Array.isArray(item.aliases) ? item.aliases : [])]
          .filter(phrase => !routinePhrases.has(normalizeMatchText(phrase)))
        if (phrases.some(phrase => containsPhrase(clause, phrase))) {
          startIndex = i
          break
        }
      }
      const prior = byId.get(template.id)
      if (!prior || startIndex < prior.startIndex) byId.set(template.id, { template, startIndex, source: rawClause })
    }
  }

  return { transcript, matches: [...byId.values()], unmatched, unmatchedSources, unmatchedErrands, fragments }
}

/**
 * "Remind me to call the plumber" → "call the plumber". Only unmistakable,
 * complete voice commands become tasks automatically.
 */
export function parseReminder(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
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
