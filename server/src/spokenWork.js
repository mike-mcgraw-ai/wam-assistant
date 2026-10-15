import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { coalesceTranscriptSegments } from './transcript.js'

const REVIEW_STATES = new Set(['unreviewed', 'needs_clarification', 'reviewed', 'done', 'ignored', 'merged', 'split'])
const CLASSIFICATIONS = new Set(['task', 'project', 'idea', 'memory', 'product_feedback', 'mixed', 'reference', 'unknown'])
const DESTINATIONS = new Set(['project', 'idea', 'memory'])
const ACTIVE_STATES = new Set(['unreviewed', 'needs_clarification'])

function clean(value, max = 12_000) {
  return String(value ?? '').replace(/\r/g, '').trim().slice(0, max)
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function titleFrom(text, fallback = 'Untitled spoken work') {
  const first = clean(text).split(/[\n.!?]/).map(part => part.trim()).find(Boolean)
  return clean(first || fallback, 80)
}

function normalizeSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .filter(segment => segment?.final !== false && clean(segment?.text))
    .map(segment => ({
      id: clean(segment.id, 120) || randomUUID(),
      clientId: clean(segment.clientId, 120) || null,
      at: Number(segment.at) || Date.now(),
      speaker: clean(segment.speaker, 32) || 'someone',
      text: clean(segment.text, 2_000),
    }))
}

function sourceText(segments, fallback = '') {
  return coalesceTranscriptSegments(segments).map(segment => segment.text).join('\n\n').trim() || clean(fallback)
}

function initialProposal(text, sourceType) {
  const heard = clean(text)
  const questionable = /\bclean the (?:cap|wheel room)\b/i.test(heard)
  const empty = !heard
  const questions = []
  if (/\bclean the cap\b/i.test(heard)) questions.push('Did you mean “Clean the kitchen”?')
  if (/\bclean the wheel room\b/i.test(heard)) questions.push('Did you mean “Clean the living room”?')
  if (/\borganize drawers\b/i.test(heard)) questions.push('Which drawers, and is this one task or a larger plan?')
  if (empty) questions.push('What was said in this recording?')
  const taskCommand = heard.match(/^(?:add|create|make)\s+(?:a\s+)?(?:task|to-?do)\s+(?:to\s+)?([^\n]+)$/i)
  const classification = taskCommand ? 'task'
    : sourceType === 'start_day' ? 'mixed'
      : sourceType === 'task_voice_note' ? 'reference'
        : 'unknown'
  const candidate = taskCommand ? [{
    id: 'c1', kind: 'task', title: titleFrom(taskCommand[1]), detail: heard,
    evidenceSegmentIds: [], confidence: 0.85,
  }] : []
  return {
    title: titleFrom(taskCommand?.[1] || heard, empty ? 'Recording needs transcript' : 'Untitled spoken work'),
    summary: heard.slice(0, 1_200),
    candidates: candidate,
    classification,
    confidence: { score: taskCommand ? 0.85 : questionable || empty ? 0.3 : 0.5, reasons: taskCommand ? ['explicit task command'] : ['needs human review'] },
    clarificationQuestions: questions,
    reviewState: questions.length ? 'needs_clarification' : 'unreviewed',
  }
}

export class SpokenWork {
  constructor({ logPath, indexPath }) {
    this.logPath = logPath
    this.indexPath = indexPath
    this.items = new Map()
    this.resources = new Map()
    this.sourceIds = new Map()
    this.commands = new Map()
    this.events = []
    this.#load()
  }

