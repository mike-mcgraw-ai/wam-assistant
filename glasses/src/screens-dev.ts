/**
 * The screens page: every WAM screen as the pixels the glasses are sent.
 *
 * Dev only. Loaded by screens.html, which `vite build` never includes, and
 * imported by nothing in the app.
 *
 * What it answers that `npm run demo` cannot: is it readable, does a row run
 * off the edge, where does it sit on the 576x288 panel, what did the last save
 * change. Each frame goes through the real compactdisplay.ts, the same code
 * paint() uses, and is placed where main.ts declares the image containers.
 *
 * What it still cannot answer: how it looks through the lens. The laptop's
 * sans-serif is not the phone's, and the panel's glow is not a monitor's. The
 * glasses (QR sideload) are the last word; this page is the fast first one.
 */
import * as compactModule from './compactdisplay'

type Compact = typeof compactModule
let compact: Compact = compactModule

interface Screen {
  title: string
  text: string
}

/** The full display. */
const PANEL_W = 576
const PANEL_H = 288

/**
 * What a paint costs, as main.ts sends it today: every image container, then
 * the text layer. Community timings, one data point, not yet measured on
 * these glasses (docs/SCREEN-FINDINGS.md, section 2): ~104 ms per image send
 * plus ~3.9 ms per KB of 4-bit data, ~83 ms per text upgrade. The fixed cost
 * per send dominates, which is why the number of containers matters more
 * than their size.
 */
const SEND_MS = 104
const MS_PER_KB = 3.9
const TEXT_MS = 83

const LIVE_TITLE = 'Live — on the glasses now'

// ---- settings, per tab -----------------------------------------------------

interface Settings {
  zoom: number
  font: 'system' | 'roboto'
  guides: boolean
  changes: boolean
  text: boolean
  live: boolean
  filter: string
  /** the demo clock, held still so frames change only when code does */
  now: number
  pinned: boolean
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: the page still works, it just forgets.
  }
}

const settings: Settings = load<Settings>('wam-screens.settings', {
  zoom: 1,
  font: 'system',
  guides: true,
  changes: true,
  text: false,
  live: true,
  filter: '',
  now: Math.floor(Date.now() / 60_000) * 60_000,
  pinned: false,
})

// ---- the font toggle -------------------------------------------------------

/**
 * compactdisplay.ts draws with `11px sans-serif`, and sans-serif is whatever
 * the browser says it is: Helvetica in a Mac browser, the system font in the
 * phone's WebView (Roboto on stock Android). Glyph widths differ, so a row
 * that fits here can clip there. The toggle rewrites the family on the way
 * into the canvas, on this page only, so the shipped code stays untouched.
 */
const fontProp = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'font')
let fontFamily: string | null = null
if (fontProp?.get && fontProp.set) {
  const { get, set } = fontProp
  Object.defineProperty(CanvasRenderingContext2D.prototype, 'font', {
    configurable: true,
    get() {
      return get.call(this)
    },
    set(value: string) {
      set.call(this, fontFamily ? value.replace(/\bsans-serif\b/, `${fontFamily}, sans-serif`) : value)
    },
  })
}

/**
 * Is `family` really available? `document.fonts.check()` cannot say: it
 * answers true for any family it has no @font-face for, which is exactly the
 * case when the stylesheet failed to load. So measure: a real font changes the
 * width of a test string against two different fallbacks.
 */
function fontAvailable(family: string): boolean {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return false
  const sample = 'mmmmmmmmmmlli10WQ'
  return ['monospace', 'serif'].some(fallback => {
    ctx.font = `40px ${fallback}`
    const base = ctx.measureText(sample).width
    ctx.font = `40px "${family}", ${fallback}`
    return ctx.measureText(sample).width !== base
  })
}

async function applyFont(): Promise<string> {
  if (settings.font !== 'roboto') {
    fontFamily = null
    return `Drawn with this browser's sans-serif. The phone's may differ.`
  }
  try {
    await document.fonts.load('11px Roboto')
  } catch {
    // falls through to the check below
  }
  if (fontAvailable('Roboto')) {
    fontFamily = 'Roboto'
    return 'Drawn with Roboto (stock Android). Check your phone’s font if a row is borderline.'
  }
  fontFamily = null
  return `Roboto did not load (offline?). Showing this browser's sans-serif instead.`
}

