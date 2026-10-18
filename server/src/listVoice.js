/**
 * Household list speech → list changes. Fixed rules, no model.
 *
 * Mike, 2026-10-18 (docs/SHOPPING-LIST-SPEC.md): anyone in the house walks up
 * to the iPad and says "milk, eggs and two loaves of bread", "we got the
 * eggs", "make it three milk", "milk, urgent" — and the list is right.
 *
 * `parseListSpeech(text, items)` reads a whole-clip transcript and returns the
 * changes it asks for; it does not touch storage. Each sentence is matched in
 * the spec's order — undo, remove, check off, quantity, clear, urgent, add —
 * and the first rule that matches wins. Anything not understood still comes
 * back as an add of the words as said (`raw: true`): capture never fails.
 */

const NUMBER_WORDS = new Map([
  ['a', 1], ['an', 1], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6],
  ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12],
  ['a couple of', 2], ['couple of', 2], ['a couple', 2], ['a few', 3], ['few', 3],
])
const QUANTITY = '(\\d+|a couple of|couple of|a couple|a few|an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)'

/** unit word (singular or plural) → stored singular */
const UNITS = new Map(Object.entries({
  gallon: 'gallon', gallons: 'gallon', 'half gallon': 'half gallon', 'half gallons': 'half gallon',
  quart: 'quart', quarts: 'quart', pint: 'pint', pints: 'pint', liter: 'liter', liters: 'liter',
  pound: 'pound', pounds: 'pound', lb: 'pound', lbs: 'pound', ounce: 'ounce', ounces: 'ounce',
  dozen: 'dozen', bag: 'bag', bags: 'bag', box: 'box', boxes: 'box', pack: 'pack', packs: 'pack',
  package: 'pack', packages: 'pack', can: 'can', cans: 'can', bottle: 'bottle', bottles: 'bottle',
  carton: 'carton', cartons: 'carton', jug: 'jug', jugs: 'jug', jar: 'jar', jars: 'jar',
  loaf: 'loaf', loaves: 'loaf', roll: 'roll', rolls: 'roll', bunch: 'bunch', bunches: 'bunch',
  case: 'case', cases: 'case', stick: 'stick', sticks: 'stick', head: 'head', heads: 'head',
  bar: 'bar', bars: 'bar',
}))
const UNIT_ALT = [...UNITS.keys()].sort((a, b) => b.length - a.length).map(u => u.replace(/ /g, '\\s+')).join('|')

/** Names with "and" inside them stay whole. Editable. */
export const COMPOUND_NAMES = [
  'mac and cheese', 'macaroni and cheese', 'salt and pepper', 'half and half', 'peanut butter and jelly',
  'chips and salsa', 'bread and butter pickles', 'franks and beans', 'pork and beans', 'cookies and cream',
  'sweet and sour sauce', 'oil and vinegar', 'rice and beans', 'ham and cheese',
]

const FILLER = /^(?:(?:um+|uh+|er+|okay|ok|so|oh|hey|alright|all right|yeah|and|also|plus|please)[,\s]+)+/
const ADD_LEAD = /^(?:(?:can you|could you|please)\s+)?(?:add|put|we need|we're out of|we are out of|were out of|out of|need|i need|get|grab|pick up|buy|we need some|we need more|we need to get|need to get|i need to get|add some|get some)\s+/
const ADD_TAIL = /\s+(?:to|on|onto)\s+(?:the\s+)?(?:shopping\s+|grocery\s+)?list$|\s+(?:from|at)\s+the\s+(?:store|grocery store|market|supermarket)$|\s+(?:for|from)\s+the\s+store$|\s+please$/

/** "Eggs" and "egg" are the same item; "tomatoes" and "tomato" too. */
export function itemKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(?:the|some|of|a|an|more)\b/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => {
      if (word.length <= 3 || word.endsWith('ss')) return word
      if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
      if (word.endsWith('oes')) return word.slice(0, -2)
      if (word.endsWith('s')) return word.slice(0, -1)
      return word
    })
    .join(' ')
}

function clean(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' ,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(FILLER, '')
    .trim()
}

function numberOf(word) {
  if (/^\d+$/.test(word)) return Number(word)
  return NUMBER_WORDS.get(word) ?? null
}

