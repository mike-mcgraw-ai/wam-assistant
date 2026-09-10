# Designing a HUD you actually use: layout, controls, and the list model

Field notes from building WAM, a personal heads-up display for Even
Realities G2 smart glasses. Written for the agent working on the AI
integration layer, so it leads with the constraints that will bite you and the
data model you have to respect.

---

## 1. The display is smaller and stranger than it sounds

576 x 288 pixels per eye, monochrome green, 4-bit greyscale. In practice that
is **nine readable lines**. Every row you spend on a title, a footer, a hint,
or a separator is one you did not spend on content, and at nine lines that
trade is always visible.

The single most expensive lesson:

> **The firmware font is proportional, including the numerals.**

Measured advance widths: `1` is **7px**, `2` is **11px**, every other digit is
**12px**. A space is **5.05px** and does *not* collapse — `AB` with 0/5/10/20
spaces measures 22/49/74/124px, dead linear.

This means character-count padding is a trap. `padStart(5)` produces columns
that line up perfectly in your terminal and wander by up to 56px on glass. The
symptom is maddening to debug by eye: two rows appear aligned, a third does
not, and the difference is that one of them contained the digit `1`.

**Lay out in pixels, not characters.** We keep a measured width table
(`font.json`) and a `layout()` that places cells at pixel offsets, either
left-edge (`at`) or right-edge (`end`). Right-edge placement is what a column
of numbers wants. Residual error is under one space width — about half a
digit — which reads as a column.

### Build the emulator before you build the screens

We wasted several build-and-squint cycles before discovering that Even ships a
real one. `@evenrealities/evenhub-simulator` renders the true 576x288 display,
runs headless under Xvfb, and exposes an automation HTTP API:

```
GET  /api/ping
GET  /api/screenshot/glasses     576x288 PNG, RGBA on a transparent ground
GET  /api/screenshot/webview
GET  /api/console
POST /api/input
```

With that, font measurement is mechanical rather than perceptual: render each
character once and again 21 times, read the rightmost lit pixel, divide the
difference by 20. Side bearings cancel. Two gotchas cost us an hour each —
the screenshot is RGBA on a *transparent* ground (convert straight to
greyscale and every empty pixel reads as ink), and short glyphs like `'` `:`
`i` need a tall anchor character on the line or the scanline grouping loses
the row entirely.

One caveat we have not resolved: the simulator and the hardware disagree on
*absolute* scale. A line that the simulator fits, the glasses wrapped.
Relative widths — which is what alignment depends on — do transfer. The line
budget does not, so we set the usable width from the hardware observation and
not from the simulator.

---

## 2. Platform constraints worth knowing before you design anything

- **All logic runs on the phone.** The glasses are a render target and an
  input source. Your code is a web app in the phone's WebView.
- **Foreground only.** No push notifications; the WebView suspends when
  backgrounded. Anything time-based has to route out through phone
  notifications rather than living in the app.
- **Containers**: max 4 image and 8 other per page; exactly one must be
  `isEventCapture: 1`. `textContainerUpgrade` is flicker-free;
  `rebuildPageContainer` clears the contextual menu.
- **Image containers**: 20–288 wide, 20–144 high, 4-bit greyscale, LZ4 in
  transit, ~100ms pacing, and they cannot be populated at create time. Text
  antialiasing turns to mush at 16 grey levels — a hand-drawn bitmap font
  rendered as integer-scaled blocks is legible where canvas text is not.
- **Contextual menu**: at most 10 top-level items; labels capped at 32 UTF-8
  bytes; IDs are non-zero and unique. **First item's label cannot change after
  create**, so name it for both ends of a toggle rather than the destination.
- **`app.json`**: `package_id` is permanent, `name` is ≤20 chars and cannot
  contain "Even", the network whitelist is frozen at pack time — and it is
  **not** a CORS bypass, the WebView enforces CORS independently, so both
  gates must pass.
- **Input arrives on `event.sysEvent`, not `event.textEvent`.** This
  contradicts the platform's own first-app sample. We lost a full session to
  it: taps registered, the app saw nothing. Read carrier-agnostically and
  normalise, and do not filter strictly on `containerID`.

---

## 3. Controls: two gestures, and what that forces