// ---- rendering -------------------------------------------------------------

interface Rendered {
  panels: number
  /** 4-bit level of every container pixel, panel after panel */
  levels: Uint8Array
  bytes: number
  lines: number
  chars: number
  warnings: Array<{ text: string; bad: boolean }>
}

function renderScreen(text: string): Rendered {
  const { COMPACT_W: W, COMPACT_PANEL_H: H, COMPACT_ROWS } = compact
  const panels = compact.renderCompactDisplay(text)
  const levels = new Uint8Array(panels.length * W * H)
  panels.forEach((panel, p) => {
    for (let i = 0; i < W * H; i += 1) levels[p * W * H + i] = Math.max(0, Math.min(15, (panel[i] ?? 0) >> 4))
  })

  const lines = text.split('\n')
  const warnings: Rendered['warnings'] = []

  if (lines.length > COMPACT_ROWS) {
    warnings.push({ text: `${lines.length} lines: rows ${COMPACT_ROWS + 1}+ are not drawn`, bad: true })
  }

  // A row that runs past the container is cut off at the edge, not wrapped.
  // Any ink in the last two columns means the row ran out of room: the render
  // leaves a margin on both sides, so a row that fits never reaches them.
  const rowsPerPanel = COMPACT_ROWS / panels.length
  const rowH = H / rowsPerPanel
  const clipped = new Set<number>()
  for (let p = 0; p < panels.length; p += 1) {
    for (let y = 0; y < H; y += 1) {
      const base = p * W * H + y * W
      if (levels[base + W - 1] || levels[base + W - 2]) clipped.add(p * rowsPerPanel + Math.floor(y / rowH) + 1)
    }
  }
  for (const row of clipped) {
    const line = lines[row - 1] ?? ''
    warnings.push({ text: `row ${row} runs off the right edge: "${line.trim().slice(-18)}"`, bad: true })
  }

  lines.forEach((line, i) => {
    const odd = [...line].find(ch => {
      const code = ch.codePointAt(0) ?? 0
      return code < 32 || code > 126
    })
    if (odd) {
      warnings.push({
        text: `row ${i + 1} has non-ASCII "${odd}": fine here, dropped by the native text fallback`,
        bad: false,
      })
    }
  })

  return {
    panels: panels.length,
    levels,
    bytes: (panels.length * W * H) / 2,
    lines: lines.length,
    chars: text.length,
    warnings,
  }
}

function pack(levels: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(levels.length / 2))
  for (let i = 0; i < levels.length; i += 2) out[i >> 1] = (levels[i] << 4) | (levels[i + 1] ?? 0)
  let s = ''
  for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000))
  return btoa(s)
}

function unpack(b64: string, length: number): Uint8Array | null {
  try {
    const s = atob(b64)
    const out = new Uint8Array(length)
    for (let i = 0; i < length; i += 1) {
      const byte = s.charCodeAt(i >> 1)
      out[i] = i % 2 === 0 ? byte >> 4 : byte & 15
    }
    return out
  } catch {
    return null
  }
}

// ---- cards -----------------------------------------------------------------

interface Card {
  title: string
  root: HTMLElement
  canvas: HTMLCanvasElement
  badge: HTMLElement
  stats: HTMLElement
  warns: HTMLElement
  pre: HTMLElement
  text: string
  rendered: Rendered | null
  /** what it looked like last time, for the change highlight */
  before: Uint8Array | null
  diff: { added: number; removed: number; rows: number[] } | null
}

const grid = document.getElementById('grid') as HTMLElement
const cards = new Map<string, Card>()

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

/**
 * Where the containers sit. Mirrors the imageObject declaration in main.ts:
 * panel N at (COMPACT_X, COMPACT_Y + N * COMPACT_PANEL_H). If main.ts changes
 * its layout — a 2x2 tiling, say — change this with it.
 */
