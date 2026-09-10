# Device Build History

WAM used rapid numbered device builds for hardware testing. These entries are documented engineering iterations, not all public releases; some were diagnostic, folded into a later package, or replaced after testing on the glasses. The 16 tags in [DEVLOG.md](DEVLOG.md) are the runnable portfolio checkpoints.

| Face build | Attribution / status | Change |
|---|---|---|
| v0.17.0 | Claude | Last version before the task work. Image clock removed. |
| v0.18.0 | Claude | One-off tasks added and rendered on the glasses. |
| v0.19.0 | Claude | Big-ticket tasks split into their own section above the running order, with their own row shape and no cumulative total. |
| v0.20.0 | Claude | Life became one continuous page; Lists moved to the long-press menu. |
| v0.21.0 | Claude | Fixed /plan never filtering by space — work checklists were appearing at the bottom of the Life running order. Added the wall-clock column and dropped the chore-name column to make room. Added task notes: clicking a task opens it rather than completing it, plus a /notes capture page on the phone. - Server restart: yes |
| v0.22.0 | Claude | OPS/LIFE moved onto its own row under the clock. Gap rows now carry both totals, so waits appear in the wall-clock column. All numeric columns right-aligned. |
| v0.23.0 | Claude | Removed the blank line under the space label; indented OPS/LIFE three spaces. |
| v0.24.0 | Claude | Menu reordered so navigation leads. |
| v0.25.0 | Claude | Cut the menu from ten items to five. Start-a-list moved back onto the Lists screen. |
| v0.26.0 | Claude | Removed Exit from the contextual menu (double-tap from root still exits). |
| v0.27.0 | Claude | Moved row layout from character padding to pixel offsets (metrics.ts, layout()). Final column now lands within 5px across every row, against 56px of drift before. |
| v0.28.0 | Claude | Replaced estimated font widths with measured ones. Built the measurement harness: tools/measure_font.py renders each character once and 21 times in the Even simulator and reads the advance width off the pixels. Added src/font.json, tools/ruler.mjs, tools/shot.mjs, probe.html, and a dev-only /probe endpoint. Key finding: 1 is 7px against 12px for other digits, and spaces do not collapse. - Server restart: yes (/probe endpoint) |
| v0.28.1 | Claude | Repackaged so patch archives share a root with full archives and one extract command works for both. No code change. |
| v0.28.2 | Claude | Renamed the app from GoldFish to WAM everywhere — 8 on-screen strings plus app.json name. package_id deliberately unchanged. Added npm run pack:private. - Files: glasses/src/render.ts, app.json, package.json, tools/pack-private.mjs, docs - Server restart: no |
| v0.28.3 | Claude | Fixed pack-private.mjs never passing VITE_HUB_URL into the build. The whitelist said the tailnet origin was allowed while the bundle still asked for localhost:8787, so the app installed cleanly and every screen said "No data". Verified by grepping the built bundle for the tailnet host: 0 before, 1 after. - Files: glasses/tools/pack-private.mjs, app.json - Server restart: no |