/** "two gallons of milk" → { name: 'milk', qty: 2, unit: 'gallon' } */
export function parseItem(phrase) {
  let text = clean(phrase).replace(/,/g, ' ').replace(/\s+/g, ' ').replace(ADD_TAIL, '').trim()
  if (!text) return null
  let qty = 1
  let unit = null
  const withUnit = text.match(new RegExp(`^${QUANTITY}\\s+(${UNIT_ALT})\\s+(?:of\\s+)?(.+)$`))
  const unitOnly = text.match(new RegExp(`^(${UNIT_ALT})\\s+(?:of\\s+)?(.+)$`))
  const countOnly = text.match(new RegExp(`^${QUANTITY}\\s+(?:of\\s+)?(.+)$`))
  if (withUnit) {
    qty = numberOf(withUnit[1]) ?? 1
    unit = UNITS.get(withUnit[2].replace(/\s+/g, ' ')) ?? null
    text = withUnit[3]
  } else if (unitOnly && unitOnly[2]) {
    // "dozen eggs" / "loaf of bread"
    unit = UNITS.get(unitOnly[1].replace(/\s+/g, ' ')) ?? null
    text = unitOnly[2]
  } else if (countOnly) {
    qty = numberOf(countOnly[1]) ?? 1
    text = countOnly[2]
  }
  text = text.replace(/^(?:the|some|more)\s+/, '').trim()
  if (!text) return null
  return { name: text, qty, unit }
}