function containerAt(p: number): { x: number; y: number } {
  return { x: compact.COMPACT_X, y: compact.COMPACT_Y + p * compact.COMPACT_PANEL_H }
}

let guideId = 0

/**
 * Guides sit outside the pixels they describe, never on them: a line drawn
 * over a row of text is exactly the thing that hides a one-pixel problem.
 * The containers get one outline around the lot plus ticks at each seam;
 * the 2x2 tiling is dashed and masked out wherever a container is.
 */
function guides(panels: number): SVGElement {
  const W = compact.COMPACT_W
  const H = compact.COMPACT_PANEL_H
  const root = svg('svg', { viewBox: `0 0 ${PANEL_W} ${PANEL_H}`, preserveAspectRatio: 'none' })
  const common = { fill: 'none', 'vector-effect': 'non-scaling-stroke', 'shape-rendering': 'crispEdges' }

  const boxes = Array.from({ length: panels }, (_, p) => containerAt(p))
  const left = Math.min(...boxes.map(b => b.x))
  const top = Math.min(...boxes.map(b => b.y))
  const right = Math.max(...boxes.map(b => b.x + W))
  const bottom = Math.max(...boxes.map(b => b.y + H))

  const maskId = `wam-guide-mask-${(guideId += 1)}`
  const mask = svg('mask', { id: maskId, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: PANEL_W, height: PANEL_H })
  mask.append(svg('rect', { x: 0, y: 0, width: PANEL_W, height: PANEL_H, fill: '#fff' }))
  for (const b of boxes) mask.append(svg('rect', { x: b.x - 1, y: b.y - 1, width: W + 2, height: H + 2, fill: '#000' }))
  const defs = svg('defs', {})
  defs.append(mask)

  const tiling = svg('g', { mask: `url(#${maskId})`, stroke: '#5c6b63' })
  tiling.append(
    svg('line', { ...common, x1: PANEL_W / 2, y1: 0, x2: PANEL_W / 2, y2: PANEL_H, 'stroke-dasharray': '4 4' }),
    svg('line', { ...common, x1: 0, y1: PANEL_H / 2, x2: PANEL_W, y2: PANEL_H / 2, 'stroke-dasharray': '4 4' }),
  )

  root.append(
    defs,
    svg('rect', { ...common, x: 0.5, y: 0.5, width: PANEL_W - 1, height: PANEL_H - 1, stroke: '#5c6b63' }),
    tiling,
    svg('rect', {
      ...common,
      x: left - 1.5,
      y: top - 1.5,
      width: right - left + 3,
      height: bottom - top + 3,
      stroke: '#3fb8c9',
    }),
  )
  for (const b of boxes.slice(1)) {
    root.append(
      svg('line', { ...common, x1: left - 8, y1: b.y, x2: left - 2, y2: b.y, stroke: '#3fb8c9' }),
      svg('line', { ...common, x1: right + 2, y1: b.y, x2: right + 8, y2: b.y, stroke: '#3fb8c9' }),
    )
  }
  return root
}

function makeCard(title: string, live = false): Card {
  const root = document.createElement('section')
  root.className = live ? 'card live' : 'card'
  root.dataset.title = title

  const head = document.createElement('div')
  head.className = 'head'
  const h2 = document.createElement('h2')
  h2.textContent = title
  const badge = document.createElement('span')
  badge.className = 'badge'
  head.append(h2, badge)

  const frame = document.createElement('div')
  frame.className = 'frame'
  // The live card has nothing to draw until the glasses send a frame.
  frame.hidden = live
  const canvas = document.createElement('canvas')
  canvas.width = PANEL_W
  canvas.height = PANEL_H
  frame.append(canvas)

  const stats = document.createElement('div')
  stats.className = 'stats'
  const warns = document.createElement('ul')
  warns.className = 'warns'
  const pre = document.createElement('pre')
  pre.className = 'text'

  const foot = document.createElement('div')
  foot.className = 'foot'
  const png = document.createElement('button')
  png.className = 'plain'
  png.textContent = 'Save PNG'
  png.title = 'The 576x288 frame at 1x, no guides, no highlight'
  foot.append(png)

  root.append(head, frame, stats, warns, pre, foot)

  const card: Card = { title, root, canvas, badge, stats, warns, pre, text: '', rendered: null, before: null, diff: null }
  png.addEventListener('click', () => savePng(card))
  return card
}

