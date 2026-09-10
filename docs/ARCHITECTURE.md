# Ops Board — architecture decisions

Mike's G2 build. Code in `even-ops-board/`: `glasses/` (the plugin), `server/`
(the hub), `agents/` (Mac-side runner). Started 2026-09-04.

Companion docs: `docs/HANDOFF.md` is the contract for anything built outside
this repo. `README.md` is how to run it.

---

## What it is

Four things sharing one screen and one server:

1. **Metric boards** — building ops numbers, check-on-demand.
2. **Checklists** — daily rounds and on-demand procedures, with typed
   `do`/`wait` steps that record real durations.
3. **The running order** — one continuous schedule interleaving chores so the
   waits of one fill the gaps of another.
4. **The shared list** — an inbox he and his fiancée both add to from a phone
   page, processed later by an agent on the Mac.

Plus a Pong game and a font/glyph test card.

---

## The three constraints that shaped everything

**Plugins are foreground-only.** The WebView suspends when backgrounded and
Android may kill in-memory state. Nothing can push to the glasses. This is
**not an alerting tool** and must never be sold as one — existing alarms stay
where they are. Reminders route around it entirely: the server posts to a phone
notification service, and the glasses display it as a normal phone
notification, app closed.

**The display is tiny.** 576x288, roughly 44 characters by 11 lines,
~400–500 visible characters. Every screen is one text container redrawn with
`textContainerUpgrade` — flicker-free, and it leaves the contextual menu
intact. `rebuildPageContainer` is never called.

**Input is two gestures.** Scroll and click, plus double-tap and
tap-then-long-press. No held direction, no second axis — the R1 ring has the
same gestures as the temple pads, not more. Every screen is one flat list with
one cursor, because two cursors would mean the same gesture doing different
things depending on invisible focus.

---

## Data flow

```
BMS / meters / scripts ──POST /ingest──┐
Slack (#ops channel)   ──socket mode───┤
phone capture page     ──POST /inbox───┤──> hub ──GET /state──> G2 plugin
                                       │              (polls 15s)
Mac agent ──claims jobs, posts back────┘
```

**Why a server sits in the middle** — the plugin cannot call Slack or any other
service directly: a token bundled in the `.ehpk` is extractable by anyone who
installs it, and the `app.json` network whitelist is not a CORS bypass. Beyond
that, most building systems do not speak Slack at all, so a generic HTTP ingest
is the primary path and Slack is one source feeding it.

**The hub never calls a model.** It queues work; the Mac claims it and thinks
locally using whatever subscription is already paid for. An API key is an
escalation path (`priority: "now"`), not the default.

---

## Decisions worth not re-litigating

### Display and input

- **Text containers, not native lists.** Lists cannot be updated in place, so a
  15s poll would mean a full rebuild every 15s — flicker plus a cleared menu.
- **ASCII glyphs only** (`. ! X ?`, `[####----]`). The firmware silently drops
  glyphs outside its font set, and a dropped status marker reads as "fine" —
  the most dangerous possible failure. Unicode blocks only after the font test
  confirms them.
- **Cache-first cold start.** Launching from the glasses menu is a fresh page
  load, so the last snapshot paints immediately, marked `~CACHE` until live data
  lands. Cache older than an hour is discarded rather than shown.
- **Last good snapshot stays on screen** when a fetch fails; header shows
  `!NET`. Aging data visibly marked as aging beats a blank screen.
- **Boards and metrics sort worst-first.** Header counts metrics, not boards —
  a board whose worst status is `alert` would otherwise hide a warning beneath.

### Metrics

- **Staleness is a first-class status** (`?`), per-metric TTL, derived on read
  so it needs no cron. A sensor frozen at a good-looking value is the failure
  mode that actually hurts in building ops.
- **Metrics are not auto-created.** An ingest for an unknown id is rejected, so
  a typo in a field script cannot invent a metric nobody looks at.

### Checklists

- **Steps are typed `do` or `wait`.** A chore is not one duration. Active time
  answers "can I start this now"; wall time answers "will it be done before I
  leave". Tracking only one makes the number useless half the time.
- **Finishing a step auto-arms the next one only if it is a `wait`.** A machine
  runs whether or not you are watching. A `do` step never auto-starts —
  auto-starting it would fold standing around into the duration being measured.
