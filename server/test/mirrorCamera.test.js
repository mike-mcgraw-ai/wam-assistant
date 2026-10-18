import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const html = readFileSync(new URL('../src/web/mirror.html', import.meta.url), 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]

function mirrorHarness({ fullscreenSupported = true, standalone = false, search = '', coarse = false } = {}) {
  const listeners = new Map()
  const elements = new Map()
  const classes = new Set()
  const intervals = []
  const track = { stopped: false, stop() { this.stopped = true } }
  const stream = { getTracks: () => [track] }
  const frame = { text: 'LIFE\n> Next task', at: Date.now() }
  const constraints = []
  const orientationLocks = []
  let cameraRequests = 0
  const posts = []

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
        children: [],
        appendChild(child) { this.children.push(child) },
        async play() {},
      })
    }
    return elements.get(id)
  }

  const document = {
    getElementById: element,
    createElement: () => ({ dataset: {}, textContent: '' }),
    body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) } },
    addEventListener: (type, listener) => listeners.set(`document:${type}`, listener),
    hidden: false,
    fullscreenElement: null,
    documentElement: {},
    async exitFullscreen() {
      this.fullscreenElement = null
      listeners.get('document:fullscreenchange')()
    },
  }
  if (fullscreenSupported) document.documentElement.requestFullscreen = async () => {
    document.fullscreenElement = document.documentElement
    listeners.get('document:fullscreenchange')()
  }

  const context = {
    document,
    window: {
      isSecureContext: true,
      screen: { orientation: { async lock(value) { orientationLocks.push(value) } } },
      addEventListener: (type, listener) => listeners.set(`window:${type}`, listener),
    },
    navigator: {
      standalone,
      mediaDevices: {
        async getUserMedia(request) {
          cameraRequests += 1
          constraints.push(request)
          return stream
        },
      },
    },
    location: { search },
    URLSearchParams,
    matchMedia: () => ({ matches: coarse }),
    fetch: async (url, init) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(init.body) })
        return { ok: true, json: async () => ({ ok: true, listening: true }) }
      }
      return { json: async () => frame }
    },
    setInterval: listener => intervals.push(listener),
    setTimeout: () => 1,
    clearTimeout: () => {},
  }
  runInNewContext(script, context)
  return { document: context.document, navigator: context.navigator, element, listeners, intervals, track, frame, constraints, orientationLocks, classes, posts, get cameraRequests() { return cameraRequests } }
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

test('full-screen control hides browser chrome where supported and can exit', async () => {
  const mirror = mirrorHarness()
  await mirror.listeners.get('camera-toggle:click')()
  await mirror.listeners.get('fullscreen-toggle:click')()
  assert.equal(mirror.element('fullscreen-toggle').textContent, 'Exit full screen')
  assert.equal(mirror.element('fullscreen-toggle')['aria-pressed'], 'true')
  assert.equal(mirror.element('fullscreen-help').hidden, true)
  assert.deepEqual(mirror.orientationLocks, ['landscape'])
  assert.equal(mirror.element('camera').hidden, false)
  assert.equal(mirror.track.stopped, false)

  await mirror.listeners.get('fullscreen-toggle:click')()
  assert.equal(mirror.element('fullscreen-toggle').textContent, 'Full screen')
  assert.equal(mirror.element('fullscreen-toggle')['aria-pressed'], 'false')
  assert.equal(mirror.element('camera').hidden, false)
})

test('iPhone without element fullscreen shows home-screen instructions', async () => {
  const mirror = mirrorHarness({ fullscreenSupported: false })
  await mirror.listeners.get('fullscreen-toggle:click')()
  assert.equal(mirror.element('fullscreen-help').hidden, false)
  assert.match(html, /Add to Home Screen → Open as Web App/)
  assert.equal(mirror.element('fullscreen-toggle')['aria-pressed'], 'false')
})

test('standalone mirror hides the unneeded full-screen button', () => {
  const mirror = mirrorHarness({ standalone: true })
  assert.equal(mirror.element('fullscreen-toggle').hidden, true)
})

test('touch controls drive the glasses from an iPad or phone (v0.174.0)', async () => {
  const desktop = mirrorHarness()
  assert.equal(desktop.classes.has('touch'), false)

  const phone = mirrorHarness({ coarse: true })
  assert.equal(phone.classes.has('touch'), true)
  assert.equal(phone.classes.has('embed'), false)

  const kiosk = mirrorHarness({ search: '?embed=1' })
  assert.equal(kiosk.classes.has('touch'), true)
  assert.equal(kiosk.classes.has('embed'), true)
  assert.deepEqual(kiosk.element('menu').children.map(b => b.textContent), ['Listen', 'Chat', 'Notes', 'Lists', 'Diagnostics'])

  const button = action => ({ target: { textContent: action, closest: () => ({ dataset: { action } }) } })
  kiosk.listeners.get('pad:click')(button('down'))
  kiosk.listeners.get('pad:click')(button('double'))
  kiosk.listeners.get('pad:click')(button('menu:6'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(kiosk.posts.map(post => [post.url, post.body.action]), [['/input', 'down'], ['/input', 'double'], ['/input', 'menu:6']])
})
