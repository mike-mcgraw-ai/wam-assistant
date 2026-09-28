/**
 * Keys pressed on the hub's /mirror page, delivered as if the ring sent them.
 *
 * Long-polls GET /input on the hub. Each action becomes the same event the
 * glasses send for that gesture, and goes through the app's one event
 * handler, so wake-from-sleep, arm-then-confirm and back all behave exactly as
 * they do with the ring. The event shapes were recorded from Even's own
 * simulator: scrolls arrive as textEvent, taps as sysEvent.
 *
 * The OS menu cannot be opened from here — it belongs to the glasses — so the
 * mirror sends a menu item's ID instead (`menu:12`), which is what the OS
 * would have sent after you picked it.
 *
 * Off with: localStorage.setItem('opsboard.remoteInput', 'off')
 */
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { config } from './config'

function toEvent(action: string): EvenHubEvent | null {
  const event = (value: Record<string, unknown>) => value as unknown as EvenHubEvent
  switch (action) {
    case 'up':
      return event({ textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } })
    case 'down':
      return event({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
    case 'click':
      return event({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } })
    case 'double':
      return event({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
  }
  const menu = /^menu:(\d+)$/.exec(action)
  return menu ? event({ menuItemClickEvent: { itemID: Number(menu[1]) } }) : null
}

function switchedOff(): boolean {
  try {
    return localStorage.getItem('opsboard.remoteInput') === 'off'
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function startRemoteInput(handle: (event: EvenHubEvent) => void): void {
  if (switchedOff()) return

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (config.readToken) headers.Authorization = `Bearer ${config.readToken}`

  void (async () => {
    let after = -1
    for (;;) {
      try {
        const res = await fetch(`${config.serverUrl}/input?after=${after}`, {
          headers,
          cache: 'no-store',
          // The hub answers within 25s even when nothing was pressed.
          signal: AbortSignal.timeout(35_000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { seq: number; inputs: Array<{ action: string }> }
        after = body.seq
        for (const input of body.inputs) {
          const event = toEvent(input.action)
          if (event) handle(event)
        }
      } catch {
        // Hub down, network gone, or an older hub without /input: try again
        // later rather than spinning. The ring keeps working regardless.
        await sleep(5_000)
      }
    }
  })()
}
