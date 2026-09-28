# Handoff — running WAM on the laptop instead of on your face

For a chat asked to fix the test loop. Written by Claude at v0.101.0.

---

## Status — built by Claude on top of v0.102.0

The screens page below exists. **Open it with `npm run screens`**, or go to
`http://localhost:5173/screens.html` if `npm run dev` is already running.

What it does:

- Every demo screen, rendered by the real `render()` and drawn through the real
  `compactdisplay.ts`, placed on a black 576×288 panel exactly where `main.ts`
  declares the image containers. Guides show the containers and the 2×2 tiling
  of 288×144 that `docs/SCREEN-RESEARCH.md` is about.
- Per screen: line count, character count, bytes per frame and an estimated
  cost per paint (the send-cost model from `docs/SCREEN-FINDINGS.md`, which
  replaced the KB/s table), and warnings for rows past 12, rows that run off the right edge
  of the bitmap (measured from the pixels), and non-ASCII the text fallback
  would drop.
- **Changes**: after a save, every screen whose pixels changed gets a badge
  naming the rows, and new ink / removed ink are painted yellow / red. **Pin**
  compares against a fixed set instead of the last update.
- **Clock**: the demo clock is held still (default: when the tab opened) so a
  frame only changes when code does. Set a time to see the list at 11pm.
- **Font**: "This browser" draws with the laptop's sans-serif (Helvetica on a
  Mac); "Android (Roboto)" draws with Roboto, stock Android's. The phone's real
  font is still an assumption until someone checks it.
- **Live**: the frame the glasses are showing right now, from the hub's
  `/screen` mirror, drawn as the bitmap. Needs the hub on `127.0.0.1:8787`
  (`WAM_LOCAL_HUB` overrides).
- Hot reload in place: `compactdisplay.ts` swaps without a reload; a change to
  `render.ts`, `format.ts`, the server modules or their config JSON re-fetches
  the frames. When the app itself is also loaded from the same dev server (QR
  sideload), Vite reloads everything as usual and the page restores its scroll
  and its change highlights.
- Save PNG on any card.

Files: `glasses/screens.html`, `glasses/src/screens-dev.ts` (the page),
`glasses/tools/screens-plugin.ts` (two dev-server routes, `apply: 'serve'`),
`glasses/tools/demo-screens.ts` (the demo state, now shared by
`npm run demo` and the page). None of it is in the build: `vite build` output
was byte-identical before and after.

### Verified against the simulator

The simulator runs headless on Linux (sim 0.9.5, Xvfb, `libwebkit2gtk-4.1-0`).
With the real app loaded in it and the hub running, the simulator's glasses
screenshot and the page's Live card for the same frame have the same ink
bounds to within 1px (x 150..416, y 42..249), the same rows, the same row
starts. With the same font forced on both, about 75% of lit pixels land
within 1px of each other; the rest is two different text rasterisers
(WebKit's vs Chrome's) thresholding their antialiasing differently.

So the page's geometry and pipeline are right. What it cannot promise is the
phone's font — and neither can the simulator: on Linux it draws the bitmap in
DejaVu Sans, about 13% wider at 11px than Helvetica or Roboto. On the Mac the
simulator uses the Mac's own sans-serif. Only the glasses know.

### What it showed on the first run

- **Columns drift in the compact bitmap.** `layout()` pads with spaces to
  pixel positions measured in the *firmware* font, where `1` is 7px. The
  bitmap is drawn in the WebView's font, where every digit is the same width,
  so any number containing a `1` comes out wider than `layout()` planned for.
  On the running order's wall-clock column, an `11m` row ends 7.6px further
  right than a `7m` row in Roboto (8.4px in DejaVu), and the `[>]` after it
  moves with it; in the firmware font the gap is 2px. The duration column
  drifts 3.8px (`15m` against `7m`), which `docs/SCREEN-FINDINGS.md` measured
  independently. The demo's plan mostly shows `--` in the wall-clock column,
  so the Live card shows this better than the demo frames do. The fix is
  cells placed at canvas-font x positions (SCREEN-FINDINGS section 5), in the
  layout engine or `compactdisplay.ts` — both collision points, so nothing
  here changes it.
- **Coach — manual**, row 2 (`AI! HVAC: CH-1 locked out 14:02 Open the board
  for deta`, already cut short by `render()`) needs 282.5px in Arial-metric
  fonts (Liberation Sans; Helvetica is the same shape) against 278px of room,
  so its tail is cut off in the bitmap. In Roboto it needs 277.0px — it fits
  by one pixel. That is the kind of row the font toggle exists for.

### Also fixed