  #load() {
    if (!this.logPath || !existsSync(this.logPath)) return
    for (const line of readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean)) {
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (!event?.id || !event?.item) continue
      this.#apply(event)
    }
  }

  #apply(event) {
    this.events.push(event)
    this.items.set(event.item.id, event.item)
    for (const key of [event.item.sourceKey, ...(event.item.sourceAliases || [])]) {
      if (key) this.sourceIds.set(key, event.item.id)
    }
    if (event.resource) this.resources.set(event.resource.id, event.resource)
    if (event.commandId) this.commands.set(event.commandId, event.item.id)
  }

  #commit(type, item, { commandId = null, actor = 'system', change = null, resource = null } = {}) {
    if (!this.logPath) throw new Error('spoken work log required')
    const event = {
      id: randomUUID(), type, at: Date.now(), actor, commandId,
      item: plain(item), ...(change ? { change: plain(change) } : {}),
      ...(resource ? { resource: plain(resource) } : {}),
    }
    mkdirSync(dirname(this.logPath), { recursive: true, mode: 0o700 })
    appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 })
    this.#apply(event)
    if (this.indexPath) {
      mkdirSync(dirname(this.indexPath), { recursive: true, mode: 0o700 })
      const temp = `${this.indexPath}.tmp`
      writeFileSync(temp, JSON.stringify({ items: [...this.items.values()], resources: [...this.resources.values()] }), { mode: 0o600 })
      renameSync(temp, this.indexPath)
    }
    return plain(item)
  }

  get(id) {
    const item = this.items.get(id)
    return item ? plain(item) : null
  }

  all() {
    return plain([...this.items.values()])
  }

  bySource(sourceKey) {
    const id = this.sourceIds.get(sourceKey)
    return id ? this.get(id) : null
  }

  list({ state = 'active', limit = 100, cursor = 0 } = {}) {
    const all = [...this.items.values()]
      .filter(item => state === 'all' || (state === 'active' ? ACTIVE_STATES.has(item.reviewState) : item.reviewState === state))
      .sort((left, right) => right.capturedAt - left.capturedAt || left.id.localeCompare(right.id))
    const offset = Math.max(0, Number(cursor) || 0)
    const rows = all.slice(offset, offset + Math.min(200, Math.max(1, Number(limit) || 100)))
    return { items: plain(rows), total: all.length, nextCursor: offset + rows.length < all.length ? offset + rows.length : null, needsReviewCount: this.count() }
  }

  count() {
    return [...this.items.values()].filter(item => ACTIVE_STATES.has(item.reviewState)).length
  }

  history(id) {
    return this.events.filter(event => event.item.id === id).map(({ item, ...event }) => ({ ...event, revision: item.revision }))
  }

  resource(id) {
    const row = this.resources.get(id)
    return row ? plain(row) : null
  }

  ingest(input, { commandId = null, actor = 'capture' } = {}) {
    const sourceKey = clean(input?.sourceKey, 240)
    if (!sourceKey) return { ok: false, code: 400, error: 'sourceKey required' }
    const aliases = [...new Set((Array.isArray(input.sourceAliases) ? input.sourceAliases : []).map(alias => clean(alias, 240)).filter(Boolean))]
    const known = [sourceKey, ...aliases].map(key => this.sourceIds.get(key)).find(Boolean)
    if (commandId && this.commands.has(commandId)) return { ok: true, existing: true, item: this.get(this.commands.get(commandId)) }
    const segments = normalizeSegments(input.rawSegments)
    const rawText = sourceText(segments, input.rawText)
    const audio = input.audio && typeof input.audio === 'object'
      ? { sessionId: clean(input.audio.sessionId, 120) || null, state: clean(input.audio.state, 32) || 'missing', kept: input.audio.kept === true, expiresAt: input.audio.expiresAt ?? null }
      : { sessionId: clean(input.sessionId, 120) || null, state: 'missing', kept: false, expiresAt: null }
    if (known) {
      const previous = this.items.get(known)
      const sourceAliases = [...new Set([...(previous.sourceAliases || []), sourceKey, ...aliases].filter(key => key !== previous.sourceKey))]
      const sourceRefs = [...previous.sourceRefs]
      for (const ref of Array.isArray(input.sourceRefs) ? input.sourceRefs : []) {
        if (!sourceRefs.some(current => current.store === ref.store && current.id === ref.id)) sourceRefs.push(ref)
      }
      const destinationRefs = [...previous.destinationRefs]
      for (const ref of Array.isArray(input.destinationRefs) ? input.destinationRefs : []) {
        if (!destinationRefs.some(current => current.kind === ref.kind && current.id === ref.id)) destinationRefs.push(ref)
      }
      const transcriptChanged = rawText && rawText !== previous.rawTranscript?.text && segments.length >= (previous.rawTranscript?.segments?.length || 0)
      const changed = sourceAliases.length !== (previous.sourceAliases || []).length ||
        sourceRefs.length !== previous.sourceRefs.length || destinationRefs.length !== previous.destinationRefs.length ||
        transcriptChanged || (input.complete === true && previous.rawTranscript?.complete !== true) ||
        (audio.state === 'available' && previous.audio?.state !== 'available')
      if (!changed) return { ok: true, existing: true, item: this.get(known) }
      const next = { ...previous, revision: previous.revision + 1, updatedAt: Date.now(), sourceAliases,
        sourceRefs, destinationRefs,
        rawTranscript: transcriptChanged
          ? { text: rawText, segments, complete: input.complete === true, source: clean(input.transcriptSource, 60) || 'coach' }
          : { ...previous.rawTranscript, complete: previous.rawTranscript.complete || input.complete === true },
        audio: audio.state === 'available' ? audio : previous.audio }
      if (transcriptChanged && previous.provenance?.humanEditedFields?.length === 0) {
        const proposal = initialProposal(rawText, next.sourceType)
        Object.assign(next, { ...proposal, cleanedTranscript: rawText })
      }
      return { ok: true, existing: true, item: this.#commit('source_linked', next, { commandId, actor }) }
    }
    const now = Date.now()
    const sourceType = clean(input.sourceType, 40) || 'unknown'
    const proposal = initialProposal(rawText, sourceType)
    const suggestedSummary = clean(input.summary, 1_200)
    if (suggestedSummary) {
      proposal.summary = suggestedSummary
      proposal.title = titleFrom(suggestedSummary)
    }
    if (input.ingest === 'migration') {
      proposal.title = clean(input.title, 80) || proposal.title
      if (Array.isArray(input.destinationRefs) && input.destinationRefs.length && proposal.reviewState !== 'needs_clarification') {
        proposal.reviewState = 'reviewed'
      }
    }
    const item = {
      id: /^sw_[a-z0-9-]+$/i.test(String(input.id || '')) ? input.id : `sw_${randomUUID()}`,
      schemaVersion: 1, revision: 1, sourceKey, sourceAliases: aliases,
      sourceType, modeId: clean(input.modeId, 80) || null,
      space: input.space === 'ops' ? 'ops' : 'life', sessionId: clean(input.sessionId, 120) || null,
      sourceRefs: Array.isArray(input.sourceRefs) ? plain(input.sourceRefs) : [],
      capturedAt: Number(input.capturedAt) || now, endedAt: Number(input.endedAt) || null,
      ingestedAt: now, updatedAt: now,
      rawTranscript: { text: rawText, segments, complete: input.complete === true, source: clean(input.transcriptSource, 60) || 'coach' },
      audio, cleanedTranscript: clean(input.cleanedTranscript) || rawText, ...proposal,
      extraction: { state: 'not_processed', error: null, transcriptRevision: 1 },
      destinationRefs: Array.isArray(input.destinationRefs) ? plain(input.destinationRefs) : [],
      parentId: null, childIds: [], mergedInto: null,
      provenance: { ingest: clean(input.ingest, 40) || 'capture', extractor: 'deterministic', modelJobId: null, modelVersion: null, humanEditedFields: [] },
    }
    return { ok: true, existing: false, item: this.#commit('ingested', item, { commandId, actor }) }
  }

  update(id, patch, { revision, commandId, actor = 'mike' } = {}) {
    if (commandId && this.commands.has(commandId)) return { ok: true, duplicate: true, item: this.get(this.commands.get(commandId)) }
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (Number(revision) !== prior.revision) return { ok: false, code: 409, error: 'item changed', item: this.get(id) }
    const allowed = ['cleanedTranscript', 'title', 'summary', 'classification', 'candidates', 'clarificationQuestions']
    const change = {}
    const next = plain(prior)
    for (const field of allowed) {
      if (!(field in patch)) continue
      let value = patch[field]
      if (field === 'classification') {
        if (!CLASSIFICATIONS.has(value)) return { ok: false, code: 400, error: 'invalid classification' }
      } else if (field === 'candidates' || field === 'clarificationQuestions') {
        if (!Array.isArray(value)) return { ok: false, code: 400, error: `invalid ${field}` }
        value = plain(value).slice(0, 30)
      } else value = clean(value, field === 'title' ? 80 : 12_000)
      if (JSON.stringify(next[field]) === JSON.stringify(value)) continue
      change[field] = { before: next[field], after: value }
      next[field] = value
    }
    if (Object.keys(change).length === 0) return { ok: true, item: this.get(id) }
    next.revision += 1
    next.updatedAt = Date.now()
    next.provenance.humanEditedFields = [...new Set([...next.provenance.humanEditedFields, ...Object.keys(change)])]
    return { ok: true, item: this.#commit('corrected', next, { commandId, actor, change }) }
  }

  action(id, action, { revision, commandId, actor = 'mike' } = {}) {
    if (commandId && this.commands.has(commandId)) return { ok: true, duplicate: true, item: this.get(this.commands.get(commandId)) }
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (Number(revision) !== prior.revision) return { ok: false, code: 409, error: 'item changed', item: this.get(id) }
    if (!REVIEW_STATES.has(action) || ['merged', 'split', 'unreviewed'].includes(action)) return { ok: false, code: 400, error: 'invalid action' }
    const next = { ...prior, reviewState: action, revision: prior.revision + 1, updatedAt: Date.now() }
    return { ok: true, item: this.#commit(action === 'ignored' ? 'ignored' : action === 'done' ? 'marked_done' : 'restored', next, { commandId, actor, change: { reviewState: { before: prior.reviewState, after: action } } }) }
  }

  beginPromotion(id, kind, { revision, commandId, actor = 'mike', candidateId = null } = {}) {
    if (commandId && this.commands.has(commandId)) return { ok: true, duplicate: true, item: this.get(this.commands.get(commandId)) }
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (Number(revision) !== prior.revision) return { ok: false, code: 409, error: 'item changed', item: this.get(id) }
    if (!['task', 'project', 'idea', 'memory', 'start_day'].includes(kind)) return { ok: false, code: 400, error: 'invalid destination' }
    if (prior.reviewState === 'merged' || prior.reviewState === 'split') return { ok: false, code: 409, error: 'item is superseded' }
    const pending = { kind, candidateId, commandId: commandId || randomUUID(), requestedAt: Date.now() }
    const next = { ...prior, pendingPromotion: pending, revision: prior.revision + 1, updatedAt: Date.now() }
    return { ok: true, item: this.#commit('promotion_requested', next, { commandId: pending.commandId, actor }) }
  }

  finishPromotion(id, kind, destinationId, { commandId, actor = 'system', resource = null } = {}) {
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (prior.destinationRefs.some(ref => ref.kind === kind && ref.id === destinationId)) return { ok: true, duplicate: true, item: this.get(id) }
    const next = { ...prior, revision: prior.revision + 1, updatedAt: Date.now(), reviewState: 'reviewed', pendingPromotion: null,
      destinationRefs: [...prior.destinationRefs, { kind, id: destinationId, createdAt: Date.now(), syncRevision: prior.revision + 1 }] }
    return { ok: true, item: this.#commit('promotion_applied', next, { commandId, actor, resource }) }
  }

  promoteResource(id, kind, { revision, commandId, actor = 'mike', title = null } = {}) {
    if (!DESTINATIONS.has(kind)) return { ok: false, code: 400, error: 'invalid destination' }
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    const destinationId = `${kind}:${id}`
    const existing = this.resource(destinationId)
    if (existing) return { ok: true, duplicate: true, item: this.get(id), resource: existing }
    if (Number(revision) !== prior.revision) return { ok: false, code: 409, error: 'item changed', item: this.get(id) }
    if (kind === 'memory' && prior.audio.state === 'available' && !prior.audio.kept) return { ok: false, code: 409, error: 'keep recording before saving memory' }
    const resource = { id: destinationId, kind, title: clean(title, 80) || prior.title, summary: prior.summary,
      sourceItemId: id, sourceKey: prior.sourceKey, transcript: prior.cleanedTranscript,
      audioSessionId: prior.audio.state === 'available' ? prior.audio.sessionId : null,
      audioState: prior.audio.state, createdAt: Date.now() }
    const result = this.finishPromotion(id, kind, destinationId, { commandId, actor, resource })
    return { ...result, resource }
  }

  split(id, parts, { revision, commandId, actor = 'mike' } = {}) {
    if (commandId && this.commands.has(commandId)) return { ok: true, duplicate: true, item: this.get(this.commands.get(commandId)) }
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (Number(revision) !== prior.revision) return { ok: false, code: 409, error: 'item changed', item: this.get(id) }
    if (!Array.isArray(parts) || parts.length < 2) return { ok: false, code: 400, error: 'at least two parts required' }
    const children = []
    for (const [index, part] of parts.entries()) {
      const selected = (prior.rawTranscript.segments || []).filter(segment => (part.segmentIds || []).includes(segment.id))
      if (!selected.length) return { ok: false, code: 400, error: `part ${index + 1} has no source segments` }
      const text = sourceText(selected)
      const proposal = initialProposal(text, prior.sourceType)
      children.push({ ...plain(prior), id: `sw_${randomUUID()}`, revision: 1,
        sourceKey: `${prior.sourceKey}:part:${index + 1}`, sourceAliases: [],
        rawTranscript: { ...prior.rawTranscript, text, segments: selected }, cleanedTranscript: text,
        ...proposal, title: clean(part.title, 80) || proposal.title,
        destinationRefs: [], parentId: id, childIds: [], mergedInto: null, updatedAt: Date.now() })
    }
    for (const child of children) this.#commit('split_child', child, { actor })
    const next = { ...prior, revision: prior.revision + 1, updatedAt: Date.now(), reviewState: 'split', childIds: children.map(child => child.id) }
    return { ok: true, item: this.#commit('split', next, { commandId, actor }), children: children.map(child => this.get(child.id)) }
  }

  merge(targetId, sourceId, { revision, commandId, actor = 'mike' } = {}) {
    if (targetId === sourceId) return { ok: false, code: 400, error: 'select two different items' }
    if (commandId && this.commands.has(commandId)) return { ok: true, duplicate: true, item: this.get(this.commands.get(commandId)) }
    const target = this.items.get(targetId)
    const source = this.items.get(sourceId)
    if (!target || !source) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (Number(revision) !== target.revision) return { ok: false, code: 409, error: 'item changed', item: this.get(targetId) }
    if (source.reviewState === 'merged' || target.reviewState === 'merged') return { ok: false, code: 409, error: 'already merged' }
    const next = { ...target, revision: target.revision + 1, updatedAt: Date.now(),
      sourceAliases: [...new Set([...target.sourceAliases, source.sourceKey, ...source.sourceAliases])],
      sourceRefs: [...target.sourceRefs, ...source.sourceRefs],
      destinationRefs: [...target.destinationRefs, ...source.destinationRefs],
      summary: [target.summary, source.summary].filter(Boolean).join('\n\n').slice(0, 12_000) }
    this.#commit('merged_into', { ...source, revision: source.revision + 1, updatedAt: Date.now(), reviewState: 'merged', mergedInto: targetId }, { actor })
    return { ok: true, item: this.#commit('merge', next, { commandId, actor }) }
  }
}
