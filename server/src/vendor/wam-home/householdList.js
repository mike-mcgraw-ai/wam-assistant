/**
 * Public snapshot stand-in. The household rules are part of WAM Home, which is
 * private; this keeps the public hub runnable with a plain list (every sentence
 * is one item, nothing is routed).
 */
export function relinkAfterUndo() {}

export function applyListSpeech(ops, { inbox, by = 'Household', via = 'kiosk', changeId = `chg-${globalThis.crypto.randomUUID()}` }) {
  const applied = []
  for (const op of ops) {
    if (op.type !== 'add') continue
    const out = inbox.addItem({ name: op.name, raw: true, by, via, sourceText: op.text, changeId })
    if (out.ok) applied.push({ type: 'add', label: op.name })
  }
  return { changeId, applied, say: applied.length ? `Added ${applied.map(a => a.label).join(', ')}.` : 'Nothing added.' }
}