You have scroll and click, plus double-tap for back and long-press for the
menu. On a ring in your pocket, or a temple touchpad while walking a building,
that is the whole vocabulary. Everything below came from getting it wrong
first.

**Never auto-start anything on arrival.** Opening the Dishes checklist
auto-started "load dishwasher" and left it running five hours, poisoning the
median for that step. Opening a list should commit you to nothing. Clicking is
what starts.

**Two clicks for state changes.** First click starts a step, second completes
it. Both deliberate.

**Arm-then-confirm for anything irreversible.** Ticking off "call dentist" you
have not made is not undoable from your face. The row flips to `[?] done?` and
waits; any cursor movement disarms.

**Detect and reset implausible durations.** A step running for many multiples
of its estimate is flagged `suspect` and its click *resets* rather than
completes — a bad number must never reach the median.

**Do not wrap at list ends.** Wrapping is fine on four rows. On a forty-row
list one flick at the top throws you to page ten with no idea how you got
there.

**Page-flip with a cursor beat smooth scrolling.** We tried sliding the window
one row at a time; the user's word was "jolty". The original complaint had
been that the view had *no selector*, not that paging was wrong. Worth
separating those two things before you rewrite scrolling.

**No gate screens.** A picker between launching and seeing your list is a step
every single time for a choice that changes twice a day. Open into the
last-used context. A home screen that says "all clear" when it has simply
filtered everything out is worse than no screen.

**Fail open on filters.** When we added spaces, items without a space field
were filtered out and every screen went blank — which reads as "the whole
thing is broken" rather than "one field is missing". An item with no space
belongs to whatever you are looking at.

**Spend rows on content, not instruction.** We removed "click open / dbl
back" from every screen. Keep a note only where a screen has a *non-default*
action. The menu went from ten items to five by cutting everything that
duplicated an existing gesture (a "back" item when double-tap is back) or
existed only for the build.

---

## 4. The list model — this is the part you integrate with

### Two spaces, filtered server-side

`ops` (work) and `life` (home). Space is a hard filter applied when the plan
is built, not a client-side view toggle. Leaking work checklists into the Life
running order was a real bug and it made the screen useless at a glance.

### Three row kinds, deliberately not interchangeable

**Task** — a one-off that matters and does not repeat. Call the dentist,
replace a tyre, do the taxes, do something nice for your partner. These lead
the screen in **their own section**, with their own layout and no cumulative
total. They are not things you slot into a spare twenty minutes, and folding
an hour of tyre-fitting into the running total corrupts the number the list
exists to provide.

**Chore step** — one step of a recurring checklist, scheduled by the planner,
carrying both running totals.

**Gap** — a wait. Advances the wall clock, holds the work total.

### `open` means two different things — do not conflate them

For a task, `open` means "inside its time window right now". For a chore step,
`open` means "no earlier step of this chore is in the way". Same word,
different gate. They render differently on purpose (`[!]`/`(!)` versus
`[>]`/`( )`).

### Time windows annotate; they never sort

A task outside its window is still listed, in its normal position, marked with
when it next opens (`9am`, `Thu9a`). We had it sorting actionable-now above
blocked, and the effect was that at 11pm the dentist call sank below
everything — the one row that most needs to stay in your face, demoted for
exactly the twelve hours you are most likely to be looking at the screen.

Filtering by context (work vs home, time of day) is a legitimate future
feature. It is deliberately switched off while the list is being built,
because hiding something is not distinguishable from losing it until you trust
the list.

### Two totals, because there are two questions

```
   7m       7m  [>]  Load dishwasher      7m
   4m      11m  [>]  Load washer         11m
  32m      43m   ~   open Laundry        11m
   4m      47m  ( )  Move to dryer       15m
   8m     2h05  ( )  Put away            38m
```

Column 1 is how long the step takes. Column 2 is **wall clock** — how long you
must be present to reach this step, waits included. Column 4 is **work time** —
how much of that is actually you doing something. Putting the laundry away is
38 minutes of work but 2h05 in the house. "Is this worth starting" and "can I
leave" are different questions and both deserve a column.

### Never invent a number

Items without an estimate are **listed, not scheduled**: `ms: null`, shown as
`--`, appended rather than ordered. Guessing a duration corrupts the running
total, and hiding the item means the awkward jobs quietly disappear — which is
precisely the failure mode the whole app exists to prevent. One task
deliberately carries no estimate because it is a decision before it is a task,
and a made-up number would be a lie.

