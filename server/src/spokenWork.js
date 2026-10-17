import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { coalesceTranscriptSegments } from './transcript.js'

const REVIEW_STATES = new Set(['unreviewed', 'needs_clarification', 'reviewed', 'done', 'ignored', 'merged', 'split'])
const CLASSIFICATIONS = new Set(['task', 'project', 'idea', 'memory', 'product_feedback', 'mixed', 'reference', 'unknown'])
const DESTINATIONS = new Set(['project', 'idea', 'memory'])
const ACTIVE_STATES = new Set(['unreviewed', 'needs_clarification'])

export function spokenWorkProgress(items) {
  const progress = { total: items.length, needsReview: 0, reviewed: 0, ignored: 0, done: 0, other: 0 }
  for (const item of items) {
    if (ACTIVE_STATES.has(item.reviewState)) progress.needsReview += 1
    else if (['reviewed', 'ignored', 'done'].includes(item.reviewState)) progress[item.reviewState] += 1
    else progress.other += 1
  }
  return progress
}

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
    this.needsLineBreak = false
    this.#load()
  }

  #load() {
    if (!this.logPath || !existsSync(this.logPath)) return
    const contents = readFileSync(this.logPath, 'utf8')
    this.needsLineBreak = Boolean(contents) && !contents.endsWith('\n')
    for (const line of contents.split('\n').filter(Boolean)) {
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (!event?.id || (!event?.item && !Array.isArray(event?.items))) continue
      this.#apply(event)
    }
  }

  #apply(event) {
    this.events.push(event)
    for (const item of event.items || [event.item]) {
      this.items.set(item.id, item)
      for (const key of [item.sourceKey, ...(item.sourceAliases || [])]) {
        if (key) this.sourceIds.set(key, item.id)
      }
    }
    if (event.resource) this.resources.set(event.resource.id, event.resource)
    if (event.commandId) this.commands.set(event.commandId, (event.items?.at(-1) || event.item).id)
  }

  #commit(type, item, { commandId = null, actor = 'system', change = null, resource = null } = {}) {
    if (!this.logPath) throw new Error('spoken work log required')
    const event = {
      id: randomUUID(), type, at: Date.now(), actor, commandId,
      ...(Array.isArray(item) ? { items: plain(item) } : { item: plain(item) }),
      ...(change ? { change: plain(change) } : {}),
      ...(resource ? { resource: plain(resource) } : {}),
    }
    mkdirSync(dirname(this.logPath), { recursive: true, mode: 0o700 })
    try {
      appendFileSync(this.logPath, `${this.needsLineBreak ? '\n' : ''}${JSON.stringify(event)}\n`, { mode: 0o600 })
      this.needsLineBreak = false
    } catch (error) {
      this.needsLineBreak = true
      throw error
    }
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

  hasCommand(id, commandId) {
    return this.commands.get(commandId) === id
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
    return this.events.flatMap(({ item, items, ...event }) => {
      const matched = item?.id === id ? item : items?.find(row => row.id === id)
      return matched ? [{ ...event, revision: matched.revision }] : []
    })
  }

  resource(id) {
    const row = this.resources.get(id)
    return row ? plain(row) : null
  }

  ingest(input, { commandId = null, actor = 'capture' } = {}) {
    const sourceKey = clean(input?.sourceKey, 240)
    if (!sourceKey) return { ok: false, code: 400, error: 'sourceKey required' }
    const aliases = [...new Set((Array.isArray(input.sourceAliases) ? input.sourceAliases : []).map(alias => clean(alias, 240)).filter(Boolean))]
    const knownIds = [...new Set([sourceKey, ...aliases].map(key => this.sourceIds.get(key)).filter(Boolean))]
    if (knownIds.length > 1) return { ok: false, code: 409, error: 'source aliases belong to different review cards' }
    const known = knownIds[0]
    if (commandId && this.commands.has(commandId)) {
      const prior = this.get(this.commands.get(commandId))
      return prior && [prior.sourceKey, ...(prior.sourceAliases || [])].includes(sourceKey)
        ? { ok: true, existing: true, item: prior }
        : { ok: false, code: 409, error: 'command ID already belongs to another source' }
    }
    const segments = normalizeSegments(input.rawSegments)
    const rawText = clean(input.rawText, 1_000_000) || sourceText(segments)
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
      const destinationRefs = plain(previous.destinationRefs)
      for (const ref of Array.isArray(input.destinationRefs) ? input.destinationRefs : []) {
        const existingRef = destinationRefs.find(current => current.kind === ref.kind && current.id === ref.id)
        if (!existingRef) destinationRefs.push(ref)
        else if (ref.kind === 'start_day') {
          existingRef.itemIds = [...new Set([...(existingRef.itemIds || []), ...(ref.itemIds || [])])]
          existingRef.taskIds = [...new Set([...(existingRef.taskIds || []), ...(ref.taskIds || [])])]
          existingRef.committed = existingRef.committed === true || ref.committed === true
        }
      }
      const transcriptChanged = rawText && rawText !== previous.rawTranscript?.text && segments.length >= (previous.rawTranscript?.segments?.length || 0)
      const changed = sourceAliases.length !== (previous.sourceAliases || []).length ||
        sourceRefs.length !== previous.sourceRefs.length || destinationRefs.length !== previous.destinationRefs.length ||
        JSON.stringify(destinationRefs) !== JSON.stringify(previous.destinationRefs) ||
        transcriptChanged || (input.complete === true && previous.rawTranscript?.complete !== true) ||
        (audio.state === 'available' && (previous.audio?.state !== 'available' || audio.kept && !previous.audio?.kept))
      if (!changed) return { ok: true, existing: true, item: this.get(known) }
      const next = { ...previous, revision: previous.revision + 1, updatedAt: Date.now(), sourceAliases,
        sourceRefs, destinationRefs,
        reviewState: input.ingest === 'migration' && previous.reviewState === 'unreviewed' &&
          previous.destinationRefs.length === 0 && destinationRefs.length > 0 ? 'reviewed' : previous.reviewState,
        rawTranscript: transcriptChanged
          ? { text: rawText, segments, complete: input.complete === true, source: clean(input.transcriptSource, 60) || 'coach' }
          : { ...previous.rawTranscript, complete: previous.rawTranscript.complete || input.complete === true },
        audio: audio.state === 'available' ? audio : previous.audio,
        extraction: transcriptChanged
          ? { state: 'stale', error: null, transcriptRevision: (previous.extraction?.transcriptRevision || 1) + 1 }
          : previous.extraction }
      if (transcriptChanged && previous.provenance?.humanEditedFields?.length === 0 && ACTIVE_STATES.has(previous.reviewState)) {
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
      proposal.summary = clean(input.summary, 1_200) || proposal.summary
      proposal.classification = CLASSIFICATIONS.has(input.classification) ? input.classification : proposal.classification
      proposal.clarificationQuestions = Array.isArray(input.clarificationQuestions) ? plain(input.clarificationQuestions) : proposal.clarificationQuestions
      proposal.reviewState = REVIEW_STATES.has(input.reviewState) ? input.reviewState : proposal.reviewState
      if (Array.isArray(input.destinationRefs) && input.destinationRefs.length && proposal.reviewState !== 'needs_clarification') {
        proposal.reviewState = 'reviewed'
      }
    }
    if (Array.isArray(input.destinationRefs) && input.destinationRefs.length && proposal.reviewState === 'unreviewed') {
      proposal.reviewState = 'reviewed'
    }
    const item = {
      id: /^sw_[a-z0-9-]+$/i.test(String(input.id || '')) ? input.id : `sw_${randomUUID()}`,
      schemaVersion: 1, revision: 1, sourceKey, sourceAliases: aliases,
      sourceType, modeId: clean(input.modeId, 80) || null,
      space: input.space === 'ops' ? 'ops' : 'life', sessionId: clean(input.sessionId, 120) || null,
      sourceRefs: Array.isArray(input.sourceRefs) ? plain(input.sourceRefs) : [],
      capturedAt: input.ingest === 'migration' && !Number(input.capturedAt) ? null : Number(input.capturedAt) || now,
      ingestedAt: now, updatedAt: now,
      rawTranscript: { text: rawText, segments, complete: input.complete === true, source: clean(input.transcriptSource, 60) || 'coach' },
      audio, cleanedTranscript: clean(input.cleanedTranscript) || rawText, ...proposal,
      extraction: { state: 'not_processed', error: null, transcriptRevision: 1 },
      destinationRefs: Array.isArray(input.destinationRefs) ? plain(input.destinationRefs) : [],
      parentId: clean(input.parentId, 120) || null,
      amendmentKind: ['correction', 'detail'].includes(input.amendmentKind) ? input.amendmentKind : null,
      amendmentBaseRevision: Number.isInteger(input.amendmentBaseRevision) ? input.amendmentBaseRevision : null,
      amendmentOriginal: clean(input.amendmentOriginal, 12_000) || null,
      childIds: [], mergedInto: null,
      provenance: { ingest: clean(input.ingest, 40) || 'capture', extractor: 'deterministic', modelJobId: null, modelVersion: null, humanEditedFields: [] },
    }
    return { ok: true, existing: false, item: this.#commit('ingested', item, { commandId, actor }) }
  }

  update(id, patch, { revision, commandId, actor = 'mike' } = {}) {
    if (commandId && this.commands.has(commandId)) return { ok: true, duplicate: true, item: this.get(this.commands.get(commandId)) }
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (Number(revision) !== prior.revision) return { ok: false, code: 409, error: 'item changed', item: this.get(id) }
    if (prior.reviewState === 'merged' || prior.reviewState === 'split') return { ok: false, code: 409, error: 'item is superseded' }
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
    if (change.cleanedTranscript) {
      next.extraction = { state: 'stale', error: null,
        transcriptRevision: (prior.extraction?.transcriptRevision || 1) + 1 }
    }
    return { ok: true, item: this.#commit('corrected', next, { commandId, actor, change }) }
  }

  applyAmendment(id, { revision, commandId, actor = 'mike' } = {}) {
    if (commandId && this.commands.has(commandId)) return this.hasCommand(id, commandId)
      ? { ok: true, duplicate: true, item: this.get(id) }
      : { ok: false, code: 409, error: 'command ID belongs to another item' }
    const amendment = this.items.get(id)
    if (!amendment?.parentId) return { ok: false, code: 400, error: 'not a voice amendment' }
    if (Number(revision) !== amendment.revision) return { ok: false, code: 409, error: 'amendment changed', item: this.get(id) }
    const clarified = amendment.reviewState === 'needs_clarification' &&
      amendment.clarificationQuestions.length === 0 &&
      amendment.provenance?.humanEditedFields?.includes('cleanedTranscript')
    const transcriptReady = amendment.rawTranscript?.complete === true ||
      amendment.provenance?.humanEditedFields?.includes('cleanedTranscript') && amendment.clarificationQuestions.length === 0
    if (!(amendment.reviewState === 'unreviewed' || clarified) || !transcriptReady) {
      return { ok: false, code: 409, error: 'speech needs phone review or complete transcription first' }
    }
    const parent = this.items.get(amendment.parentId)
    if (!parent || parent.revision !== amendment.amendmentBaseRevision || ['merged', 'split'].includes(parent.reviewState)) {
      return { ok: false, code: 409, error: 'original changed; review both on phone before applying' }
    }
    const words = clean(amendment.cleanedTranscript, 12_000)
    if (!words) return { ok: false, code: 400, error: 'no amendment words' }
    const before = parent.cleanedTranscript
    const after = amendment.amendmentKind === 'correction' ? words : `${before}\n${words}`.trim()
    const now = Date.now()
    const humanFields = new Set(parent.provenance?.humanEditedFields || [])
    const corrected = amendment.amendmentKind === 'correction'
    const questions = corrected && !humanFields.has('clarificationQuestions') ? [] : parent.clarificationQuestions
    const title = corrected && !humanFields.has('title') ? titleFrom(words) : parent.title
    const summary = !humanFields.has('summary') ? (corrected ? words.slice(0, 1_200) : `${parent.summary}\n${words}`.trim().slice(0, 1_200)) : parent.summary
    const parentNext = { ...parent, revision: parent.revision + 1, updatedAt: now, cleanedTranscript: after,
      title, summary, clarificationQuestions: questions,
      reviewState: parent.reviewState === 'needs_clarification' && questions.length === 0 ? 'unreviewed' : parent.reviewState,
      childIds: [...new Set([...(parent.childIds || []), id])],
      sourceRefs: [...parent.sourceRefs, ...amendment.sourceRefs.filter(ref => !(ref.store === 'spoken-work' && ref.id === parent.id) &&
        !parent.sourceRefs.some(existing => existing.store === ref.store && existing.id === ref.id))],
      extraction: { state: 'stale', error: null, transcriptRevision: (parent.extraction?.transcriptRevision || 1) + 1 },
      provenance: { ...parent.provenance, humanEditedFields: [...new Set([...(parent.provenance?.humanEditedFields || []), 'cleanedTranscript',
        ...(title !== parent.title ? ['title'] : []), ...(summary !== parent.summary ? ['summary'] : []),
        ...(questions.length !== parent.clarificationQuestions.length ? ['clarificationQuestions'] : [])])] } }
    const amendmentNext = { ...amendment, revision: amendment.revision + 1, updatedAt: now, reviewState: 'reviewed' }
    this.#commit('amendment_applied', [parentNext, amendmentNext], { commandId, actor,
      change: { cleanedTranscript: { before, after }, title: { before: parent.title, after: title },
        summary: { before: parent.summary, after: summary }, clarificationQuestions: { before: parent.clarificationQuestions, after: questions },
        amendmentId: id, kind: amendment.amendmentKind } })
    return { ok: true, item: this.get(id), parent: this.get(parent.id) }
  }

  markExtraction(id, state, { jobId = null, error = null } = {}) {
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (!['processing', 'failed'].includes(state)) return { ok: false, code: 400, error: 'invalid extraction state' }
    if (prior.extraction?.state === state && prior.extraction?.jobId === jobId && prior.extraction?.error === error) {
      return { ok: true, item: this.get(id) }
    }
    const next = { ...prior, revision: prior.revision + 1, updatedAt: Date.now(),
      extraction: { ...prior.extraction, state, jobId, error: clean(error, 240) || null } }
    return { ok: true, item: this.#commit(state === 'failed' ? 'proposal_failed' : 'proposal_requested', next) }
  }

  applyProposal(id, proposal, { transcriptRevision, jobId = null, extractor = 'model', modelVersion = null } = {}) {
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (prior.extraction?.jobId === jobId && prior.extraction?.state === 'ready') return { ok: true, duplicate: true, item: this.get(id) }
    if (Number(transcriptRevision) !== prior.extraction?.transcriptRevision) {
      return { ok: false, code: 409, error: 'transcript changed before proposal arrived', item: this.get(id) }
    }
    if (jobId && prior.extraction?.jobId !== jobId) {
      return { ok: false, code: 409, error: 'proposal request was superseded', item: this.get(id) }
    }
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return { ok: false, code: 400, error: 'proposal object required' }
    const next = plain(prior)
    const human = new Set(prior.provenance?.humanEditedFields || [])
    for (const field of ['title', 'summary', 'classification', 'candidates', 'clarificationQuestions']) {
      if (human.has(field) || !(field in proposal)) continue
      const value = proposal[field]
      if (field === 'classification') {
        if (!CLASSIFICATIONS.has(value)) return { ok: false, code: 400, error: 'invalid classification proposal' }
        next[field] = value
      } else if (field === 'candidates' || field === 'clarificationQuestions') {
        if (!Array.isArray(value)) return { ok: false, code: 400, error: `invalid ${field} proposal` }
        next[field] = plain(value).slice(0, 30)
      } else next[field] = clean(value, field === 'title' ? 80 : 1_200)
    }
    if (proposal.confidence && typeof proposal.confidence === 'object') next.confidence = plain(proposal.confidence)
    if (!human.has('classification') && ['task', 'project', 'idea', 'memory', 'start_day'].includes(proposal.suggestedDestination)) {
      next.suggestedDestination = proposal.suggestedDestination
    }
    if (ACTIVE_STATES.has(prior.reviewState)) {
      next.reviewState = next.clarificationQuestions.length || Number(next.confidence?.score) < 0.6
        ? 'needs_clarification' : 'unreviewed'
    }
    next.revision += 1
    next.updatedAt = Date.now()
    next.extraction = { state: 'ready', error: null, transcriptRevision, jobId }
    next.provenance = { ...prior.provenance, extractor, modelJobId: jobId,
      modelVersion: clean(modelVersion, 80) || null }
    return { ok: true, item: this.#commit('proposal_generated', next,
      { actor: extractor, change: { classification: { before: prior.classification, after: next.classification } } }) }
  }

  action(id, action, { revision, commandId, actor = 'mike' } = {}) {
    if (commandId && this.commands.has(commandId)) return { ok: true, duplicate: true, item: this.get(this.commands.get(commandId)) }
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (Number(revision) !== prior.revision) return { ok: false, code: 409, error: 'item changed', item: this.get(id) }
    if (prior.reviewState === 'merged' || prior.reviewState === 'split') return { ok: false, code: 409, error: 'item is superseded' }
    if (!REVIEW_STATES.has(action) || ['merged', 'split'].includes(action)) return { ok: false, code: 400, error: 'invalid action' }
    const next = { ...prior, reviewState: action, revision: prior.revision + 1, updatedAt: Date.now() }
    return { ok: true, item: this.#commit(action === 'ignored' ? 'ignored' : action === 'done' ? 'marked_done' : 'restored', next, { commandId, actor, change: { reviewState: { before: prior.reviewState, after: action } } }) }
  }

  beginPromotion(id, kind, { revision, commandId, actor = 'mike', candidateId = null, destinationId = null } = {}) {
    if (commandId && this.commands.has(commandId)) return { ok: true, duplicate: true, item: this.get(this.commands.get(commandId)) }
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (Number(revision) !== prior.revision) return { ok: false, code: 409, error: 'item changed', item: this.get(id) }
    if (!['task', 'project', 'idea', 'memory', 'start_day'].includes(kind)) return { ok: false, code: 400, error: 'invalid destination' }
    if (prior.reviewState === 'merged' || prior.reviewState === 'split') return { ok: false, code: 409, error: 'item is superseded' }
    const pending = { kind, candidateId, destinationId, commandId: commandId || randomUUID(), requestedAt: Date.now() }
    const next = { ...prior, pendingPromotion: pending, revision: prior.revision + 1, updatedAt: Date.now() }
    return { ok: true, item: this.#commit('promotion_requested', next, { commandId: pending.commandId, actor }) }
  }

  finishPromotion(id, kind, destinationId, { commandId, actor = 'system', resource = null, audio = null } = {}) {
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (prior.destinationRefs.some(ref => ref.kind === kind && ref.id === destinationId)) return { ok: true, duplicate: true, item: this.get(id) }
    const next = { ...prior, revision: prior.revision + 1, updatedAt: Date.now(), reviewState: 'reviewed', pendingPromotion: null,
      ...(audio ? { audio } : {}),
      destinationRefs: [...prior.destinationRefs, { kind, id: destinationId, createdAt: Date.now(), syncRevision: prior.revision + 1 }] }
    return { ok: true, item: this.#commit('promotion_applied', next, { commandId, actor, resource }) }
  }

  promoteResource(id, kind, { revision, commandId, actor = 'mike', title = null, audio = null } = {}) {
    if (!DESTINATIONS.has(kind)) return { ok: false, code: 400, error: 'invalid destination' }
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    const destinationId = `${kind}:${id}`
    const existing = this.resource(destinationId)
    if (existing) return { ok: true, duplicate: true, item: this.get(id), resource: existing }
    if (Number(revision) !== prior.revision) return { ok: false, code: 409, error: 'item changed', item: this.get(id) }
    if (prior.reviewState === 'merged' || prior.reviewState === 'split') return { ok: false, code: 409, error: 'item is superseded' }
    const verifiedAudio = audio || prior.audio
    if (kind === 'memory' && verifiedAudio.state === 'available' && !verifiedAudio.kept) return { ok: false, code: 409, error: 'keep recording before saving memory' }
    const common = { id: destinationId, kind, title: clean(title, 80) || prior.title,
      sourceItemId: id, sourceKey: prior.sourceKey, sourceRefs: prior.sourceRefs,
      reviewUrl: `/review?item=${encodeURIComponent(id)}`, createdAt: Date.now() }
    const resource = kind === 'project'
      ? { ...common, goal: prior.summary || prior.cleanedTranscript, steps: prior.candidates.filter(candidate => candidate.kind === 'task'),
        openQuestions: prior.clarificationQuestions,
        relatedTaskIds: prior.sourceRefs.filter(ref => ref.store === 'tasks' && !String(ref.id).includes(':note')).map(ref => ref.id) }
      : kind === 'idea'
        ? { ...common, topic: prior.title, rationale: prior.summary || prior.cleanedTranscript,
          possibleNextStep: prior.candidates.find(candidate => candidate.kind === 'task') || null }
        : { ...common, excerpt: prior.cleanedTranscript, sourceRange: null,
          audioSessionId: verifiedAudio.state === 'available' ? verifiedAudio.sessionId : null,
          audioState: verifiedAudio.state }
    const result = this.finishPromotion(id, kind, destinationId, { commandId, actor, resource, audio: kind === 'memory' ? verifiedAudio : null })
    return { ...result, resource }
  }

  allResources(kind = null) {
    return plain([...this.resources.values()].filter(resource => !kind || resource.kind === kind))
  }

  previewResourceUpdate(id, kind) {
    const item = this.items.get(id)
    const resource = this.resources.get(`${kind}:${id}`)
    if (!item || !resource) return { ok: false, code: 404, error: 'linked destination not found' }
    const fields = kind === 'project'
      ? { title: item.title, goal: item.summary || item.cleanedTranscript,
        steps: item.candidates.filter(candidate => candidate.kind === 'task'), openQuestions: item.clarificationQuestions,
        relatedTaskIds: item.sourceRefs.filter(ref => ref.store === 'tasks' && !String(ref.id).includes(':note')).map(ref => ref.id) }
      : kind === 'idea'
        ? { title: item.title, topic: item.title, rationale: item.summary || item.cleanedTranscript,
          possibleNextStep: item.candidates.find(candidate => candidate.kind === 'task') || null }
        : kind === 'memory'
          ? { title: item.title, excerpt: item.cleanedTranscript }
          : null
    if (!fields) return { ok: false, code: 400, error: 'invalid resource kind' }
    const changes = Object.fromEntries(Object.entries(fields)
      .filter(([field, value]) => JSON.stringify(resource[field]) !== JSON.stringify(value))
      .map(([field, value]) => [field, { before: resource[field] ?? null, after: value }]))
    return { ok: true, item: this.get(id), resource: this.resource(resource.id), changes }
  }

  updateResource(id, kind, { revision, commandId } = {}) {
    if (commandId && this.commands.has(commandId)) return this.hasCommand(id, commandId)
      ? { ok: true, duplicate: true, item: this.get(id), resource: this.resource(`${kind}:${id}`) }
      : { ok: false, code: 409, error: 'command ID belongs to another item' }
    const preview = this.previewResourceUpdate(id, kind)
    if (!preview.ok) return preview
    const prior = this.items.get(id)
    if (Number(revision) !== prior.revision) return { ok: false, code: 409, error: 'item changed', item: this.get(id) }
    const resource = { ...preview.resource, updatedAt: Date.now() }
    for (const [field, change] of Object.entries(preview.changes)) resource[field] = change.after
    const next = { ...prior, revision: prior.revision + 1, updatedAt: Date.now(),
      destinationRefs: prior.destinationRefs.map(ref => ref.kind === kind && ref.id === resource.id
        ? { ...ref, syncRevision: prior.revision + 1 } : ref) }
    return { ok: true, item: this.#commit('destination_updated', next,
      { commandId, actor: 'mike', resource, change: preview.changes }), resource }
  }

  markTaskSynced(id, taskId, { revision, commandId } = {}) {
    if (commandId && this.commands.has(commandId)) return this.hasCommand(id, commandId)
      ? { ok: true, duplicate: true, item: this.get(id) }
      : { ok: false, code: 409, error: 'command ID belongs to another item' }
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (Number(revision) !== prior.revision) return { ok: false, code: 409, error: 'item changed', item: this.get(id) }
    if (!prior.destinationRefs.some(ref => ref.kind === 'task' && ref.id === taskId)) return { ok: false, code: 404, error: 'linked task not found' }
    const next = { ...prior, revision: prior.revision + 1, updatedAt: Date.now(),
      destinationRefs: prior.destinationRefs.map(ref => ref.kind === 'task' && ref.id === taskId
        ? { ...ref, syncRevision: prior.revision + 1 } : ref) }
    return { ok: true, item: this.#commit('destination_updated', next, { commandId, actor: 'mike' }) }
  }

  linkStartDayCommit(draftId, sourceLinks) {
    const linksBySession = new Map()
    for (const link of Array.isArray(sourceLinks) ? sourceLinks : []) {
      for (const sessionId of link.sessionIds || []) {
        const links = linksBySession.get(sessionId) || []
        links.push(link)
        linksBySession.set(sessionId, links)
      }
    }
    const updates = []
    for (const [sessionId, links] of linksBySession) {
      const item = this.bySource(`coach:${sessionId}`)
      if (!item) continue
      const itemIds = [...new Set(links.map(link => link.itemId))]
      const taskIds = [...new Set(links.map(link => link.taskId).filter(Boolean))]
      const destinationRefs = item.destinationRefs.filter(ref => !(ref.kind === 'start_day' && ref.id === draftId))
      const prior = item.destinationRefs.find(ref => ref.kind === 'start_day' && ref.id === draftId)
      if (prior?.committed && itemIds.every(value => prior.itemIds?.includes(value)) &&
        taskIds.every(value => prior.taskIds?.includes(value))) continue
      destinationRefs.push({ ...(prior || { kind: 'start_day', id: draftId, createdAt: Date.now() }),
        itemIds: [...new Set([...(prior?.itemIds || []), ...itemIds])],
        taskIds: [...new Set([...(prior?.taskIds || []), ...taskIds])], committed: true,
        syncRevision: item.revision + 1 })
      updates.push({ ...item, revision: item.revision + 1, updatedAt: Date.now(), destinationRefs })
    }
    if (!updates.length) return { ok: true, linked: 0 }
    this.#commit('start_day_linked', updates, { actor: 'start-day' })
    return { ok: true, linked: updates.length }
  }

  split(id, parts, { revision, commandId, actor = 'mike' } = {}) {
    if (commandId && this.commands.has(commandId)) {
      const item = this.get(this.commands.get(commandId))
      return { ok: true, duplicate: true, item, children: (item?.childIds || []).map(childId => this.get(childId)) }
    }
    const prior = this.items.get(id)
    if (!prior) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (Number(revision) !== prior.revision) return { ok: false, code: 409, error: 'item changed', item: this.get(id) }
    if (!Array.isArray(parts) || parts.length < 2) return { ok: false, code: 400, error: 'at least two parts required' }
    if (prior.reviewState === 'merged' || prior.reviewState === 'split' || prior.pendingPromotion) return { ok: false, code: 409, error: 'item cannot be split now' }
    const available = new Set((prior.rawTranscript.segments || []).map(segment => segment.id))
    if (available.size < 2) return { ok: false, code: 400, error: 'at least two raw chunks required' }
    const used = new Set()
    const children = []
    for (const [index, part] of parts.entries()) {
      const segmentIds = Array.isArray(part?.segmentIds) ? part.segmentIds : []
      if (!segmentIds.length || new Set(segmentIds).size !== segmentIds.length || segmentIds.some(segmentId => !available.has(segmentId) || used.has(segmentId))) {
        return { ok: false, code: 400, error: `part ${index + 1} overlaps or has unknown chunks` }
      }
      segmentIds.forEach(segmentId => used.add(segmentId))
      const selected = (prior.rawTranscript.segments || []).filter(segment => segmentIds.includes(segment.id))
      if (!selected.length) return { ok: false, code: 400, error: `part ${index + 1} has no source segments` }
      const text = sourceText(selected)
      const proposal = initialProposal(text, prior.sourceType)
      children.push({ ...plain(prior), id: `sw_${randomUUID()}`, revision: 1,
        sourceKey: `${prior.sourceKey}:part:${index + 1}`, sourceAliases: [],
        rawTranscript: { text, segments: selected, complete: false, source: 'source-chunks' }, cleanedTranscript: clean(part.cleanedTranscript) || text,
        ...proposal, title: clean(part.title, 80) || proposal.title,
        clarificationQuestions: prior.rawTranscript.source === 'full-recording'
          ? [...proposal.clarificationQuestions, 'Check this excerpt against the whole recording.'] : proposal.clarificationQuestions,
        reviewState: prior.rawTranscript.source === 'full-recording' ? 'needs_clarification' : proposal.reviewState,
        destinationRefs: [], pendingPromotion: null, parentId: id, childIds: [], mergedInto: null, updatedAt: Date.now(),
        provenance: { ...prior.provenance, humanEditedFields: [] } })
    }
    if (used.size !== available.size) return { ok: false, code: 400, error: 'every raw chunk must be assigned exactly once' }
    const next = { ...prior, revision: prior.revision + 1, updatedAt: Date.now(), reviewState: 'split', childIds: children.map(child => child.id) }
    this.#commit('split', [...children, next], { commandId, actor })
    return { ok: true, item: this.get(id), children: children.map(child => this.get(child.id)) }
  }

  merge(targetId, sourceId, { revision, sourceRevision, commandId, actor = 'mike' } = {}) {
    if (targetId === sourceId) return { ok: false, code: 400, error: 'select two different items' }
    if (commandId && this.commands.has(commandId)) return { ok: true, duplicate: true, item: this.get(this.commands.get(commandId)) }
    const target = this.items.get(targetId)
    const source = this.items.get(sourceId)
    if (!target || !source) return { ok: false, code: 404, error: 'unknown spoken work item' }
    if (Number(revision) !== target.revision) return { ok: false, code: 409, error: 'item changed', item: this.get(targetId) }
    if (Number(sourceRevision) !== source.revision) return { ok: false, code: 409, error: 'source item changed', item: this.get(sourceId) }
    if (source.reviewState === 'merged' || target.reviewState === 'merged' || source.reviewState === 'split' || target.reviewState === 'split' || source.pendingPromotion || target.pendingPromotion) {
      return { ok: false, code: 409, error: 'items cannot be merged now' }
    }
    if (source.space !== target.space) return { ok: false, code: 400, error: 'items are in different spaces' }
    const clarificationQuestions = [...new Set([...(target.clarificationQuestions || []), ...(source.clarificationQuestions || [])])]
    const next = { ...target, revision: target.revision + 1, updatedAt: Date.now(),
      sourceRefs: [...target.sourceRefs, ...source.sourceRefs.filter(ref => !target.sourceRefs.some(current => current.store === ref.store && current.id === ref.id))],
      destinationRefs: [...target.destinationRefs, ...source.destinationRefs.filter(ref => !target.destinationRefs.some(current => current.kind === ref.kind && current.id === ref.id))],
      mergedSourceIds: [...new Set([...(target.mergedSourceIds || []), source.id, ...(source.mergedSourceIds || [])])],
      mergedSourceKeys: [...new Set([...(target.mergedSourceKeys || []), source.sourceKey, ...(source.mergedSourceKeys || [])])],
      classification: target.classification === source.classification ? target.classification : 'mixed',
      clarificationQuestions,
      reviewState: clarificationQuestions.length ? 'needs_clarification' : 'unreviewed',
      summary: [target.summary, source.summary].filter(Boolean).join('\n\n').slice(0, 12_000) }
    const merged = { ...source, revision: source.revision + 1, updatedAt: Date.now(), reviewState: 'merged', mergedInto: targetId }
    this.#commit('merge', [merged, next], { commandId, actor })
    return { ok: true, item: this.get(targetId), merged: this.get(sourceId) }
  }
}
