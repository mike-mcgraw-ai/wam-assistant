#!/usr/bin/env python3
"""
Measure the G2 firmware font, exactly, with no eyeballing.

Renders each character twice — once, and again repeated N times — in the
simulator, then reads the rightmost lit pixel of each row off the screenshot.
The difference divided by N-1 is the advance width, with the side bearings
cancelling out.

    python3 tools/measure_font.py > src/font.json

Needs: the hub on 8787, vite on 5173 serving probe.html, and the simulator
pointed at it with --automation-port 9898.
"""
import json, sys, time, urllib.request
from PIL import Image

HUB = 'http://127.0.0.1:8787/probe'
SHOT = 'http://127.0.0.1:9898/api/screenshot/glasses'
REPS = 21
LINES_PER_SHOT = 10


def render(lines):
    body = json.dumps({'text': '\n'.join(lines)}).encode()
    req = urllib.request.Request(HUB, data=body, headers={'Content-Type': 'application/json'})
    urllib.request.urlopen(req).read()
    time.sleep(0.75)
    data = urllib.request.urlopen(SHOT, timeout=15).read()
    open('/tmp/_shot.png', 'wb').write(data)
    # The capture is RGBA on a transparent ground. Converting straight to
    # greyscale makes every empty pixel white, which reads as ink on every
    # scanline — composite onto black first so "lit" means "glyph".
    raw = Image.open('/tmp/_shot.png').convert('RGBA')
    black = Image.new('RGBA', raw.size, (0, 0, 0, 255))
    return Image.alpha_composite(black, raw).convert('L')


def row_extents(img, count):
    """Rightmost lit pixel for each of the first `count` text rows."""
    w, h = img.size
    px = img.load()
    lit_rows = [y for y in range(h) if any(px[x, y] > 40 for x in range(w))]
    if not lit_rows:
        return [0] * count

    # Group contiguous lit scanlines into text rows.
    bands, start, prev = [], lit_rows[0], lit_rows[0]
    for y in lit_rows[1:]:
        if y - prev > 2:
            bands.append((start, prev))
            start = y
        prev = y
    bands.append((start, prev))

    out = []
    for i in range(count):
        if i >= len(bands):
            out.append(0)
            continue
        top, bot = bands[i]
        right = 0
        for y in range(top, bot + 1):
            for x in range(w - 1, -1, -1):
                if px[x, y] > 40:
                    right = max(right, x + 1)
                    break
        out.append(right)
    return out


def measure(chars):
    """Advance width per character, in pixels."""
    # Space has no ink, so it is measured between two pipes instead.
    # Every line is prefixed with a tall anchor glyph. Without it, a row of
    # apostrophes has ink only along the top and a row of colons only in the
    # middle, and the scanline grouping either merges those bands into their
    # neighbours or misses them entirely — which is how ':' and 'i' first came
    # back as zero. The anchor is on both lines of a pair, so it cancels.
    A = 'H'
    jobs = [(c, A + c * REPS, A + c) for c in chars]

    widths = {}
    for i in range(0, len(jobs), LINES_PER_SHOT // 2):
        batch = jobs[i:i + LINES_PER_SHOT // 2]
        lines = []
        for _, many, one in batch:
            lines += [many, one]
        img = render(lines)
        ext = row_extents(img, len(lines))
        for k, (c, _, _) in enumerate(batch):
            wide, narrow = ext[2 * k], ext[2 * k + 1]
            if wide == 0:
                continue
            widths[c] = round((wide - narrow) / (REPS - 1), 2)
        print(f'  {"".join(c for c, _, _ in batch)!r}', file=sys.stderr)
    return widths


CHARS = (
    '0123456789'
    'abcdefghijklmnopqrstuvwxyz'
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    ' .,:;\'|!-()[]/~><+=*#?%'
)

if __name__ == '__main__':
    result = measure(CHARS)
    print(json.dumps(result, indent=1, sort_keys=True))