Durations come from the **median of at least three completed runs**; below
that the configured estimate is the more honest number. Trust is surfaced
(`n=9` versus `est`).

### Chores are checkboxes. Life is not.

The insight that reshaped the model: a one-off task usually cannot be started
until something else is known. *Which* dentist — you have to look it up first.
The tyre is really a three-hour drive plus a day off work, because the
warranty is only good at one shop. A row that can only be ticked is a guilt
generator: it nags without telling you how to start.

So tasks carry **notes**. Clicking a task opens it rather than completing it:
label, estimate, window, notes, and a `Mark done` row at the bottom.

---

## 5. What the AI layer should and should not do

**Write notes, freely.** `POST /task/:id/note` with `{text, by, clientId}`.
The `clientId` makes it idempotent — capture is offline-queued and retried,
and a retry must not produce the same sentence twice. This is the highest-value
integration point: turning "call dentist" into "call dentist — Dr. Rowan on
Market St takes the family plan, 555-0134, open till 5" is the difference
between a nagging row and a doable one.

**Do not invent estimates.** If the model does not know how long something
takes, `null` is the correct answer and the UI is built to display it
honestly.

**Do not reorder by inferred importance.** Weight is declared in config, and
the ordering rules above are deliberate. An agent that helpfully re-ranks the
list breaks the one property the user relies on.

**Respect the offline path.** Every capture surface queues locally first and
POSTs after, with an idempotency key. Assume the network is absent.

**Remember the app is foreground-only.** Nothing you schedule inside it will
fire. Reminders route out through phone notifications.

**Job execution model**: claim-with-lease, idempotency keys, give up after
three attempts. Processing runs on the user's own machine against a
subscription he already pays for — not metered API calls. Design accordingly:
batch, and do not assume you can call out per row.

---

## 6. Process lessons that cost real time

**Measure; do not guess.** The standing instruction on this project became: if
the documentation does not cover it, ask for more documentation rather than
assuming. Every violation of that produced a wasted build cycle.

**Put a version marker in the build and a way to read it on-device.** More
than one "the fix didn't work" turned out to be "the fix was never
installed" — a glob that matched an older archive, a renamed file that broke a
muscle-memory command, an archive rooted one directory off so a patch unpacked
beside the project instead of into it. A diagnostics view showing the build
version settles in five seconds what otherwise costs an hour.

**Keep delivery boring.** Patch archives and full archives must share the same
root so the same extract command works for both. Changing the shape of a
delivery is a change to the user's workflow, and it will silently produce
stale builds.

**Design to the smallest true constraint, not the safest one.** An early
overcorrection capped every line at the width of a line of solid capitals. The
user's response is worth quoting: *"we can't assume I am going to want to use
any of that at all — I would rather use smaller letters or shorthand to make
what I want fit than create a fake limit that bars every line to a number."*
Give the layout the real budget and let the content adapt.

---

## Appendix: the shape of the data

```jsonc
// GET /plan?space=life
{
  "tasks": [{
    "kind": "task", "taskId": "car-tire",
    "label": "Replace car tire", "note": "Wilkes Barre PA",
    "ms": 3600000, "weight": "big",
    "open": false, "opensLabel": "9am",   // window, not gating
    "notes": [{ "id": "...", "text": "...", "by": "mike", "at": 0 }]
  }],
  "agenda": [{
    "kind": "do", "chore": "Laundry", "choreId": "laundry",
    "step": "Move to dryer", "stepId": "move",
    "ms": 240000,
    "open": false,                        // gating, not window
    "cumulativeBusyMs": 900000,           // work
    "cumulativeWallMs": 2820000           // wall clock
  }, {
    "kind": "gap", "ms": 1920000,
    "nextFree": { "chore": "Laundry", "step": "Wash cycle" },
    "cumulativeBusyMs": 660000,           // holds
    "cumulativeWallMs": 2580000           // advances
  }]
}
```

Endpoints an integration will want: `GET /plan?space=`, `GET /tasks`,
`POST /task/:id/note`, `POST /task/:id/done`, `GET|POST /inbox`,
`POST /step/begin`, `POST /step/reset`, and the job queue under `/jobs`.