- **Lag is recorded** between finishing one step and starting the next. A step
  always begun immediately gets flagged `autoStartSuggested` — surfaced, never
  applied silently, because the point of the number is that he decides.
- **Ticks apply locally first, then reconcile.** A failed write rolls back
  rather than sitting there looking saved. Shared-list items are the exception:
  those are server-authoritative, because two people are writing.
- **The operational day is shifted by `resetHour`**, so a 01:00 check on a night
  walk-through counts toward the day that started at 05:00 the morning before.

### The running order

- **No time window.** One continuous list ascending by start time; read down
  until the clock passes the time available and stop. Windows limit for no
  reason — the same list serves ten minutes and four hours.
- **Start the longest wait first.** Single-machine scheduling with chain
  precedence and delays; he is the one scarce resource, waits are free. A
  105-minute dishwasher goes before a 32-minute wash even though the wash is
  shorter.
- **Gaps are rows**, annotated with what is running and when it frees up. A
  32-minute hole while the washer goes is the most useful line on the screen.
- **Only chores where every step has a duration are plannable.** A list with no
  estimates is unknown, not "five minutes a step" — planning against invented
  numbers is worse than leaving it out.
- **`[>]` vs `( )`** marks whether a row can be started now or is gated behind
  an earlier step of the same chore, so he never picks a row he cannot do.

### The shared list

- **Capture never fails and never asks a question.** Raw text in, timestamped
  and attributed, no category, no required field. The moment capture asks
  "which list?", the other person stops using it — and a shared list nobody
  adds to is worse than no list.
- **Adds queue locally in the browser before they POST.** Works with no signal;
  flushes when the server is reachable. Each carries a `clientId` so a retry
  cannot duplicate.
- **The capture page is deliberately unauthenticated.** A login screen between
  someone and adding "milk" is the exact friction being avoided. It belongs on
  a LAN or behind a tunnel, never port-forwarded bare.
- **Two lanes, two speeds.** Raw items are on the glasses instantly under
  `Unsorted` and usable as-is; processing replaces them in place whenever the
  Mac next runs. A day later is fine.

### Jobs

- **Claim-with-lease, not assign.** An agent that dies mid-job must not strand
  the work; two agents polling the same capability must not both get it. A
  restart voids every lease.
- **Idempotency keys on every job**, because the retry that double-orders
  groceries is the failure this architecture invites.
- **Give up after 3 attempts** rather than looping on something broken.
- **Money and messages need a human gate.** Any job that spends, orders, sends
  or schedules must produce a *decision*, never a completed action.

---

## Open items

- **`LINE_CHARS = 44`** in `glasses/src/format.ts` is a conservative guess. The
  docs say a single LVGL font with no monospace option, and LVGL's stock faces
  are proportional — if so, every character-grid layout skews and the games and
  art move to image containers. **Menu -> Font test answers this in seconds.**
- **Image containers are documented but unproven**: 288x144, 4-bit greyscale,
  max 4 per page, LZ4 in transit, 100ms pacing. The simulator emulates none of
  it. Whether 4 tiles can cover the full canvas without hitting `oversize` or
  `outOfMemory` is a guess, not a fact.
- **Server origin must be in `app.json`'s whitelist before packing** — it
  cannot take a URL entered at runtime.
- **`READ_TOKEN`, if used, lives in `localStorage`** on the phone, never in
  source. Anything bundled in the `.ehpk` is extractable.
- **`glasses/src/main.ts` has absorbed a lot of incremental surgery**, including
  one repair after it was mangled into duplicate blocks. Due a deliberate
  cleanup pass before much more is added.
- **Retrieval is unbuilt** — finding the thought captured six weeks ago. Worth
  its own pass once there is a month of real captures to work against.

---

## Docs bugs found while building

- `@evenrealities/even_hub_sdk@0.0.14` ships `dist/index.d.ts` but its
  package.json `exports` map has no `types` condition. TS resolved it anyway
  under `moduleResolution: "bundler"`; may break other setups.
- The Your First App tutorial's `app.json` has `min_sdk_version: "0.0.12"`;
  the review floor is `"0.0.14"`. Copying it verbatim fails submission.
- The FAQ references a `user-info` permission absent from the packaging page's
  permission enum.
- Alexa's List Management API was withdrawn for third parties on 2024-07-01, so
  reading an Alexa shopping list programmatically is not possible. Custom skills
  still work.
