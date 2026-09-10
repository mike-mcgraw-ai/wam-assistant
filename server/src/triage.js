/**
 * Inbox triage.
 *
 * Turns raw captured lines into something sorted. This is the one place an
 * LLM earns its keep here — splitting "grab milk and cat food" into two
 * shopping items, spotting that "do the garage this weekend" wants steps,
 * noticing "call the plumber" is a task with a phone call in it.
 *
 * It is deliberately NOT in the capture path. Triage runs on a timer, in a
 * batch, and is allowed to fail: an item that is never sorted still shows on
 * the glasses under "Unsorted", which is a working shared list on its own.
 * With no API key configured, that is exactly what happens and nothing breaks.
 */

const MODEL = process.env.TRIAGE_MODEL || 'claude-sonnet-4-5'
const ENDPOINT = 'https://api.anthropic.com/v1/messages'

const SYSTEM = `You sort raw voice-captured household notes into categories.

For each numbered line, return one object:
  id      the number you were given
  kind    "shopping" | "task" | "steps" | "reminder" | "note"
  list    a short list name, Title Case. Use "Groceries" for food and
          household supplies, "Hardware" for tools and DIY, "Errands" for
          things done away from home, "Home" for jobs around the house.
  parts   array of separate items, when one line holds several. "milk and cat
          food" is two. A single item is a one-element array.
  note    optional, max 8 words, only when it carries something the text does
          not already say. Usually omit.

Rules:
- Split conjunctions into separate parts. Do not merge distinct things.
- "steps" means a job with an obvious sequence worth expanding later.
- Keep the person's own words in parts. Do not tidy, expand or correct them.
- Never invent items that were not said.

Return ONLY a JSON array. No prose, no code fence.`

export class Triage {
  constructor(apiKey = process.env.ANTHROPIC_API_KEY || '') {
    this.apiKey = apiKey
    if (!apiKey) {
      console.log('[triage] ANTHROPIC_API_KEY not set — items stay under "Unsorted"')
    }
  }

  get enabled() {
    return Boolean(this.apiKey)
  }

  /**
   * Sort a batch. Returns [{id, kind, list, parts, note}] for whatever it
   * managed; anything missing simply stays raw and gets another go next time.
   */
  async sort(items) {
    if (!this.enabled || items.length === 0) return []

    const numbered = items.map((item, i) => `${i + 1}. ${item.text}`).join('\n')

    let body
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          system: SYSTEM,
          messages: [{ role: 'user', content: numbered }],
        }),
        signal: AbortSignal.timeout(30_000),
      })

      if (!res.ok) {
        console.warn(`[triage] ${res.status} — leaving ${items.length} item(s) raw`)
        return []
      }
      body = await res.json()
    } catch (err) {
      console.warn(`[triage] ${err.message} — leaving ${items.length} item(s) raw`)
      return []
    }

    const text = body?.content?.[0]?.text ?? ''
    let parsed
    try {
      // Be tolerant of a stray code fence rather than throwing the batch away.
      const cleaned = text.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim()
      parsed = JSON.parse(cleaned)
    } catch {
      console.warn('[triage] unparseable response — leaving items raw')
      return []
    }

    if (!Array.isArray(parsed)) return []

    const results = []
    for (const entry of parsed) {
      const index = Number(entry?.id) - 1
      const item = items[index]
      // A hallucinated index must not write onto the wrong item.
      if (!item) continue

      const parts = Array.isArray(entry.parts) && entry.parts.length
        ? entry.parts.map(p => String(p).slice(0, 120))
        : [item.text]

      results.push({
        itemId: item.id,
        kind: ['shopping', 'task', 'steps', 'reminder', 'note'].includes(entry.kind)
          ? entry.kind
          : 'note',
        list: String(entry.list || 'Unsorted').slice(0, 24),
        parts,
        note: entry.note ? String(entry.note).slice(0, 60) : null,
      })
    }
    return results
  }
}

/** Sweep pending items. Safe to call on a timer; a no-key install is a no-op. */
export async function sweepInbox(inbox, triage) {
  const pending = inbox.pending()
  if (pending.length === 0 || !triage.enabled) return 0

  // Small batches: one bad line should not strand twenty good ones.
  const batch = pending.slice(0, 10)
  const results = await triage.sort(batch)
  for (const r of results) inbox.sort(r.itemId, r)
  if (results.length) console.log(`[triage] sorted ${results.length}/${batch.length}`)
  return results.length
}