- `tools/checkscreen.mjs` reads `config.maxLines` (12), `config.maxChars`,
  `metrics.measure` and `COMPACT_ROWS` from the app instead of hardcoding 44 /
  40 / 11. It no longer demands a gesture footer (HUD-LESSONS: those rows were
  removed on purpose). It says plainly that compact-bitmap width is a
  screens-page check.
- `tools/shot.mjs` saves whatever the simulator shows, composited onto black,
  and prints where the ink is. No hardcoded screen, no `/probe`, no `tsx`.
- `npm run sim` passes `--automation-port 9898`, which `shot.mjs` needs. The
  simulator still has to be installed once: `npm i -g @evenrealities/evenhub-simulator`.
- `npm run shot`, `npm run screens` added.

The problem, in one line: **changing a screen currently costs a build, a pack,
a portal upload, a phone install and a look at the glasses.** Minutes per
iteration, for something that is usually a five-pixel judgement. Two paging
bugs this month were invisible in code review and obvious in one rendered
frame — the loop is the bottleneck, not the work.

---

## Read this first: there are now TWO render paths

This is the thing most likely to waste your time if you miss it.

Since **v0.100.0** the glasses do not display the text WAM composes. They
display a **bitmap of it**. `glasses/src/compactdisplay.ts` renders the text
frame to a `<canvas>`, thresholds it to hard-edged 4-bit greyscale, and pushes
the bytes into two image containers. The native text container still exists —
it receives ring input and is the fallback — but it is not what you see.

Consequences:

- `compactdisplay.ts` calls `document.createElement('canvas')`. **It cannot run
  in Node.** Any Node-based preview shows the text that *feeds* the bitmap,
  never the bitmap.
- So a Node preview answers "is the content right, do the columns line up, does
  the paging work". It cannot answer "is this readable", "does it bloom",
  "where does it sit on the panel".
- Only a browser or the simulator answers the second set.

Do not let anyone "verify" a compact-display change with `npm run demo` alone.

---

## The four loops that exist today

Fastest first. Each answers a different question; none replaces the one below it.

### 1. `npm run demo` — milliseconds, Node, ASCII

`glasses/tools/demo.ts` builds realistic state from the real server modules
(`state.js`, `checklists.js`, `plan.js` and the actual config files) and prints
every screen inside a `+---+` frame with a char/line count.

Use it for: content, column alignment, paging and windowing, cursor
selectability, empty states. This is where layout bugs die cheaply.

It is the only loop with **no build step and no device**, and it is heavily
under-used. Extend it — adding a frame for a new screen is two lines.

### 2. `npm run dev` — a second, real browser, real canvas

Vite dev server. The app runs as it does in the phone WebView, including
`compactdisplay.ts` and its canvas. Hot reload on save.

Use it for: what the compact bitmap actually looks like, glyph weight, line
spacing, thresholding, ink level.

Gap: it renders in a browser page, not on a 576×288 panel with the glasses'
geometry. **Closing that gap is the highest-value thing to build — see below.**

### 3. The Even simulator — real panel geometry, automation API

```bash
npm i -g @evenrealities/evenhub-simulator     # NOT installed — check first
npm run dev &                                  # serves on :5173
evenhub-simulator --automation-port 9898 http://127.0.0.1:5173 &
```

Automation endpoints: `/api/ping`, `/api/screenshot/glasses` (576×288 PNG),
`/api/screenshot/webview`, `/api/console`, `/api/input`.

**The screenshot is RGBA on a transparent ground.** Composite onto black before
measuring anything or you will read zeros. This bit off a day once.

Linux deps if it ever runs headless: `libwebkit2gtk-4.1-0`, `xvfb`.

**Known divergence from hardware:** the simulator and the real glasses disagree
on *absolute* size — a line of 35 `m` wrapped on hardware where the simulator
said it fit. Relative widths transfer and are what alignment depends on; total
line budget does not. This is why `USABLE_PX` is 480 rather than 576. Treat
simulator pixels as truth for layout, never for "will it fit".

### 4. QR sideload — the real glasses, no packing

`npm run qr` prints a QR for `http://$LAN_IP:5173`. The glasses load the app
from the vite dev server instead of from a packed `.ehpk`, so a code change is
a reload rather than a build-upload-install.

**This is the loop most worth getting working**, and it is the answer to "push
to glasses when it's right" without a portal round-trip. Requires `LAN_IP` set
and the phone on the same network. Note `config.ts` derives the hub URL from
`window.location` during sideload, so the hub must be reachable at the same
host on :8787 — which `tailscale serve` already handles.

Full pack (`npm run ship` → upload → install) is then only needed for a build
you intend to keep.

---

## What to actually build: a screens page

The gap is between loop 1 (fast, wrong pixels) and loop 3 (right pixels, heavy
setup, and the simulator is not even installed).

