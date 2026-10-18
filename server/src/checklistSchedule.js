/** Checklist items can be paused from a day forward without erasing history. */
export function itemActiveOnDay(item, day) {
  if (!item || !day) return true
  if (item.activeFrom && day < item.activeFrom) return false
  if (item.pausedFrom && day >= item.pausedFrom) return false
  return true
}

export function scheduledItems(template, day) {
  return (template?.items ?? []).filter(item => itemActiveOnDay(item, day))
}
