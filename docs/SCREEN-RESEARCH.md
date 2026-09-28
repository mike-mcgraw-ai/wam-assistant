# Handoff — how much of the G2 display can WAM actually use?

For a chat doing its own research into getting more usable screen. Written by
Claude at WAM v0.101.0. Everything below is measured, read out of the SDK, or
marked as an assumption. Where it is an assumption, say so and check it.

Mike's hypothesis, which prompted this: **the stock Even apps put text further
right than anything we have built.** That is correct, and the reason is in this
document. The interesting question is what to do about it.

---

## The headline

**WAM currently draws into the middle 288 px of a 576 px panel.** Half the
width, unused, by construction.

It is not a firmware limit on the display. It is a firmware limit on one
*image container*, and WAM uses one column of them.

---

## The two rendering paths, and which one is live

WAM has rendered the HUD two different ways. Both are in the tree; know which
you are looking at.

### 1. The native text container — the old path, now a fallback

`textContainerUpgrade` with a string. The firmware draws it in its own
proportional font. No font-size control at all, which is exactly why Codex
moved off it.

Relevant files: `glasses/src/render.ts` (produces the string),
`glasses/src/metrics.ts`, `glasses/src/font.json`, `glasses/src/format.ts`.

What we know about it, all measured:

- The firmware font is **proportional, including digits**: `1` is 7 px, `2` is
  11 px, most other digits 12 px, space 5.05 px and it does **not** collapse.
  Character padding cannot align columns; pixel layout can.
- Those widths were measured, not guessed — `glasses/tools/measure_font.py`
  renders each character once and then twenty-one times in the Even simulator,
  reads the rightmost lit pixel off a screenshot, and divides the difference by
  twenty so the side bearings cancel. See `glasses/tools/README-font.md`.
- `DISPLAY_PX = 576`. **`USABLE_PX = 480`** — and this number is soft. Read the
  comment in `metrics.ts`: it is set from *one* hardware observation (a line of
  35 `m` wrapped on real glasses where the simulator predicted it fitting, so
  it was pinned to the 30 `m` that did fit). Relative widths transfer from the
  simulator; the absolute line budget did not. **Nobody has re-measured this.**
  If the text path matters to you, this is a cheap, high-value experiment.
- Nine lines was the practical vertical budget on this path.

### 2. Compact bitmap images — what actually renders today (v0.100.0+)

`glasses/src/compactdisplay.ts`, 73 lines, read all of it. WAM renders the same
text frame to a `<canvas>`, thresholds it to hard-edged 4-bit greyscale, and
pushes the bytes into **image containers**. The text container is still created
— it is what receives ring input, and it is the fallback — but the pixels you
see come from images.

Current geometry, from `compactdisplay.ts` and `main.ts`:

```
COMPACT_W        288     one container's width
COMPACT_PANEL_H  108     one container's height
COMPACT_ROWS     12      six rows per band, two bands
COMPACT_X        144     (576 - 288) / 2   — centred, so x spans 144..432
COMPACT_Y         36     (288 - 216) / 2   — centred, so y spans 36..252
FONT_PX          11
LINE_PX          18
ADVANCE_SCALE    0.57    firmware advances, scaled
INK              204     of 255, before thresholding
```

Two containers stacked **vertically**. `containerTotalNum: 3` — two image, one
text.

---

## Why the stock apps reach further right

Straight from the SDK's own type declarations,
`node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts`:

```
declare class ImageContainerProperty {
    /** PB：Width，范围 20~288 */     width?: number;
    /** PB：Height，范围 20~144 */    height?: number;
```

**20–288 wide, 20–144 tall, per container.** And:

```
 * - `imageObject`：最多 4 项      (at most 4 image containers)
```

So one image container tops out at 288×144 — Codex's comment is accurate — but
**four of them tile the entire 576×288 panel exactly**:

```
   current                        available
   ┌─────────┐ 288×108            ┌──────────┬──────────┐ 288×144
   ├─────────┤ 288×108            ├──────────┼──────────┤ 288×144
   └─────────┘                    └──────────┴──────────┘
   x 144..432, y 36..252          x 0..576,  y 0..288
   = 31,104 px used               = 165,888 px  (5.3x)
```

WAM stacks two vertically and centres them. Nothing stops a 2×2 tiling. That
is almost certainly what a stock app that "goes further right" is doing, and it
is the first thing to verify.

**Verify it, do not assume it.** The 20–288 range is a doc comment in a `.d.ts`,
not something anyone here has pushed against. Find out whether the firmware
enforces it, whether the four containers may overlap or must tile, and whether
`zOrderIndex` matters for adjacency (every container needs a unique one — see
`validateEvenHubPageContainer`, which is already wired into boot and will
reject a bad page loudly rather than failing silently).

---

## The wall you will hit instead: bandwidth

This is the real constraint and it is easy to miss until the display goes slow.

BLE to the G2 is **10–30 KB/s practical**. A 4-bit greyscale frame costs
`width × height / 2` bytes:

