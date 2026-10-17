export function materializeSpokenWork(store, preview) {
  const existing = store.get(preview.id) || store.bySource(preview.sourceKey)
  if (existing) return { ok: true, item: existing, existing: true }
  return store.ingest({
    id: preview.id,
    sourceKey: preview.sourceKey,
    sourceAliases: preview.sourceAliases,
    sourceType: preview.sourceType,
    sourceRefs: preview.sourceRefs,
    sessionId: preview.sessionId,
    modeId: preview.modeId,
    space: preview.space,
    capturedAt: preview.capturedAt,
    endedAt: preview.endedAt,
    rawSegments: preview.rawTranscript?.segments,
    rawText: preview.rawTranscript?.text,
    complete: preview.rawTranscript?.complete,
    transcriptSource: preview.rawTranscript?.source,
    audio: preview.audio,
    cleanedTranscript: preview.cleanedTranscript,
    title: preview.title,
    summary: preview.summary,
    classification: preview.classification,
    clarificationQuestions: preview.clarificationQuestions,
    reviewState: preview.reviewState,
    destinationRefs: preview.destinationRefs,
    parentId: preview.parentId,
    amendmentKind: preview.amendmentKind,
    amendmentBaseRevision: preview.amendmentBaseRevision,
    amendmentOriginal: preview.amendmentOriginal,
    ingest: 'migration',
  }, { actor: 'review-import' })
}

export function promoteSpokenTask({ store, tasks, checklists, itemId, revision, commandId, candidateId = null }) {
  const item = store.get(itemId)
  if (!item) return { ok: false, code: 404, error: 'unknown spoken work item' }
  const linked = item.destinationRefs.find(ref => ref.kind === 'task')
  if (linked) return { ok: true, duplicate: true, item, taskId: linked.id }
  if (item.pendingPromotion && (item.pendingPromotion.commandId !== commandId || item.pendingPromotion.kind !== 'task' || item.pendingPromotion.destinationId)) {
    return { ok: false, code: 409, error: 'another promotion is pending', item }
  }
  const candidate = item.candidates.find(row => row.id === candidateId)
  if (candidateId && !candidate) return { ok: false, code: 400, error: 'unknown candidate' }
  if (!item.pendingPromotion) {
    const begun = store.beginPromotion(itemId, 'task', { revision, commandId, candidateId })
    if (!begun.ok) return begun
  }
  const current = store.get(itemId)
  const label = String(candidate?.title || current.title || '').trim()
  if (!label) return { ok: false, code: 400, error: 'task title required' }
  const clientId = `spoken-work:${itemId}:task`
  const created = tasks.addTask({
    label,
    space: current.space,
    window: 'anytime',
    weight: 'big',
    by: 'spoken-review',
    clientId,
  })
  if (!created.ok) return { ...created, code: 400 }
  const noteText = String(candidate?.detail || current.cleanedTranscript || current.summary || label).trim()
  const note = tasks.addNote(created.task.id, `Review source: /review?item=${encodeURIComponent(itemId)}\n${noteText}`, 'spoken-review', `${clientId}:note`)
  if (!note.ok) return { ...note, code: 400 }
  const committed = checklists.commitTasks(current.space, [created.task.id])
  if (!committed.ok) return { ...committed, code: 400 }
  const finished = store.finishPromotion(itemId, 'task', created.task.id, { commandId })
  return { ...finished, taskId: created.task.id }
}

