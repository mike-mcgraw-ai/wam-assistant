# Device Build History

WAM used rapid numbered device builds for hardware testing. These entries are documented engineering iterations, not all public releases; some were diagnostic, folded into a later package, or replaced after testing on the glasses. The 27 tags in [DEVLOG.md](DEVLOG.md) are the runnable portfolio checkpoints.

| Face build | Attribution / status | Change |
|---|---|---|
| v0.17.0 | Claude | Last version before the task work. Image clock removed. |
| v0.18.0 | Claude | One-off tasks added and rendered on the glasses. |
| v0.19.0 | Claude | Big-ticket tasks split into their own section above the running order, with their own row shape and no cumulative total. |
| v0.20.0 | Claude | Life became one continuous page; Lists moved to the long-press menu. |
| v0.21.0 | Claude | Fixed /plan never filtering by space — work checklists were appearing at the bottom of the Life running order. Added the wall-clock column and dropped the chore-name column to make room. Added task notes: clicking a task opens it rather than completing it, plus a /notes capture page on the phone. |
| v0.22.0 | Claude | OPS/LIFE moved onto its own row under the clock. Gap rows now carry both totals, so waits appear in the wall-clock column. All numeric columns right-aligned. |
| v0.23.0 | Claude | Removed the blank line under the space label; indented OPS/LIFE three spaces. |
| v0.24.0 | Claude | Menu reordered so navigation leads. |
| v0.25.0 | Claude | Cut the menu from ten items to five. Start-a-list moved back onto the Lists screen. |
| v0.26.0 | Claude | Removed Exit from the contextual menu (double-tap from root still exits). |
| v0.27.0 | Claude | Moved row layout from character padding to pixel offsets (metrics.ts, layout()). Final column now lands within 5px across every row, against 56px of drift before. |
| v0.28.0 | Claude | Replaced estimated font widths with measured ones. Built the measurement harness: tools/measure_font.py renders each character once and 21 times in the Even simulator and reads the advance width off the pixels. Added src/font.json, tools/ruler.mjs, tools/shot.mjs, probe.html, and a dev-only /probe endpoint. Key finding: 1 is 7px against 12px for other digits, and spaces do not collapse. |
| v0.28.1 | Claude | Repackaged so patch archives share a root with full archives and one extract command works for both. No code change. |
| v0.28.2 | Claude | Renamed the app from GoldFish to WAM everywhere — 8 on-screen strings plus app.json name. package_id deliberately unchanged. Added npm run pack:private. |
| v0.28.3 | Claude | Fixed pack-private.mjs never passing VITE_HUB_URL into the build. The whitelist said the tailnet origin was allowed while the bundle still asked for localhost:8787, so the app installed cleanly and every screen said "No data". Verified by grepping the built bundle for the tailnet host: 0 before, 1 after. |
| v0.30.0 | Codex | Re-landed the Coach/AI cue layer on top of the v0.28.3 pixel-layout baseline. The hub now serves GET /ai/cue?space=ops, built only from existing checklist, task, inbox, board, wait, and job state. The glasses show automatic cues as a single Ops dashboard row and keep the Life running order untouched. Added a manual Coach menu screen for reading the full cue. Pack through npm run ship. |
| v0.31.0 | Codex | Added the Iris-style Coach mode and listening substrate. The hub now has editable Coach modes (Conversation, Listening, Meeting), a phone control page at /coach, active listening sessions, transcript segment capture, and a coach.cue job handoff for the Mac agent. /ai/cue now blends hard WAM reminders with active conversation cues and recaps, without blocking on the model. The glasses menu adds Listen, which explicitly starts/stops a Coach session and opens the cue screen. |
| v0.32.0 | Claude | Merged the two patches that never landed (0.28.4, 0.28.5) onto Codex's 0.31.0. Nothing of the Coach layer was changed or removed. |
| v0.33.0 | Codex | Made Listen capture real glasses microphone audio instead of only starting an empty Coach session. The glasses now open the documented Even AudioInputSource.Glasses stream after startup-page creation, buffer short PCM chunks, skip quiet chunks, and send speech to POST /coach/session/:id/audio. The hub wraps PCM as WAV, transcribes with Deepgram by default (DEEPGRAM_API_KEY, STT_MODEL=nova-3), stores the resulting transcript line on the active Coach session, and queues a coach.cue job so recaps/questions can surface mid-conversation. The Deepgram key stays on the hub and is never packed into the glasses app. |
| v0.34.0 | Claude | Transcription now runs locally by default. Added a local provider to stt.js that shells out to whisper.cpp (STT_LOCAL_BIN, STT_LOCAL_MODEL), and made it the default STT_PROVIDER. Deepgram and Groq stay as opt-in fallbacks. The reason is the wearer's, stated twice: processing belongs on his Mac against a subscription he already pays for rather than a metered API, and conversation audio should not leave the house. The wav is written to a private temp dir and removed in a finally, including on timeout — leaving recordings of someone's conversations in /tmp is not an acceptable failure mode. |
| v0.35.0 | Claude | Audio no longer blocks the glasses. POST /coach/session/:id/audio awaited the transcription before replying — tolerable against a cloud API, not against local whisper. Every chunk froze the app for as long as the model took, which is why Listen opened once and then sat unresponsive on an empty cue screen. It now returns 202 immediately and transcribes on a queue of one behind it (whisper is CPU-bound; parallel chunks would only make each slower). A backlog over 8 drops its oldest rather than falling further behind for the rest of a conversation. |
| v0.36.0 | Claude | A microphone indicator. MIC on the space line when a chunk of real speech went up in the last few seconds, MIC. when listening but hearing nothing. ASCII so the firmware cannot drop it silently. Previously Listen looked identical whether the mic was working or dead, which is how it felt. |
| v0.37.0 | Claude | Ticking a step started the wrong clock. Completing "Move to dryer" began the wash cycle — a 32 minute wait for something already done — because the next step was chosen as "first unfinished in the list" and the wash was earlier and never checked. It now starts the next unfinished step after the one just completed. People work a list out of order; the clock has to follow where they actually are, or it records waits that never happened and poisons the median. |
| v0.38.0 | Claude | Nothing auto-starts. Ever. Completing a step no longer begins the next one's clock. Every guess at "which step is next" is wrong when you work a list out of order, and the wrong guess records a wait that never happened. A timer starts when he clicks that step, and at no other time. With the ring this is the whole interaction: click the step you are starting. |
| v0.39.0 | Claude | Start a step from the running order. Clicking a step row used to open its chore so you could click the same step again — navigation for its own sake. The row you can see is now the row you click: first click starts the clock, second completes it, same rule as everywhere else. The run is created on demand, so there is no separate "begin this chore" step to forget. Nothing else starts. |
| v0.40.0 | Claude | Completed steps now drop out of the running order and their time comes off every total below them. The planner tracked progress with a single cursor into each checklist and scheduled everything after it — which assumed you work top to bottom. the wearer works out of order by design, so a step finished early stayed in the list and kept adding its minutes to the totals. Steps are now excluded individually by what is actually done, so the second column always means "time still left from here", whatever order things got done in. Step numbering keeps its original position, so a laundry step is still "3 of 6" after you have done two others. |
| v0.41.0 | Claude | Completed steps stay on the page. 0.40.0 took their time off the totals and also made them vanish, which lost two things: an accidental click became unundoable, and a list that only ever shrinks is no evidence you did anything. Done steps now sit at the bottom of the running order as [x], showing how long each actually took and when it finished, and clicking one puts it back — the only undo available from the glasses. They still contribute nothing to the totals, and they clear after sixteen hours, so yesterday's dishes are history rather than progress. |
| v0.42.0 | Claude | The blank separator became a door. The gap between the big-ticket tasks and the running order is now a centred, selectable Chores header. Clicking it opens every chore whole — each list with its steps under a name and a done count — rather than the interleaved running order. Two different questions: the running order answers "what fits in the time I have", this answers "what is actually on my plate", and the second was only reachable by opening chores one at a time. |
| v0.43.0 | Claude | Done steps stay inline. 0.41.0 parked them at the bottom, which made undoing a misclick a long scroll away and put the step back somewhere unrelated to where it sat in its chore. A finished step now sits immediately before the first remaining step of the same chore, so the list still reads as that chore's sequence. Its time still comes out of the totals; only the second column ignores it. |
| v0.44.0 | Claude | Chores is a drill-down again. 0.42.0 made it a flat block of every chore and every step, which is a long list you have to page through to find anything. It is now one row per chore with the progress bar — [####----] Vacuum 1/3 — and clicking one opens that chore's steps. Chores not yet started appear at 0 and begin when you open them. |
| v0.45.0 | Claude | A marker key and a click hint on the running order. The key sits directly under the Chores rule, where the eye has already stopped: [>]ready ( )later []going [x]done. The hint sits at the bottom: click starts / click again done. |
| v0.46.0 | Claude | Finished chores stay on the Chores list. Ticking the last step made a chore vanish, taking its own evidence with it and leaving no way to start it again — which for laundry is a daily problem, not an edge case. A complete chore now shows a full bar and how long ago it finished: [########] Laundry 6/6 2h ago. |
| v0.47.0 | Claude | The bottom line now describes what the cursor is on. It replaced a fixed hint that said the same thing everywhere and an ... overflow marker that said nothing at all — the last row of a nine-row screen is too expensive for either. It carries the row's state and what a click will do: done 12m ago - click to undo, running 4m - click to finish, earlier step first, click to start, waiting - nothing to start here, click for all chores. Same inside a chore's steps, including the live countdown on an armed wait. |
| v0.48.0 | Claude | The rule, the key and the tip are one row. They were three rows out of nine. The Chores divider now carries the description of whatever the cursor is on, set into the middle of the dashes and written as a key entry — so the marker and its meaning arrive together rather than needing a legend to decode: |
| v0.49.0 | Claude | The tip follows you onto later pages. The Chores rule carries it, but the rule scrolls off once you page past it. On those pages the tip drops to the bottom row instead — same text, so there is nothing new to learn, and no page pays for it twice. |
| v0.50.0 | Claude | Life is the default space. It opened on Ops when nothing was stored, which was backwards — the running order is the screen this exists for and the one you want on your face without thinking about it. A stored preference still wins, so switching to Ops sticks. |
| v0.51.0 | Claude | The Coach screen shows the audio path instead of just a line count. A listening session that produces nothing had six places it could fail and looked identical at all of them. It now reports each stage: |
| v0.52.0 | Claude | The Coach screen never showed the status I added in 0.51.0. It lived in the no-cue branch, and starting Listen always sets a cue — so the one screen meant to show whether the microphone is working was the one screen that could not. The status block now renders first and unconditionally while a session is live, above the cue and the transcript. |
| v0.53.0 | Claude | PCM is decoded from whatever shape the host actually sends. The code assumed audioPcm was always a Uint8Array. The SDK is explicit that it arrives as a Uint8Array, a plain number[], or a base64 string depending on the host — and a string passes the .length check, survives .slice(), gets pushed into a byte buffer and then reads as nonsense PCM. The result is an RMS near zero, so every chunk is discarded as silence: a live microphone that looks permanently quiet, with no error anywhere. Exactly the failure being seen. |
| v0.54.0 | Claude | Count audio events before any of our own gating. frames was counted after two checks — audioOpen and audioSessionId — so a zero told you nothing about whether the host was delivering audio at all. raw counts every audioEvent the moment it arrives. If raw stays at zero the glasses are not sending audio and nothing downstream matters; if raw climbs while frames does not, our code is discarding it. |
| v0.55.0 | Claude | Restored the frame copy that 0.53.0 dropped — this is why the microphone stopped working. The original code pushed frame.slice(); rewriting the decode in 0.53.0 I returned the frame itself for the Uint8Array case. If the host reuses one buffer per frame, every frame in a chunk then points at the same memory, so the assembled PCM is the last frame repeated. That reads as noise and then, once RMS is computed, as silence — the exact symptom, and it arrived with my change rather than with Codex's working version. |
| v0.56.0 | Claude | Read the PCM carrier-agnostically, and say what the payload actually contains. raw climbing while frames stays at zero means the host is delivering audio and we are discarding it. event.audioEvent is whatever the host serialised rather than an AudioEvent instance, so the bytes may not be under audioPcm at all — the same trap as taps arriving on sysEvent instead of textEvent, where the type says one thing and the wire says another and the failure is silent. |
| v0.57.0 | Claude | no session id — the local copy of the session drifted from the real one. stopAudioCapture clears audioSessionId and then awaits; a start landing in that window left the microphone open with no id to post against, so every frame was dropped while audio kept arriving. The live state.coachSession is now the source of truth and the local variable is only a cache. |
| v0.58.0 | Claude | Server-side transcriber stats on the Coach screen. The glasses could prove audio left the building — sent 7, rms 5488, pcm u8 — and then the trail went cold. /state now reports what the hub did with it: ok, empty, failed, how long the last inference took, the last error, and whether a provider is configured at all. Shown under the audio counters. |
| v0.59.0 | Claude | Mirror the glasses display to any browser on the network. The hub cannot know what the panel shows — rendering happens in the app — so paint() now posts each frame to POST /screen and GET /mirror serves a page that draws it: 576x288 aspect, green on black, scaled to fit whatever it is opened on. One renderer, so the mirror can never disagree with the glasses. |
| v0.60.0 | Claude | Lists opens the Chores drill-down in Life. It still went to the old index — the screen with "Start a list" and "The running order" on it, rows that either duplicate the running order or lead straight back to it. That index was replaced by the Chores view in 0.44.0 and the menu item never followed. In Ops the index is the home screen, so there it is unchanged. |
| v0.61.0 | Claude | Listen stops starting itself, and the transcript actually updates. |
| v0.62.0 | Claude | Ops sidelined. The app is Life, capture, and notes. |
| v0.63.0 | Codex | Listen is tuned for faster phrase-level transcript updates. |
| v0.64.0 | Claude | Double-tap at the top puts the display to sleep, like the stock dashboard. |
| v0.65.0 | Codex | Listen gives the transcript more room. |
| v0.66.0 | Claude | Start talking from the thing you are talking about. |
| v0.67.0 | Codex | Listen transcript reads as paragraphs instead of raw STT chunks. |
| v0.68.0 | Codex | Listen keeps a live running note so the conversation thread is easier to recover mid-stream. |
| v0.69.0 | Claude | Merge check across Codex 0.65–0.68, plus one bug that fell between us. |
| v0.70.0 | Claude | The running order uses all nine lines, and page two stops repeating a row. |
| v0.70.1 | Claude | The reason none of this reached the glasses. |
| v0.71.0 | Claude | Pages stop lying about what you can select; diagnostics becomes line numbers. |
| v0.71.1 | Claude | The Listen screen shows the transcript again. |
| v0.72.0 | Codex | Listen now keeps a conversation compass instead of merely shortening the latest transcript. |
| v0.73.0 | Codex | One Listen session now becomes one useful note instead of one note per STT chunk. |
| v0.74.0 | Codex + Claude | Listen is transcript-first, saved notes are removable from the Ring, and a Morning checklist handles simple one-click routines. |
| v0.75.0 | Codex | The active Coach experience follows the Life-only scope without deleting Ops. |
| v0.76.0 | Codex | Life keeps the existing Coach modes and raw-file opens reach the live page. |
| v0.77.0 | Codex (folded into v0.78.0; not shipped) | This was the early claim for the note drill-down. Claude and Codex were editing the same glasses files, so the completed work shipped together as v0.78.0 instead of creating two indistinguishable intermediate packages. |
| v0.78.0 | Claude + Codex | Required-today on the running order, a four-item menu, sleep from anywhere, and one consistent note drill-down. |
| v0.79.0 | Claude | Ticking a daily step is two clicks and leaves a mark; LIFE opens a small menu. |
| v0.80.0 | Codex | Listen exposes the saved Coach modes before recording begins. |
| v0.81.0 | Claude | "Captured notes" is off the running order. |
| v0.82.0 | Codex | Every stopped Listen entry opens the mode picker before recording. |
| v0.83.0 | Codex | The three Listen choices start recording immediately. |
| v0.84.0 | Codex | Glasses chat bridge for voice turns with ChatGPT and Claude. |
| v0.85.0 | Codex | Whole-utterance transcript routing and readable live speech. |
| v0.86.0 | Codex | Make the listening Coach AI runnable and safe to test. |
| v0.87.0 | Codex | Make Listen show and save the AI understanding instead of raw chunk artifacts. |
| v0.88.0 | Claude | ./check.sh — which link in the chain is actually down. |
| v0.89.0 | Claude | Readable Listen notes without a model, and the Coach worker runs on Claude. |
| v0.89.1 | Claude | ./restart.sh and ./agents/install-coach.sh — the two commands that kept failing silently. |
| v0.89.2 | Claude | The Coach worker can hold a credential without committing one. |
| v0.89.3 | Claude | The Coach worker starts with the hub. A LaunchAgent cannot work from here. |
| v0.90.0 | Codex | Final Listen summaries survive Stop and appear on an already-open Notes screen. |
| v0.91.0 | Codex + Claude | Make the AI's live state visible and recover the Life plan after a temporary phone-to-hub connection failure, with readable Notes rows. |
| v0.92.0 | Claude | rehearse.mjs — run a whole Listen session from a text file. |
| v0.93.0 | Codex | Make Listen start arm-then-confirm instead of recording on the first click. |
| v0.94.0 | Codex | Add a Tailscale-friendly phone download path for private app packages. |
| v0.95.0 | Codex | Add a review/cancel step after voice recording stops, so bad transcripts can be discarded from the glasses before they are saved or sent. |
| v0.96.0 | Codex | Prevent general Listen notes from silently attaching to whatever row happened to be selected. |
| v0.97.0 | Codex | Make the Chat picker and chat screens show clear ready/working state so long ChatGPT or Claude turns do not look frozen. |
| v0.98.0 | Codex | Make ChatGPT and Claude screens show useful work state instead of generic ready/thinking copy during long turns. |
| v0.99.0 | Codex | Make Listen preserve the conversation thread while showing far less transcript noise on the glasses. |
| v0.100.0 | Codex | Make the complete glasses HUD smaller and visually farther away. |
| v0.101.0 | Codex | Make the compact HUD clearer while fitting more useful text on the glasses. |
| v0.102.0 | Codex | Make compact text unambiguous at conversation-speed glances. |
| v0.103.0 | Claude (shipped inside v0.108.0) | Listen across the whole panel: four 288x144 image tiles instead of two centred bands. |
| v0.104.0 | Claude (claimed; not packed) | Drive the glasses from the keyboard on the hub's /mirror page. |
| v0.105.0 | Codex (claimed; QR-testing, not packed) | Make the Listen page's Topics and Summary tiles start predictably and use their available height instead of showing short, intermittent fragments. |
| v0.106.0 | Codex (claimed; QR-testing, not packed) | Reduce the visible one-tile-at-a-time redraw when a Listen frame changes two to four image containers. |
| v0.107.0 | Codex (claimed; QR-testing, not packed) | Use a hybrid dashboard display so routine Life navigation does not repaint the entire four-tile panel. |
| v0.108.0 | Codex (claimed; ready for EvenHub package) | Turn the right-side rail into a real dashboard and make wake/control behavior reliable. |
| v0.109.0 | Codex (claimed; ready for EvenHub package) | Require an intentional double-click to wake WAM. |
| v0.110.0 | Codex (claimed; ready for EvenHub package) | Make the timer dashboard dense enough to be useful at a glance. |
| v0.111.0 | Claude (ready for EvenHub package or QR) | Main screen: stop the four-tile 1-2-3-4 rollout on every screen change. |
| v0.112.0 | Codex (ready for EvenHub package) | Put every live timer on one true two-column grid. |
| v0.113.0 | Claude (ready for EvenHub package) | Confirm gate on running-order chore steps; a paint log to pin down the tile-by-tile rollout. |
| v0.114.0 | Codex (ready for EvenHub package) | Make live speech repaint the transcript first without churning Topics. |
| v0.115.0 | Codex (ready for EvenHub package) | Preserve useful speech when Back leaves an active Listen recording. |
| v0.116.0 | Codex (ready for EvenHub package) | Add an emergency hidden-menu reset for accidental running timers. |
| v0.117.0 | Claude (ready for EvenHub package) | Instant scrolling on ordinary screens: the cursor moves in native text, the list stays a picture. |
| v0.118.0 | Codex (ready for EvenHub package) | Make Chat own all four glass tiles instead of sharing the ordinary list-and-clock dashboard. |
| v0.119.0 | Codex (ready for EvenHub package) | Make the open Chat screen a transcript-first native text reader again, so scrolling does not repaint image quadrants or leave ghost rows. |
| v0.120.0 | Claude (ready for EvenHub package) | Ring-proof confirm gate. With the ring on a finger, bumps arrived as taps: two in a row armed and confirmed, and further bumps carried on into whatever row the cursor landed on. |
| v0.121.0 | Codex (not packed; superseded by v0.122.0) | Split the active Chat screen into a left transcript column and a right work state column. |
| v0.122.0 | Codex (ready for EvenHub package) | Stop Chat navigation and reply polling from saturating the glasses image transport. |
| v0.123.0 | Codex (ready for EvenHub package) | Put Chat beside Listen and Notes in the Capture screen. |
| v0.124.0 | Claude (ready for EvenHub package) | Faster startup: the first frame is the real running order, not a placeholder. |
| v0.125.0 | Claude | Make a failed Claude turn explain itself, and give the Chat path a real test. |
| v0.126.0 | Codex (not packed; superseded by v0.127.0) | Revert the open Chat screen to the stable transcript reader from before the four-panel Chat experiments, while keeping newer job/status fixes. |
| v0.127.0 | Codex (ready for EvenHub package) | Hard rollback of the broken tiled Home and Chat experience. |
| v0.128.0 | Codex (ready for EvenHub package) | Run ChatGPT and Claude independently and let Notes feed either provider's idle queue. |
| v0.129.0 | Claude (ready for EvenHub package) | Every screen except live Listen is native text again; the time/date dashboard rail is gone; every screen starts with the date / time / version line. |
| v0.130.0 | Codex (ready for EvenHub package) | Turn the Life home screen into a voice-built daily plan. |
| v0.131.0 | Codex (ready for EvenHub package) | Add the first morning-briefing shape to the pre-Start-Day Life Home screen. |
| v0.132.0 | Codex (ready for EvenHub package) | Add a dedicated solo dictation mode for coding thoughts, plans, and personal notes without conversation coaching. |
| v0.133.0 | Codex (ready for EvenHub package) | Build the first functional morning brief contract and all-source glasses readout. |
| v0.134.0 | Codex (ready for EvenHub package) | Retain original Listen audio and its exact STT output long enough to audit transcripts and preserve selected moments. |
| v0.135.0 | Codex (ready for EvenHub package) | Add the first live morning brief source: basic weather. |
| v0.136.0 | Codex (ready for EvenHub package) | Keep basic morning brief values visible while real source adapters are still coming online. |
| v0.137.0 | Claude (ready for EvenHub package) | Life game v1: XP, levels, penalties and streaks, scored by fixed rules from the checklist history. No AI anywhere in the scoring (the wearer's standing rule: hard-code it, AI only when asked). |
| v0.138.0 | Codex (ready for EvenHub package) | Make the morning brief more useful at a glance. |
| v0.139.0 | Codex, finished and shipped by Claude (ready for EvenHub package) | Compress the pre-Start-Day source brief into a one-glance strip. |
| v0.140.0 | Codex, finished by Claude (ready for EvenHub package) | Start Day becomes the day's commitment: optional, additive all day, and what you name stays on the list and costs points until it is done. |
| v0.141.0 | Claude (ready for EvenHub package) | Life Home before Start Day, as the wearer asked (2026-10-13). |
| v0.142.0 | Claude (server only; no EvenHub package) | the wearer's main ledger number is on the glasses, and eating out now scores in the life game. |
| v0.143.0 | Codex (ready for EvenHub package) | Show Start Day tasks on Home and give completed rows two page-away undo chances. |
| v0.144.0 | Codex (ready for EvenHub package) | Remove the stray Start Day task rows from Home. |
| v0.145.0 | Codex (ready for EvenHub package) | Stop Start Day from turning correction fragments into extra tasks. |
| v0.146.0 | Codex (ready for EvenHub package) | Restore cleaned Start Day tasks to Home. |
| v0.147.0 | Codex (ready for EvenHub package) | Keep a completed partial Start Day routine from rebuilding itself. |