| layout | bytes/frame | at 10 KB/s | at 30 KB/s |
|---|---|---|---|
| today, 2 × 288×108 | 31 KB | 3.1 s | 1.0 s |
| full 2×2, 4 × 288×144 | 83 KB | 8.3 s | 2.8 s |
| one 288×144 band | 21 KB | 2.1 s | 0.7 s |

Compare the old text path: a `textContainerUpgrade` was a few hundred bytes.
Moving to bitmaps traded a ~100× increase in frame cost for control over the
font. Going full-panel triples it again.

So the question is not "can we use the whole screen" — the answer looks like
yes — it is **"what is the refresh cost, and can we pay it only where the
pixels changed?"** Which leads to:

- `ImageRawDataUpdateFields` carries `mapSessionId`, `mapTotalSize`,
  `mapFragmentIndex`, `mapFragmentPacketSize`. That is a fragmented transfer
  protocol. **Find out whether a container can be updated independently of the
  others** — if so, a wide layout that only redraws the band that changed costs
  no more than today.
- Find out whether a *partial* update within one container is possible, or
  whether every update is a whole container.
- Measure what a real update actually costs. `glasses/tools/shot.mjs` and the
  simulator can time it; the honest number needs hardware.

Also live: the Listen screen repaints **every 2 seconds** while recording
(`main.ts`, the interval at the bottom). At 83 KB a frame that is not
affordable. Any widening has to be costed against that loop specifically.

---

## Tools you already have — use them before touching hardware

- **`npm run demo`** (`glasses/tools/demo.ts`) renders every screen to ASCII in
  Node with realistic state. This is how layout bugs get caught in seconds
  instead of through a build-upload-install cycle. Two paging bugs this month
  were invisible in code review and obvious in one frame of demo output. Run it
  before and after any layout change.
- **The Even simulator as an emulator** — `@evenrealities/evenhub-simulator`
  runs headless under Xvfb with `--automation-port`. Endpoints: `/api/ping`,
  `/api/screenshot/glasses` (576×288 PNG, **RGBA on a transparent ground —
  composite onto black or you will measure nothing**), `/api/screenshot/webview`,
  `/api/console`, `/api/input`. Linux deps: `libwebkit2gtk-4.1-0`, `xvfb`.
  This is how the font was measured and how a width change should be measured.
- **`glasses/tools/ruler.mjs`**, **`shot.mjs`**, **`measure_font.py`**,
  **`fonttest.ts`** (an in-app font test card) already exist for exactly this
  kind of work. Read `glasses/tools/README-font.md` first.
- **The simulator disagrees with hardware on absolute size.** That is the
  single most important caveat here — it is why `USABLE_PX` is 480 and not 576.
  Relative widths transfer. Totals do not. Any absolute claim needs a photo of
  real glasses.

---

## Questions worth answering, roughly in order of value

1. **Can four image containers tile the full 576×288?** Build the smallest
   possible page that declares four and fills each with a solid block, and look
   at it. This single experiment is most of the research.
2. **Can containers be updated independently?** Decides whether a wide layout
   is affordable or a novelty.
3. **What is the real per-frame transfer time on hardware** at today's 31 KB
   and at a hypothetical 83 KB?
4. **Is `USABLE_PX = 480` still right** for the text container? It is one
   observation old and the fallback path depends on it.
5. **What do the stock apps actually do?** Photograph the stock dashboard,
   measure where its text starts and ends against the 576 px panel, and compare
   to WAM's 144..432. This is evidence, and it is free.
6. Does `ADVANCE_SCALE = 0.57` still hold if the panel gets wider, or was it
   tuned for 288?

---

## Rules that are not negotiable

- **If the documentation does not cover it, ask Mike for more documentation
  rather than guessing.** This is his standing instruction and it exists
  because guessing at platform behaviour has cost real time here.
- Never run `npm i` through a remote bridge — `device_bash` is a Linux VM and
  will replace his macOS rollup/esbuild binaries. Builds happen on the Mac.
- `server/data/` is his real history: gitignored, never in an archive.
- Version and a `CHANGELOG.md` entry **before** packing — `npm run ship`
  enforces both and refuses a dirty tree. Claim the version number in the
  changelog as your *first* write, not your last: two agents work this repo and
  four version collisions happened before that habit.
- `app.json`: `package_id` is permanent, `name` is ≤20 chars and cannot contain
  "Even", the network whitelist is frozen at pack time and is **not** a CORS
  bypass.
- Nine lines was the old budget; it is twelve now. Do not reintroduce a
  hardcoded 9 — it lives in `config.maxLines`.

---

## Where things are

```
glasses/src/compactdisplay.ts   the live render path — read this first
glasses/src/metrics.ts          pixel layout, USABLE_PX, the 480 caveat
glasses/src/font.json           measured advance widths
glasses/src/render.ts           every screen, as text
glasses/src/config.ts           maxLines 12, rowsPerPage 10, maxChars 900
glasses/src/main.ts             container declaration, boot, the repaint loops
glasses/tools/                  demo, ruler, shot, measure_font, README-font
docs/HUD-LESSONS.md             what nine lines taught us about layout
docs/SCREENS.md                 rendered screens
node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts   the actual contract
```