export function linkExistingSpokenTask({ store, tasks, itemId, taskId, revision, commandId }) {
  const item = store.get(itemId)
  if (!item) return { ok: false, code: 404, error: 'unknown spoken work item' }
  const linked = item.destinationRefs.find(ref => ref.kind === 'task')
  if (linked) return { ok: true, duplicate: true, item, taskId: linked.id }
  let task = tasks.list().find(row => row.id === taskId && row.space === item.space)
  if (!task && item.pendingPromotion?.destinationId === taskId) {
    task = tasks.taskDefs().find(row => row.id === taskId && row.space === item.space)
  }
  if (!task || task.id === 'captured-notes') return { ok: false, code: 404, error: 'open task not found' }
  if (item.pendingPromotion && (item.pendingPromotion.commandId !== commandId || item.pendingPromotion.destinationId !== taskId)) {
    return { ok: false, code: 409, error: 'another promotion is pending', item }
  }
  if (!item.pendingPromotion) {
    const begun = store.beginPromotion(itemId, 'task', { revision, commandId, destinationId: taskId })
    if (!begun.ok) return begun
  }
  const noteText = String(item.cleanedTranscript || item.summary || item.title).trim()
  const note = tasks.addNote(taskId, `Review source: /review?item=${encodeURIComponent(itemId)}\n${noteText}`, 'spoken-review', `spoken-work:${itemId}:link:${taskId}:note`)
  if (!note.ok) return { ...note, code: 400 }
  const finished = store.finishPromotion(itemId, 'task', taskId, { commandId })
  return { ...finished, taskId }
}

export function promoteSpokenResource({ store, recordings, itemId, kind, revision, commandId, title = null }) {
  const item = store.get(itemId)
  if (!item) return { ok: false, code: 404, error: 'unknown spoken work item' }
  const linked = item.destinationRefs.find(ref => ref.kind === kind && ref.id === `${kind}:${itemId}`)
  if (linked) return { ok: true, duplicate: true, item, resource: store.resource(linked.id) }
  if (Number(revision) !== item.revision) return { ok: false, code: 409, error: 'item changed', item }
  if (['merged', 'split'].includes(item.reviewState)) return { ok: false, code: 409, error: 'item is superseded' }
  let audio = item.audio
  if (kind === 'memory' && audio.sessionId) {
    const recording = recordings.summary(audio.sessionId)
    if (recording?.available) {
      const kept = recording.kept ? { ok: true } : recordings.setKeep(audio.sessionId, true)
      const verified = recordings.summary(audio.sessionId)
      if (!kept.ok || !verified?.available || !verified.kept) {
        return { ok: false, code: 409, error: 'recording could not be kept; memory was not saved' }
      }
      audio = { ...audio, state: 'available', kept: true, expiresAt: null }
    } else if (['available', 'expiring', 'retention_error'].includes(audio.state)) {
      audio = { ...audio, state: 'expired', kept: false, expiresAt: null }
    }
  }
  return store.promoteResource(itemId, kind, { revision, commandId, title, audio })
}

export function previewSpokenTaskUpdate({ store, tasks, itemId }) {
  const item = store.get(itemId)
  const linked = item?.destinationRefs.find(ref => ref.kind === 'task')
  const task = linked ? tasks.taskDefs().find(row => row.id === linked.id) : null
  if (!item || !task) return { ok: false, code: 404, error: 'linked task not found' }
  return { ok: true, item, taskId: task.id, taskLabel: task.label,
    proposedNote: `Review source: /review?item=${encodeURIComponent(itemId)}\n${item.cleanedTranscript || item.summary || item.title}`.slice(0, 2_000) }
}

export function updateSpokenTask({ store, tasks, itemId, revision, commandId }) {
  if (store.hasCommand(itemId, commandId)) return { ok: true, duplicate: true, item: store.get(itemId) }
  const preview = previewSpokenTaskUpdate({ store, tasks, itemId })
  if (!preview.ok) return preview
  if (Number(revision) !== preview.item.revision) return { ok: false, code: 409, error: 'item changed', item: preview.item }
  const note = tasks.addNote(preview.taskId, preview.proposedNote, 'spoken-review',
    `spoken-work:${itemId}:sync:${revision}`)
  if (!note.ok) return { ...note, code: 400 }
  return store.markTaskSynced(itemId, preview.taskId, { revision, commandId })
}
