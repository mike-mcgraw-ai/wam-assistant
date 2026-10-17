import { coalesceTranscriptSegments, mergeRawSegments } from './transcript.js'
import { materializeSpokenWork } from './spokenWorkReview.js'

export function ingestCoachCapture({ store, recordings, session, fullText = '', note = null, amendmentParent = null }) {
  const id = session.id
  const rawSegments = mergeRawSegments(session.segments, recordings.transcript(id))
  const rawText = fullText || coalesceTranscriptSegments(rawSegments).map(segment => segment.text).join('\n\n')
  let recording = recordings.summary(id)
  let audioState = recording?.available ? 'available' : 'missing'
  if (recording?.available && !recording.kept) {
    const retained = recordings.setKeep(id, true)
    recording = recordings.summary(id)
    if (!retained.ok || !recording?.kept) audioState = 'retention_error'
  }
  const sourceType = session.context?.reviewItemId ? 'amendment'
    : session.context?.taskId === '__day_start__' ? 'start_day'
      : session.context?.taskId === '__assistant__' ? 'assistant_voice'
        : session.context?.taskId || session.context?.choreId ? 'task_voice_note'
          : session.modeId === 'notes' ? 'solo_notes' : session.modeId === 'meeting' ? 'meeting'
            : session.modeId === 'listening' ? 'listening' : 'conversation'
  const sourceRefs = [{ store: 'coach', id }]
  if (session.context?.reviewItemId) sourceRefs.push({ store: 'spoken-work', id: session.context.reviewItemId })
  if (recording) sourceRefs.push({ store: 'recordings', id })
  if (session.context?.taskId && !String(session.context.taskId).startsWith('__')) {
    sourceRefs.push({ store: 'tasks', id: session.context.taskId })
  }
  if (session.context?.choreId) sourceRefs.push({ store: 'runs', id: session.context.choreId })
  if (note?.summaryTarget) sourceRefs.push({ store: note.summaryTarget.kind === 'chore' ? 'runs' : 'tasks', id: `${note.summaryTarget.subjectId}:${note.summaryTarget.noteId}` })
  const destinationRefs = []
  if (note?.kind === 'task' && note.result?.task?.id) destinationRefs.push({ kind: 'task', id: note.result.task.id, createdAt: Date.now(), syncRevision: 1 })
  else if (['task', 'note'].includes(note?.kind) && note.taskId) destinationRefs.push({ kind: 'task', id: note.taskId, createdAt: Date.now(), syncRevision: 1 })
  if (note?.kind === 'day-draft' && note.result?.draft?.id) destinationRefs.push({ kind: 'start_day', id: note.result.draft.id,
    itemIds: note.result.sourceItemIds || [], createdAt: Date.now(), syncRevision: 1 })
  const parent = amendmentParent || (session.context?.reviewItemId ? store.get(session.context.reviewItemId) : null)
  return store.ingest({
    sourceKey: `coach:${id}`, sourceType, modeId: session.modeId, space: session.space,
    parentId: session.context?.reviewItemId || null,
    amendmentKind: session.context?.amendmentKind || null,
    amendmentBaseRevision: session.context?.reviewRevision ?? null,
    amendmentOriginal: parent && parent.revision === session.context?.reviewRevision ? parent.cleanedTranscript : null,
    sessionId: id, sourceRefs, capturedAt: session.startedAt, endedAt: session.endedAt,
    rawSegments, rawText, complete: Boolean(fullText),
    transcriptSource: fullText ? 'full-recording' : 'coach',
    audio: { sessionId: id, state: audioState, kept: recording?.kept === true, expiresAt: recording?.expiresAt ?? null },
    destinationRefs,
  })
}

export function reconcileRecentCaptures({ store, inventory, recordings }) {
  const migrationHighWatermark = store.events.filter(event => event.actor === 'migration')
    .flatMap(event => event.items || [event.item])
    .reduce((latest, item) => Math.max(latest, Number(item?.capturedAt) || 0), 0)
  if (!migrationHighWatermark) return { imported: 0, failures: [] }
  let imported = 0
  const failures = []
  for (const preview of inventory.items) {
    if (!preview.sessionId || !preview.endedAt || !preview.capturedAt || preview.capturedAt <= migrationHighWatermark) continue
    const existing = store.bySource(preview.sourceKey)
    if (existing && existing.audio?.state !== 'retention_error') continue
    try {
      let audio = preview.audio
      if (['available', 'expiring'].includes(audio?.state) && !audio.kept) {
        const retained = recordings.setKeep(audio.sessionId, true)
        const recording = recordings.summary(audio.sessionId)
        audio = retained.ok && recording?.kept && recording.available
          ? { ...audio, state: 'available', kept: true, expiresAt: null }
          : { ...audio, state: 'retention_error', kept: false }
        if (audio.state === 'retention_error') failures.push({ sourceKey: preview.sourceKey, error: 'recording could not be kept' })
      }
      const result = existing
        ? audio?.state === 'available' && audio.kept
          ? store.ingest({ sourceKey: preview.sourceKey, audio }, { actor: 'capture-recovery' })
          : { ok: false, error: 'recording could not be kept' }
        : materializeSpokenWork(store, { ...preview, audio })
      if (result.ok) { if (!existing) imported += 1 }
      else if (!failures.some(failure => failure.sourceKey === preview.sourceKey)) failures.push({ sourceKey: preview.sourceKey, error: result.error })
    } catch (error) { failures.push({ sourceKey: preview.sourceKey, error: String(error.message || error) }) }
  }
  return { imported, failures }
}