**Build a dev-only page that renders every screen through the real
`compactdisplay.ts` path, at 576×288, all on one scrolling page, hot-reloading
on save.** One browser tab on the laptop, every screen, actual pixels, instant.

Sketch:

- `glasses/screens.html` + `glasses/src/screens-dev.ts`, served by vite
  alongside the app. Dev-only; it must not reach the packed bundle.
- Import the same demo state builder `tools/demo.ts` already has. Factor that
  state construction out of `demo.ts` into something both can import rather
  than duplicating it — if the two drift, the fast loop starts lying.
- For each screen: call `render(state)` for the text, then the same
  `renderPanel()` path `compactdisplay.ts` uses, and blit the resulting bytes
  into a `<canvas>` at true size on a black 576×288 ground, positioned at
  `COMPACT_X` / `COMPACT_Y` so the unused area is visible. Seeing the empty
  288 px on either side is itself informative — see `docs/SCREEN-RESEARCH.md`.
- Label each with its line count and the per-frame byte cost (`w × h ÷ 2`),
  since bandwidth is the real constraint on any layout change.
- A toggle for 1× and 2× or 3× zoom. At 1× on a laptop screen these are tiny,
  and judging bloom needs both.

That page would have caught every layout bug this month before it shipped.

---

## Things that were stale (as found at v0.101.0 — see Status above for what changed)

- **`evenhub-simulator` is not installed.** `npm run sim` will fail. Neither it
  nor the `evenhub` CLI are in `node_modules/.bin`; `evenhub` is global on the
  Mac (packing works), the simulator apparently is not.
- **`tools/shot.mjs`** predates the compact path. It hardcodes one sample
  screen, shells out to `npx tsx -e` with an inline script, and POSTs to the
  hub's `/probe` route. It captures the *text container*, not the bitmap, so
  what it screenshots is no longer what the glasses show. Either rework it
  against the compact path or retire it in favour of the screens page.
- **`tools/checkscreen.mjs`** validates against `MAX_COLS = 44`,
  `SAFE_COLS = 40`, `MAX_LINES = 11`. Both numbers are wrong now:
  `config.maxLines` is **12**, and width is a pixel measurement
  (`metrics.measure`), not a column count — the font is proportional, so
  counting characters was never right. Point it at `config` and `metrics`
  instead of hardcoding.
- **`/mirror`** on the hub is a live view of the current glasses frame
  (`server/src/web/mirror.html`, fed by `POST /screen` from `paint()`). It
  works today and is barely used. It mirrors the text frame, not the bitmap —
  worth either upgrading to the bitmap or documenting what it is for.

---

## Rules that are not negotiable

- **Build on the Mac.** Never `npm i` through a remote bridge — `device_bash`
  is a Linux VM and will replace macOS rollup/esbuild binaries with Linux ones.
- **If the documentation does not cover it, ask Mike for more documentation
  rather than guessing.** Standing instruction; guessing at platform behaviour
  has cost real time here.
- Version and a `CHANGELOG.md` entry **before** packing — `npm run ship`
  enforces both and refuses a dirty tree. Claim your version number in the
  changelog as your *first* write, not your last: two agents work this repo.
- `npm run ship`, never `pack:private` directly. Ship verifies the `.ehpk` is
  newer than the command that built it — six builds once shipped stale because
  a failed pack left the previous file sitting there under the same name.
- `server/data/` is Mike's real history: gitignored, never in an archive.
- A dev-only page must not end up in the packed bundle. Check the `.ehpk`
  contents before shipping one.

---

## Where things are

```
glasses/src/compactdisplay.ts   the live render path — 73 lines, read it all
glasses/src/render.ts           every screen, as text
glasses/src/metrics.ts          pixel measurement, USABLE_PX and its caveat
glasses/src/config.ts           maxLines 12, rowsPerPage 10, maxChars 900
glasses/tools/demo.ts           the fast loop, ASCII
glasses/tools/demo-screens.ts   the demo state — add new screens here
glasses/screens.html            the screens page (src/screens-dev.ts, tools/screens-plugin.ts)
glasses/tools/shot.mjs          simulator screenshot, on black
glasses/tools/checkscreen.mjs   limit validator, limits read from the app
glasses/tools/README-font.md    simulator setup and the measurement method
server/src/web/mirror.html      live view of the current frame
docs/SCREEN-RESEARCH.md         how much of the panel we are actually using
docs/HUD-LESSONS.md             what nine lines taught us about layout
```

## The loop this should end up being

```
edit a screen  →  save  →  glance at screens.html       (instant, real pixels)
               →  npm run demo                          (paging, alignment)
               →  QR sideload to the glasses            (readability, on a face)
               →  npm run ship                          (only when keeping it)
```
