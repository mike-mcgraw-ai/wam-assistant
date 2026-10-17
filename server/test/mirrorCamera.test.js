import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const html = readFileSync(new URL('../src/web/mirror.html', import.meta.url), 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]

function mirrorHarness() {
  const listeners = new Map()
  const elements = new Map()
  const classes = new Set()
  const intervals = []
  const track = { stopped: false, stop() { this.stopped = true } }
  const stream = { getTracks: () => [track] }
  const frame = { text: 'LIFE\n> Next task', at: Date.now() }
  const constraints = []
  let cameraRequests = 0

  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        hidden: id === 'camera',
        textContent: '',
        className: '',
        classList: {
          add: name => classes.add(name),
          remove: name => classes.delete(name),
          contains: name => classes.has(name),
          toggle: name => classes.has(name) ? classes.delete(name) : classes.add(name),
        },
        addEventListener: (type, listener) => listeners.set(`${id}:${type}`, listener),
        setAttribute(name, value) { this[name] = value },
        async play() {},
      })
    }
    return elements.get(id)
  }

  const context = {
    document: {
      getElementById: element,
      body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
      addEventListener: (type, listener) => listeners.set(`document:${type}`, listener),
      hidden: false,
    },
    window: {
      isSecureContext: true,
      addEventListener: (type, listener) => listeners.set(`window:${type}`, listener),
    },
    navigator: {
      mediaDevices: {
        async getUserMedia(request) {
          cameraRequests += 1
          constraints.push(request)
          return stream
        },
      },
    },
    fetch: async () => ({ json: async () => frame }),
    setInterval: listener => intervals.push(listener),
    setTimeout: () => 1,
    clearTimeout: () => {},
  }
  runInNewContext(script, context)
  return { document: context.document, navigator: context.navigator, element, listeners, intervals, track, frame, constraints, get cameraRequests() { return cameraRequests } }
}

test('phone mirror starts the rear camera only on tap and clears stale overlays', async () => {
  const mirror = mirrorHarness()
  await mirror.intervals[0]()
  assert.equal(mirror.cameraRequests, 0)
  assert.equal(mirror.element('screen').textContent, 'LIFE\n> Next task')

  await mirror.listeners.get('camera-toggle:click')()
  assert.equal(mirror.cameraRequests, 1)
  assert.equal(mirror.constraints[0].audio, false)
  assert.equal(mirror.constraints[0].video.facingMode.exact, 'environment')
  assert.equal(mirror.element('camera').hidden, false)
  assert.equal(mirror.element('camera-toggle')['aria-pressed'], 'true')
  assert.equal(mirror.element('camera-status').hidden, true)

  mirror.frame.at = Date.now() - 30_000
  await mirror.intervals[0]()
  assert.equal(mirror.element('screen').textContent, '')
  assert.equal(mirror.element('stale').className, 'off')
  assert.equal(mirror.element('camera-status').hidden, false)

  await mirror.listeners.get('camera-toggle:click')()
  assert.equal(mirror.track.stopped, true)
  assert.equal(mirror.element('camera').hidden, true)
  assert.equal(mirror.element('camera-toggle')['aria-pressed'], 'false')
})

test('camera tracks stop when the phone page is hidden', async () => {
  const mirror = mirrorHarness()
  await mirror.listeners.get('camera-toggle:click')()
  mirror.document.hidden = true
  mirror.listeners.get('document:visibilitychange')()
  assert.equal(mirror.track.stopped, true)
  assert.equal(mirror.element('camera').hidden, true)
})

test('failed camera playback releases the stream', async () => {
  const mirror = mirrorHarness()
  mirror.element('camera').play = async () => { throw new Error('playback failed') }
  await mirror.listeners.get('camera-toggle:click')()
  assert.equal(mirror.track.stopped, true)
  assert.equal(mirror.element('camera').hidden, true)
  assert.equal(mirror.element('camera-toggle').disabled, false)
})

test('a camera permission result cannot reopen a hidden page', async () => {
  const mirror = mirrorHarness()
  let allowCamera
  mirror.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { allowCamera = resolve })
  const opening = mirror.listeners.get('camera-toggle:click')()
  mirror.document.hidden = true
  mirror.listeners.get('document:visibilitychange')()
  allowCamera({ getTracks: () => [mirror.track] })
  await opening
  assert.equal(mirror.track.stopped, true)
  assert.equal(mirror.element('camera').hidden, true)
})
