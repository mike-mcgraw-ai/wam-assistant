export function unverifiedVoiceAssessment(segment) {
  return {
    sourceSegmentIds: segment?.id ? [String(segment.id)] : [],
    startMs: null,
    endMs: null,
    identity: 'uncertain',
    similarity: { mike: null, other: null },
    confidence: null,
    reason: 'unverified',
    modelVersion: null,
    profileRevision: null,
  }
}
