/**
 * Public snapshot stand-in. The hub's WAM Home link is private and always off
 * here, so there are no WAM Home tasks to keep extra details for.
 */
export class TaskOverlay {
  get() { return {} }
  byClientId() { return null }
  set(_id, input) { return { ...input } }
}
