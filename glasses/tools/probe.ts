/**
 * Font measurement harness.
 *
 * Renders whatever text the hub's /probe endpoint is holding, so a script can
 * set a string, screenshot the simulator, and read the glyph widths straight
 * off the pixels. This is how metrics.ts gets real numbers instead of guesses,
 * and it never ships — it is a tool, not a screen.
 */
import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'

const bridge = await waitForEvenAppBridge()

const container = { containerID: 1, containerName: 'probe' }

await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        borderColor: 5,
        // Zero padding: a measurement has to start at pixel zero or every
        // width comes back with the padding baked into it.
        paddingLength: 0,
        ...container,
        content: '',
        isEventCapture: 1,
      }),
    ],
  }),
)

let last = ''
setInterval(async () => {
  try {
    const res = await fetch('http://127.0.0.1:8787/probe', { cache: 'no-store' })
    const { text } = await res.json()
    if (text === last) return
    last = text
    await bridge.textContainerUpgrade(new TextContainerUpgrade({ ...container, content: text }))
  } catch {
    // the hub comes and goes; the next tick retries
  }
}, 200)
