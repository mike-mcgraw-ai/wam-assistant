/**
 * Reminder delivery.
 *
 * Nothing here talks to the glasses. It cannot: plugins are foreground-only,
 * so a running app is not something a reminder can rely on. Instead this posts
 * to whatever already notifies your phone, and the glasses display it the same
 * way they display any other phone notification — app closed, phone pocketed.
 *
 * NOTIFY_URL is any endpoint that turns a POST into a phone notification.
 *   ntfy:     https://ntfy.sh/your-private-topic     (body = message text)
 *   Slack:    an incoming webhook URL                (body = {"text": ...})
 * The shape is picked from the URL so there is nothing else to configure.
 *
 * For plain "remind me in 30 minutes", the phone's own timer app is simpler
 * and works hands-free through a voice assistant. This is for reminders the
 * phone cannot know about — a wait step that started on the glasses, rounds
 * still unfinished late in the day.
 */

export class Notifier {
  constructor(url = process.env.NOTIFY_URL || '') {
    this.url = url
    this.isSlack = url.includes('hooks.slack.com')
    if (!url) console.log('[notify] NOTIFY_URL not set — reminders will only be logged')
  }

  /** @returns {Promise<boolean>} true if delivered */
  async send(title, message) {
    const text = title ? `${title}: ${message}` : message

    if (!this.url) {
      console.log(`[notify] (not sent) ${text}`)
      return false
    }

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: this.isSlack
          ? { 'Content-Type': 'application/json' }
          : { 'Content-Type': 'text/plain', Title: title || 'Ops Board' },
        body: this.isSlack ? JSON.stringify({ text }) : message,
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) {
        console.warn(`[notify] ${res.status} sending "${text}"`)
        return false
      }
      console.log(`[notify] sent: ${text}`)
      return true
    } catch (err) {
      console.warn(`[notify] failed: ${err.message}`)
      return false
    }
  }
}

/**
 * Sweep due wait steps and announce them.
 * A step is marked notified only after a successful send, so a delivery
 * failure retries on the next sweep instead of being silently swallowed.
 */
export async function sweepWaits(checklists, notifier, now = Date.now()) {
  const due = checklists.dueWaits(now)
  for (const item of due) {
    const late = Math.round((now - item.endsAt) / 60_000)
    const suffix = late >= 2 ? ` (${late}m ago)` : ''
    const sent = await notifier.send(item.name, `${item.label} done${suffix}`)
    if (sent) checklists.markNotified(item.runId, item.itemId)
  }
  return due.length
}
