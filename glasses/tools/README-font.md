# Measuring the firmware font

The G2 font is proportional. `1` is 7px and `4` is 12px, so a column padded to
a fixed character count lands somewhere different on every row. `src/font.json`
holds the real advance width of every character and `src/metrics.ts` lays out
rows against it in pixels.

Everything below runs on one machine. Nothing here needs the glasses.

## Re-measuring

    npm i -g @evenrealities/evenhub-simulator

    node server/src/index.js &                 # hub, port 8787
    npx vite --port 5173 &                     # serves probe.html
    evenhub-simulator --automation-port 9898 http://127.0.0.1:5173/probe.html &

    python3 tools/measure_font.py > src/font.json

`probe.html` renders whatever string the hub's `/probe` endpoint is holding, so
the script can set a line, screenshot the glasses display through the
simulator's automation API, and read the widths straight off the pixels.

Each character is rendered once and then twenty-one times, both prefixed with a
tall anchor glyph. The difference in rightmost lit pixel, divided by twenty,
is the advance width — side bearings and the anchor all cancel. The anchor
matters: without it a row of apostrophes has ink only along the top and the
scanline grouping loses the row entirely.

## Checking a layout

    node tools/ruler.mjs        # every row's pixel width in the firmware font
    npm run screens             # every screen as compact-bitmap pixels, in a browser tab
    node tools/shot.mjs out.png # what the simulator's display shows now, on black

`ruler.mjs` measures against the firmware font, which is what the native text
fallback uses. Since v0.100.0 the glasses show a bitmap drawn with the WebView's
own sans-serif instead, so for what is actually on your face use the screens
page (`screens.html`, see `docs/SIM-LOOP.md`). `shot.mjs` is the check that the
simulator — the real SDK placing the real containers — agrees with it.

## The one thing these cannot tell you

Absolute size. The simulator and the hardware disagree: a line of 35 `m`
wrapped on real glasses, where these widths say it fits. Relative widths are
what alignment depends on and those do transfer, but the line budget does not
— which is why `USABLE_PX` is 480 rather than 576, set from the hardware
observation rather than the simulator. If a line that fits in the simulator
wraps on the glasses, that constant is what to lower.

The simulator is not a font oracle either: it draws the compact bitmap with
its own WebView's sans-serif (DejaVu Sans on Linux, about 13% wider than
Helvetica or Roboto at 11px), not the phone's.
