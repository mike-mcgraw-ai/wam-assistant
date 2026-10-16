import { existsSync, readFileSync } from 'node:fs'

function approvedRules(path) {
  if (!path || !existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed.rules) ? parsed.rules.filter(rule => rule?.approved === true) : []
  } catch { return [] }
}

function fill(template, match) {
  return String(template || '').replace(/\$(\d+)/g, (_, index) => match[Number(index)] || '').trim()
}

export function approvedSpokenProposal(item, rules) {
  const text = String(item?.cleanedTranscript || item?.rawTranscript?.text || '')
  for (const rule of rules) {
    if (!rule.id || !rule.pattern || !['task', 'project', 'idea', 'memory', 'product_feedback', 'mixed', 'reference'].includes(rule.classification)) continue
    let match
    try { match = text.match(new RegExp(rule.pattern, rule.flags || 'i')) } catch { continue }
    if (!match) continue
    const title = fill(rule.title, match) || item.title
    const summary = fill(rule.summary, match) || item.summary
    return {
      title, summary, classification: rule.classification,
      candidates: rule.classification === 'task' ? [{ id: `rule:${rule.id}`, kind: 'task', title,
        detail: summary, evidenceSegmentIds: [], evidenceText: match[0], confidence: 0.9 }] : [],
      clarificationQuestions: Array.isArray(rule.clarificationQuestions) ? rule.clarificationQuestions.slice(0, 5) : [],
      confidence: { score: 0.9, reasons: [`approved rule ${rule.id}`] },
      suggestedDestination: rule.destination || null,
    }
  }
  return null
}

export function scheduleSpokenExtraction({ store, jobs, itemId, rulesPath, retry = false, retryToken = null }) {
  const item = store.get(itemId)
  if (!item) return { ok: false, code: 404, error: 'unknown spoken work item' }
  const transcriptRevision = item.extraction?.transcriptRevision || 1
  const rule = approvedSpokenProposal(item, approvedRules(rulesPath))
  if (rule) return store.applyProposal(itemId, rule, { transcriptRevision, extractor: 'approved-rule' })
  const created = jobs.create({ itemId, capability: 'spoken.extract',
    idempotencyKey: `spoken.extract:${itemId}:${transcriptRevision}${retry ? `:${retryToken || Date.now()}` : ''}`,
    input: { itemId, transcriptRevision, rawText: item.rawTranscript?.text || '',
      cleanedTranscript: item.cleanedTranscript || '',
      segments: (item.rawTranscript?.segments || []).map(segment => ({ id: segment.id, text: segment.text })),
      sourceType: item.sourceType, modeId: item.modeId, space: item.space },
    priority: retry ? 'now' : 'normal' })
  if (!created.ok) return created
  if (created.job.status === 'done') return applySpokenModelResult(store, created.job, created.job.result)
  if (created.job.status === 'failed') return store.markExtraction(itemId, 'failed', { jobId: created.job.id, error: created.job.error || 'model job failed' })
  return store.markExtraction(itemId, 'processing', { jobId: created.job.id })
}

export function applySpokenModelResult(store, job, result) {
  if (job?.capability !== 'spoken.extract') return { ok: false, code: 400, error: 'not a spoken extraction job' }
  const source = job.input || {}
  const proposal = result?.proposal || result
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return { ok: false, code: 400, error: 'proposal object required' }
  }
  const evidence = `${source.cleanedTranscript || ''}\n${source.rawText || ''}`.toLocaleLowerCase()
  const segmentIds = new Set((source.segments || []).map(segment => segment.id))
  const candidates = (Array.isArray(proposal.candidates) ? proposal.candidates : []).slice(0, 20)
    .filter(candidate => candidate && ['task', 'project', 'idea', 'memory'].includes(candidate.kind))
    .filter(candidate => String(candidate.evidenceText || '').trim() && evidence.includes(String(candidate.evidenceText).trim().toLocaleLowerCase()))
    .map((candidate, index) => ({ id: String(candidate.id || `c${index + 1}`).slice(0, 60), kind: candidate.kind,
      title: String(candidate.title || '').trim().slice(0, 80), detail: String(candidate.detail || '').trim().slice(0, 1_200),
      evidenceText: String(candidate.evidenceText).trim().slice(0, 300),
      evidenceSegmentIds: (Array.isArray(candidate.evidenceSegmentIds) ? candidate.evidenceSegmentIds : []).filter(id => segmentIds.has(id)),
      confidence: Math.max(0, Math.min(1, Number(candidate.confidence) || 0)) }))
  const safe = { ...proposal, candidates,
    clarificationQuestions: (Array.isArray(proposal.clarificationQuestions) ? proposal.clarificationQuestions : [])
      .map(question => String(question || '').trim().slice(0, 240)).filter(Boolean).slice(0, 5),
    confidence: { score: Math.max(0, Math.min(1, Number(proposal.confidence?.score) || 0)),
      reasons: (Array.isArray(proposal.confidence?.reasons) ? proposal.confidence.reasons : [])
        .map(reason => String(reason || '').trim().slice(0, 120)).filter(Boolean).slice(0, 5) } }
  return store.applyProposal(source.itemId, safe,
    { transcriptRevision: job.input?.transcriptRevision, jobId: job.id,
      extractor: 'model', modelVersion: result?.modelVersion || null })
}
