/**
 * Public snapshot stand-in. The household rules are part of WAM Home, which is
 * private; this keeps the public hub runnable with a plain list (every sentence
 * is one item, nothing is routed).
 */
export const itemKey = name => String(name ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

export function itemLabel(item) {
  const name = item.name || item.text
  return `${item.qty > 1 ? `${item.qty} × ` : ''}${name}${item.unit ? ` (${item.unit})` : ''}`
}

export function parseListSpeech(text) {
  return String(text ?? '').split(/[.!?\n]+/).map(s => s.trim()).filter(Boolean)
    .map(sentence => ({ type: 'add', name: sentence, qty: 1, unit: null, raw: true, text: sentence }))
}