function sizeCard(card: Card): void {
  const w = PANEL_W * settings.zoom
  const h = PANEL_H * settings.zoom
  card.canvas.style.width = `${w}px`
  card.canvas.style.height = `${h}px`
  const overlay = card.root.querySelector('.frame svg') as SVGElement | null
  if (overlay) {
    overlay.setAttribute('width', String(w))
    overlay.setAttribute('height', String(h))
  }
}

/** Draw into a 576x288 canvas; with `before`, what changed since then is painted over. */
function drawPixels(target: HTMLCanvasElement, r: Rendered, before: Uint8Array | null): void {
  const ctx = target.getContext('2d')
  if (!ctx) return
  const img = ctx.createImageData(PANEL_W, PANEL_H)
  const d = img.data
  for (let i = 3; i < d.length; i += 4) d[i] = 255
  const W = compact.COMPACT_W
  const H = compact.COMPACT_PANEL_H
  for (let p = 0; p < r.panels; p += 1) {
    const at = containerAt(p)
    for (let y = 0; y < H; y += 1) {
      const py = at.y + y
      if (py < 0 || py >= PANEL_H) continue
      for (let x = 0; x < W; x += 1) {
        const px = at.x + x
        if (px < 0 || px >= PANEL_W) continue
        const k = p * W * H + y * W + x
        const v = r.levels[k]
        const o = (py * PANEL_W + px) * 4
        const was = before ? before[k] : v
        if (was !== v && v > was) {
          d[o] = 255; d[o + 1] = 225; d[o + 2] = 77
        } else if (was !== v) {
          d[o] = 255; d[o + 1] = 90; d[o + 2] = 90
        } else {
          // Green panel: brightness is the 4-bit level, nothing added.
          const g = v * 17
          d[o] = Math.round(g * 0.3); d[o + 1] = g; d[o + 2] = Math.round(g * 0.45)
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0)
}

function savePng(card: Card): void {
  if (!card.rendered) return
  const out = document.createElement('canvas')
  out.width = PANEL_W
  out.height = PANEL_H
  drawPixels(out, card.rendered, null)
  out.toBlob(blob => {
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `wam-${card.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }, 'image/png')
}

function diffOf(r: Rendered, before: Uint8Array | null): Card['diff'] {
  if (!before || before.length !== r.levels.length) return null
  const W = compact.COMPACT_W
  const H = compact.COMPACT_PANEL_H
  const rowsPerPanel = compact.COMPACT_ROWS / r.panels
  const rowH = H / rowsPerPanel
  let added = 0
  let removed = 0
  const rows = new Set<number>()
  for (let k = 0; k < r.levels.length; k += 1) {
    const now = r.levels[k]
    const was = before[k]
    if (now === was) continue
    if (now > was) added += 1
    else removed += 1
    const p = Math.floor(k / (W * H))
    const y = Math.floor((k % (W * H)) / W)
    rows.add(p * rowsPerPanel + Math.floor(y / rowH) + 1)
  }
  if (!added && !removed) return null
  return { added, removed, rows: [...rows].sort((a, b) => a - b) }
}

function paintCard(card: Card): void {
  const r = card.rendered
  if (!r) return
  const showChanges = settings.changes && card.diff !== null
  ;(card.root.querySelector('.frame') as HTMLElement).hidden = false
  drawPixels(card.canvas, r, showChanges ? card.before : null)

  const overlay = card.root.querySelector('.frame svg')
  const fresh = guides(r.panels)
  if (overlay) overlay.replaceWith(fresh)
  else card.canvas.after(fresh)
  sizeCard(card)

  card.badge.textContent = card.diff
    ? `changed: row${card.diff.rows.length === 1 ? '' : 's'} ${card.diff.rows.join(', ')}  +${card.diff.added} −${card.diff.removed} px`
    : ''

  const ms = Math.round(r.panels * SEND_MS + (r.bytes / 1000) * MS_PER_KB + TEXT_MS)
  card.stats.textContent =
    `${r.lines} lines · ${r.chars} chars · ${r.panels} × ${compact.COMPACT_W}×${compact.COMPACT_PANEL_H} = ` +
    `${r.bytes.toLocaleString()} B/frame · ~${ms} ms/paint as sent today (est.)`

  card.warns.replaceChildren(
    ...r.warnings.map(w => {
      const li = document.createElement('li')
      li.textContent = w.text
      if (w.bad) li.className = 'bad'
      return li
    }),
  )
  card.pre.textContent = card.text
}

// ---- the demo frames -------------------------------------------------------

/**
 * What each screen looked like, kept per tab so it survives a reload.
 *
 * `cur` is the frame last shown; `before` is what it was compared with. When a
 * reload brings back the same frame, the comparison carries over — otherwise a
 * reload racing an update would swallow the highlight it was about to show.
 */
interface Kept {
  cur: string
  before?: string
}
const PREV_KEY = 'wam-screens.prev'
const PIN_KEY = 'wam-screens.pinned'
let kept: Record<string, Kept> = load<Record<string, Kept>>(PREV_KEY, {})
let pinnedFrames: Record<string, string> = load<Record<string, string>>(PIN_KEY, {})
let screens: Screen[] = []
let lastError: string | null = null

/** Render every demo frame and compare each with its baseline. */
function renderAll(): void {
  const seen = new Set<string>()
  const nextKept: Record<string, Kept> = {}
  for (const screen of screens) {
    seen.add(screen.title)
    let card = cards.get(screen.title)
    if (!card) {
      card = makeCard(screen.title)
      cards.set(screen.title, card)
    }
    card.text = screen.text
    card.rendered = renderScreen(screen.text)
    const now = pack(card.rendered.levels)
    const last = kept[screen.title]
    const before = !last ? undefined : last.cur === now ? last.before : last.cur
    nextKept[screen.title] = before === undefined ? { cur: now } : { cur: now, before }
    const baseline = settings.pinned ? pinnedFrames[screen.title] : before
    card.before = baseline ? unpack(baseline, card.rendered.levels.length) : null
    card.diff = diffOf(card.rendered, card.before)
    paintCard(card)
  }
  for (const [title, card] of cards) {
    if (title !== LIVE_TITLE && !seen.has(title)) {
      card.root.remove()
      cards.delete(title)
    }
  }
  // Demo order, after the live card. Re-appended only when it differs, so an
  // ordinary update moves nothing and the scroll position holds.
  const wanted = screens.map(s => cards.get(s.title)?.root).filter((el): el is HTMLElement => Boolean(el))
  const current = [...grid.children].filter(el => el !== liveCard?.root)
  if (wanted.length !== current.length || wanted.some((el, i) => el !== current[i])) {
    for (const el of wanted) grid.append(el)
  }
  kept = nextKept
  save(PREV_KEY, kept)
  applyFilter()
  summarise()
}

function summarise(): void {
  const all = screens.map(s => cards.get(s.title)).filter((c): c is Card => Boolean(c))
  const changed = all.filter(c => c.diff).length
  const flagged = all.filter(c => c.rendered?.warnings.some(w => w.bad)).length
  const clock = new Date(settings.now).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  const parts = [
    `${all.length} screens`,
    `clock held at ${clock}`,
    changed ? `<span class="warn">${changed} changed ${settings.pinned ? 'since pin' : 'in the last update'}</span>` : 'no changes',
    flagged ? `<span class="bad">${flagged} with problems</span>` : 'no problems',
  ]
  ;(document.getElementById('summary') as HTMLElement).innerHTML = parts.join(' · ')
}

function showError(message: string | null): void {
  const el = document.getElementById('error') as HTMLElement
  el.style.display = message ? 'block' : 'none'
  el.textContent = message
    ? `The demo frames failed to render. Showing the last good ones.\n\n${message}`
    : ''
}

let refreshing: Promise<void> | null = null
let refreshAgain = false

async function refresh(): Promise<void> {
  if (refreshing) {
    refreshAgain = true
    return refreshing
  }
  refreshing = (async () => {
    try {
      const res = await fetch(`/__screens/demo?now=${settings.now}`, { cache: 'no-store' })
      const body = (await res.json()) as { screens?: Screen[]; error?: string }
      if (!res.ok || !body.screens) throw new Error(body.error || `HTTP ${res.status}`)
      screens = body.screens
      lastError = null
    } catch (err) {
      // Never blank on failure: keep the last good frames and say what broke.
      lastError = err instanceof Error ? err.message : String(err)
    }
    showError(lastError)
    if (!lastError || cards.size === 0) renderAll()
  })()
  try {
    await refreshing
  } finally {
    refreshing = null
    if (refreshAgain) {
      refreshAgain = false
      void refresh()
    }
  }
}

// ---- live ------------------------------------------------------------------

let liveCard: Card | null = null
let liveText: string | null = null
let liveTimer: number | undefined

async function pollLive(): Promise<void> {
  window.clearTimeout(liveTimer)
  if (!settings.live) {
    liveCard?.root.remove()
    liveCard = null
    liveText = null
    return
  }
  if (!liveCard) {
    liveCard = makeCard(LIVE_TITLE, true)
    cards.set(LIVE_TITLE, liveCard)
  }
  if (!liveCard.root.isConnected) grid.prepend(liveCard.root)

  let failed = false
  try {
    const res = await fetch('/__screens/live', { cache: 'no-store' })
    const body = (await res.json()) as { hub: string; text?: string; at?: number; error?: string }
    if (body.error) {
      failed = true
      liveCard.badge.textContent = ''
      if (!liveCard.rendered) {
        liveCard.stats.textContent = `No hub at ${body.hub} (${body.error}). Start it with ./start.sh, or set WAM_LOCAL_HUB.`
      }
    } else if (!body.at) {
      liveCard.stats.textContent = `Hub at ${body.hub} is up; the glasses have not sent a frame since it started.`
    } else {
      if (body.text !== liveText) {
        liveText = body.text ?? ''
        liveCard.text = liveText
        liveCard.rendered = renderScreen(liveText)
        liveCard.before = null
        liveCard.diff = null
        paintCard(liveCard)
      }
      const age = Math.max(0, Math.round((Date.now() - body.at) / 1000))
      liveCard.badge.className = 'badge age'
      liveCard.badge.textContent = age < 60 ? `${age}s old` : `${Math.round(age / 60)}m old`
    }
  } catch {
    failed = true
  }
  liveTimer = window.setTimeout(() => void pollLive(), failed ? 5000 : 1000)
}

// ---- controls --------------------------------------------------------------

function applyFilter(): void {
  const q = settings.filter.trim().toLowerCase()
  for (const [title, card] of cards) {
    card.root.hidden = title !== LIVE_TITLE && q !== '' && !title.toLowerCase().includes(q)
  }
}

function syncControls(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach(b => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.zoom) === settings.zoom))
  })
  document.querySelectorAll<HTMLButtonElement>('[data-font]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.font === settings.font))
  })
  ;(document.getElementById('guides') as HTMLInputElement).checked = settings.guides
  ;(document.getElementById('changes') as HTMLInputElement).checked = settings.changes
  ;(document.getElementById('text') as HTMLInputElement).checked = settings.text
  ;(document.getElementById('live') as HTMLInputElement).checked = settings.live
  ;(document.getElementById('filter') as HTMLInputElement).value = settings.filter
  const d = new Date(settings.now)
  ;(document.getElementById('clock') as HTMLInputElement).value =
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const pin = document.getElementById('pin') as HTMLButtonElement
  pin.setAttribute('aria-pressed', String(settings.pinned))
  pin.textContent = settings.pinned ? 'Unpin' : 'Pin'
  ;(document.getElementById('changes-key') as HTMLElement).style.display = settings.changes ? '' : 'none'
  document.body.classList.toggle('guides', settings.guides)
  document.body.classList.toggle('show-text', settings.text)
}

function changed(): void {
  save('wam-screens.settings', settings)
  syncControls()
}

document.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach(b =>
  b.addEventListener('click', () => {
    settings.zoom = Number(b.dataset.zoom) || 1
    changed()
    for (const card of cards.values()) sizeCard(card)
  }),
)

document.querySelectorAll<HTMLButtonElement>('[data-font]').forEach(b =>
  b.addEventListener('click', async () => {
    settings.font = b.dataset.font === 'roboto' ? 'roboto' : 'system'
    changed()
    ;(document.getElementById('font-note') as HTMLElement).textContent = await applyFont()
    liveText = null
    renderAll()
  }),
)

function toggle(id: string, key: 'guides' | 'changes' | 'text' | 'live', after?: () => void): void {
  document.getElementById(id)?.addEventListener('change', event => {
    settings[key] = (event.target as HTMLInputElement).checked
    changed()
    after?.()
  })
}
toggle('guides', 'guides')
toggle('changes', 'changes', () => {
  for (const card of cards.values()) paintCard(card)
})
toggle('text', 'text')
toggle('live', 'live', () => void pollLive())

document.getElementById('filter')?.addEventListener('input', event => {
  settings.filter = (event.target as HTMLInputElement).value
  changed()
  applyFilter()
})

document.getElementById('clock')?.addEventListener('change', event => {
  const value = (event.target as HTMLInputElement).value
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!match) return
  const d = new Date(settings.now)
  d.setHours(Number(match[1]), Number(match[2]), 0, 0)
  settings.now = d.getTime()
  changed()
  void refresh()
})

document.getElementById('clock-now')?.addEventListener('click', () => {
  settings.now = Math.floor(Date.now() / 60_000) * 60_000
  changed()
  void refresh()
})

document.getElementById('pin')?.addEventListener('click', () => {
  settings.pinned = !settings.pinned
  pinnedFrames = settings.pinned
    ? Object.fromEntries(Object.entries(kept).map(([title, k]) => [title, k.cur]))
    : {}
  save(PIN_KEY, pinnedFrames)
  changed()
  renderAll()
})

// Scroll position survives a full reload (Vite reloads when the app also
// loaded the file you saved); the cards arrive after the browser's own
// restore would have run, so it is put back by hand.
const SCROLL_KEY = 'wam-screens.scroll'
let scrollTimer: number | undefined
window.addEventListener('scroll', () => {
  window.clearTimeout(scrollTimer)
  scrollTimer = window.setTimeout(() => save(SCROLL_KEY, { y: window.scrollY }), 150)
})

// ---- hot reload ------------------------------------------------------------

declare global {
  interface ImportMeta {
    /** Vite's HMR handle. Present only under the dev server. */
    readonly hot?: {
      on(event: string, cb: (data: unknown) => void): void
      accept(dep: string, cb: (mod: unknown) => void): void
    }
  }
}

// Written out literally: Vite finds accepted deps by reading this call.
if (import.meta.hot) {
  // render.ts, format.ts, the server modules or their config changed: new text.
  import.meta.hot.on('wam-screens:stale', () => void refresh())
  // compactdisplay.ts changed: same text, new pixels, no reload.
  import.meta.hot.accept('./compactdisplay', mod => {
    if (!mod) return
    compact = mod as Compact
    liveText = null
    renderAll()
  })
}

// ---- boot ------------------------------------------------------------------

;(document.getElementById('version') as HTMLElement).textContent =
  `v${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '?'} · dev only`
syncControls()
;(document.getElementById('font-note') as HTMLElement).textContent = await applyFont()
await refresh()
if (!screens.length && !lastError) grid.innerHTML = '<p class="empty">No demo screens.</p>'
window.scrollTo(0, load<{ y: number }>(SCROLL_KEY, { y: 0 }).y)
void pollLive()
