# Screen design kit — Even G2

Everything needed to draft a screen. No SDK, no server, no hardware. Hand this
to an agent, get back an ASCII mockup, wire it up later.

---

## The canvas

```
44 characters wide  x  11 lines tall
```

Hard limits, both of them. Text past line 11 is not scrolled — it is simply not
on the glasses. A line over 44 characters wraps, which costs a whole row and
pushes the bottom off the screen.

- **ASCII only, 32–126.** The firmware silently drops any glyph it lacks, and a
  dropped status marker reads as "fine" — the worst failure this device has.
  No emoji, no box-drawing, no Unicode blocks.
- **Monochrome green.** No colour, no bold, no italic, no font sizes, no
  alignment. One fixed font.
- **~44 is an estimate.** The firmware font may be proportional. Design to 40
  characters for margin.
- Character budget per screen: **900**. Rarely the binding limit; lines are.

---

## Structure

Every screen is the same three parts:

```
line 1      header      what am I looking at, and is anything wrong
line 2      blank
lines 3-9   body        up to 6 rows, one of which carries the cursor
line 10     blank
line 11     footer      what the two gestures do here
```

Six body rows is the working maximum. Need more, page them — but page by
*moving the cursor*, never by jumping a screen at a time.

---

## Input — this is the whole vocabulary

| Gesture | Meaning |
|---|---|
| scroll up / down | move the cursor one row |
| click | open / toggle whatever the cursor is on |
| double-tap | back one level; from the root, exit |
| tap-then-long-press | OS contextual menu (up to 10 items, 20 chars each) |

There is no second axis, no held direction, no text entry. The R1 ring has the
same gestures, not more.

**One cursor per screen, always.** Two independent cursors means the same
gesture doing different things depending on invisible focus — fine at a desk,
useless while walking. If a screen seems to need two, it is two screens.

---

## Established vocabulary

Reuse these. A new symbol for an existing idea is a bug.

**Status**
```
.   ok            !   warning
X   alert         ?   stale, nothing reported in its TTL
```

**Rows**
```
> selected          (leading character, always column 1)
[ ] not done        [x] done         [>] running        (~) waiting on a clock
( ) blocked by an earlier step
+   an action ("Start a list")
=   a destination ("The running order")
*   a shared-list group
[####----]  progress, 8 cells, never full unless complete
```

**Time**
```
0:47    offset from now        11:27a  a clock time
28m     a duration             1h55    a longer duration
32m     a countdown            DUE     a countdown that expired
```

---

## Rules that came from real screens

1. **Worst first.** Sort so the thing needing attention is on line 3, not three
   scrolls down.
2. **Count the things, not the containers.** "2 alerts" beats "1 board with
   alerts" — a board reporting its worst status hides everything under it.
3. **Never blank on failure.** Keep the last good data and mark it: `!NET` when
   a fetch failed, `~CACHE` when it is a cold-start cache.
4. **Show what is missing.** `?` for stale beats a plausible-looking number that
   stopped updating an hour ago.
5. **A finished thing leaves.** Completed daily lists drop off the index. The
   screen is about what is left.
6. **Gaps are content.** "32m open (wash running)" is more useful than a blank
   line.
7. **The footer earns its row.** Two gestures, named. `click open   dbl exit`.

---

## What to produce

An ASCII mockup inside a 44-column frame, one per screen:

```
+--------------------------------------------+
| OPS 14:02  Ops 10 todo  1X 2! 1?           |
|                                            |
| >[###-----] AM Rounds    3/8               |
|  [--------] PM Close     0/5               |
|  +   Start a list                          |
|  =   The running order                     |
|  X HVAC         1 alert, 1 warn, 1 stale   |
|                                            |
| click open   dbl exit                      |
+--------------------------------------------+
```

Plus, in words:
- what each gesture does on this screen
- what the screen shows when the data is empty, stale, or unreachable
- which existing screen it is reached from, and what double-tap returns to

**Do not decide** where the data comes from, how it is fetched, or what the
API looks like. Layout only.

---

## Check a draft

`tools/checkscreen.mjs` validates a mockup against every hard limit:

```bash
node tools/checkscreen.mjs my-screen.txt
```

It reports over-long lines, too many lines, non-ASCII characters, and a missing
cursor. Run it before handing a design back — it catches the three mistakes
that make a screen unusable on real hardware.