/** Split "milk eggs and bread, also two loaves of bread" into item phrases. */
export function splitItems(text) {
  let body = ` ${clean(text)} `
  const kept = []
  for (const [i, name] of COMPOUND_NAMES.entries()) {
    const re = new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`, 'g')
    body = body.replace(re, () => {
      kept.push(name)
      return ` __c${kept.length - 1}__ `
    })
    void i
  }
  const parts = body
    .split(/,|\band\b|\balso\b|\bplus\b|\bas well as\b/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part.replace(/__c(\d+)__/g, (_, n) => kept[Number(n)]))
  // No splitting of comma-less word runs: it broke "paper towels" and
  // "dish soap" into separate items. Whole-clip whisper punctuates spoken
  // lists, and the spoken confirmation + Undo catch the rare miss. P2's
  // grocery word list can split "milk eggs" safely once it knows the items.
  return parts
}

function findItem(name, items) {
  const key = itemKey(name)
  if (!key) return null
  const live = items.filter(item => !item.removedAt && item.status !== 'done')
  const exact = live.filter(item => itemKey(item.name || item.text) === key)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    // Same name on two rows ("2 gallons of milk" and "milk"): the plain row is
    // what a bare "milk" means; otherwise the one touched most recently.
    const plain = exact.filter(item => !item.unit)
    if (plain.length === 1) return plain[0]
    return [...exact].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
  }
  const loose = live.filter(item => {
    const other = itemKey(item.name || item.text)
    return other.includes(key) || key.includes(other)
  })
  return loose.length === 1 ? loose[0] : null
}

function sentences(text) {
  return String(text ?? '')
    .split(/[.!?;\n]+/)
    .map(part => part.trim())
    .filter(Boolean)
}

/**
 * @returns {Array<{type: string, name?: string, qty?: number|null, unit?: string|null,
 *   delta?: number, urgent?: boolean, itemId?: string|null, raw?: boolean, text: string}>}
 */
export function parseListSpeech(text, items = []) {
  const ops = []
  for (const sentence of sentences(text)) {
    const s = clean(sentence).replace(/,\s*$/, '')
    if (!s) continue
    const ref = name => ({ name: parseItem(name)?.name ?? name, itemId: findItem(parseItem(name)?.name ?? name, items)?.id ?? null })

    if (/^(?:undo|undo that|never mind|nevermind|scratch that|cancel that|take that back)$/.test(s)) {
      ops.push({ type: 'undo', text: sentence })
      continue
    }

    let m = s.match(/^(?:remove|delete|cross off|cross out|take off|take)\s+(.+?)(?:\s+off)?(?:\s+(?:of|from)\s+the\s+list|\s+off\s+the\s+list)?$/) ||
      s.match(/^(?:we\s+)?(?:don't|do not|dont)\s+need\s+(?:any\s+)?(?:more\s+)?(.+?)(?:\s+anymore)?$/) ||
      s.match(/^no\s+more\s+(.+)$/)
    if (m) {
      for (const part of splitItems(m[1])) ops.push({ type: 'remove', ...ref(part), text: sentence })
      continue
    }

    m = s.match(/^(?:we\s+|i\s+)?(?:got|bought|picked up|grabbed|have)\s+(?:the\s+)?(.+)$/) ||
      s.match(/^(?:check|tick|mark)\s+off\s+(?:the\s+)?(.+)$/) ||
      s.match(/^(?:check|tick)\s+(?:the\s+)?(.+?)\s+off$/) ||
      s.match(/^(.+?)\s+(?:is|are)\s+(?:done|bought|in the cart)$/)
    if (m) {
      for (const part of splitItems(m[1])) ops.push({ type: 'done', ...ref(part), text: sentence })
      continue
    }

    m = s.match(new RegExp(`^(?:make it|make that|make)\\s+${QUANTITY}\\s+(?:(${UNIT_ALT})\\s+(?:of\\s+)?)?(.+)$`)) ||
      s.match(new RegExp(`^change\\s+(?:the\\s+)?(.+?)\\s+to\\s+${QUANTITY}(?:\\s+(${UNIT_ALT}))?$`))
    if (m) {
      const changeForm = /^change\b/.test(s)
      const [qtyWord, unitWord, name] = changeForm ? [m[2], m[3], m[1]] : [m[1], m[2], m[3]]
      ops.push({
        type: 'qty', ...ref(name), qty: numberOf(qtyWord) ?? 1,
        unit: unitWord ? UNITS.get(unitWord.replace(/\s+/g, ' ')) ?? null : undefined, text: sentence,
      })
      continue
    }
    m = s.match(/^(?:add\s+)?(?:another|one more)\s+(.+)$/) ||
      s.match(new RegExp(`^(?:add\\s+)?${QUANTITY}\\s+more\\s+(.+)$`))
    if (m) {
      const delta = m.length > 2 ? numberOf(m[1]) ?? 1 : 1
      const name = m.length > 2 ? m[2] : m[1]
      ops.push({ type: 'qty', ...ref(name), delta, text: sentence })
      continue
    }

    if (/^clear\s+(?:the\s+|my\s+)?(?:whole\s+)?(?:list|groceries|grocery list|shopping list|everything)$/.test(s)) {
      ops.push({ type: 'clear', text: sentence })
      continue
    }

    m = s.match(/^(?:make|mark)\s+(?:the\s+)?(.+?)\s+urgent$/) ||
      s.match(/^(.+?)\s+(?:is|are)\s+urgent$/) ||
      s.match(/^(?:we\s+)?urgently\s+need\s+(.+)$/) ||
      s.match(/^urgent\s*,?\s*(.+)$/) ||
      s.match(/^(.+?)\s*,?\s+urgent(?:ly)?$/)
    if (m) {
      const body = m[1].replace(ADD_LEAD, '')
      for (const part of splitItems(body)) {
        const item = parseItem(part)
        if (!item) continue
        const existing = findItem(item.name, items)
        ops.push(existing
          ? { type: 'urgent', name: item.name, itemId: existing.id, urgent: true, text: sentence }
          : { type: 'add', ...item, urgent: true, text: sentence })
      }
      continue
    }

    // Add: the default. A lead-in makes it certain; a bare list is still an add.
    const body = s.replace(ADD_LEAD, '').replace(ADD_TAIL, '')
    const led = body !== s
    const parts = splitItems(body)
    const parsed = parts.map(parseItem).filter(Boolean)
    // Too long and no lead-in: probably talk, not a list. Keep it whole, as said.
    if (!led && (parsed.length === 0 || (parts.length === 1 && body.split(' ').length > 6))) {
      ops.push({ type: 'add', name: sentence.trim(), qty: 1, unit: null, raw: true, text: sentence })
      continue
    }
    for (const item of parsed) ops.push({ type: 'add', ...item, text: sentence })
  }
  return ops
}

const PLURAL_UNIT = { loaf: 'loaves', box: 'boxes', bunch: 'bunches', 'half gallon': 'half gallons' }

/** "2 gallons of milk" / "a dozen eggs" / "milk" — how an item is said aloud. */
export function spokenLabel({ name, qty = 1, unit = null }) {
  if (unit) {
    const units = qty > 1 ? PLURAL_UNIT[unit] ?? `${unit}s` : unit
    return `${qty > 1 ? qty : unit === 'dozen' ? 'a' : /^[aeiou]/.test(unit) ? 'an' : 'a'} ${units}${unit === 'dozen' ? '' : ' of'} ${name}`
  }
  return qty > 1 ? `${qty} ${name}` : name
}

/** One short sentence for the kiosk to say back. */
export function confirmationText(applied) {
  const names = type => applied.filter(change => change.type === type).map(change => change.spoken ?? change.label)
  const list = words => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`)
  const parts = []
  if (names('add').length) parts.push(`Added ${list(names('add'))}`)
  if (names('merge').length) parts.push(`Now ${list(names('merge'))}`)
  if (names('done').length) parts.push(`Checked off ${list(names('done'))}`)
  if (names('remove').length) parts.push(`Removed ${list(names('remove'))}`)
  if (names('qty').length) parts.push(`Updated ${list(names('qty'))}`)
  if (names('urgent').length) parts.push(`${list(names('urgent'))} ${names('urgent').length > 1 ? 'are' : 'is'} urgent`)
  if (applied.some(change => change.type === 'undo')) parts.push('Undone')
  if (applied.some(change => change.type === 'clear')) parts.push('Tap confirm to clear the list')
  if (names('missing').length) parts.push(`Couldn't find ${list(names('missing'))}`)
  return parts.length ? parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('. ') + '.' : 'Nothing changed.'
}
