/**
 * Keep only the steps that belong to the current run and still need doing.
 *
 * A Start Day walk may begin halfway through a saved routine. The shaped run
 * already contains exactly that suffix, even after every included step is
 * complete, so it remains the authority instead of falling back to the full
 * template.
 */
export function remainingPlanSteps(planSteps, run) {
  const doneIds = new Set((run?.items ?? []).filter(item => item.done).map(item => item.id))
  const includedIds = run ? new Set(run.items.map(item => item.id)) : null
  return planSteps
    .filter(step => !includedIds || includedIds.has(step.id))
    .filter(step => !doneIds.has(step.id))
}
