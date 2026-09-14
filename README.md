# WAM Assistant

> Historical milestone `v0.5.0`, based on face build `0.68.0`. Originally completed 2026-09-14; sanitized and published 2026-09-29. See [MILESTONE.md](MILESTONE.md) for this checkpoint.

A portable, privacy-first conversation assistant with an Even G2 smart-glasses
client. WAM keeps the thread of a real conversation visible without demanding
the user's full attention: live speech becomes readable paragraphs, a running
conversation compass preserves the main thread, and brief cues can surface a
useful answer, fact-check, follow-up, or recap.

This repository is a sanitized portfolio edition. It contains synthetic
configuration and fixtures only. It does not contain personal conversations,
recordings, tasks, credentials, private server addresses, packaged apps, or the
private repository's Git objects.

WAM progressed through more than 100 documented on-device iterations. This
public history distills that work into 16 runnable milestones so the important
product and engineering turns remain reviewable without presenting every
diagnostic or one-line hardware build as a separate release.

## What it demonstrates

- A 576 x 288 heads-up display designed for fast glance reading
- Local speech-to-text with an optional cloud fallback
- Thought-level transcript coalescing instead of treating audio chunks as sentences
- Running topics, recent points, summaries, and conversational recovery
- A phone control surface for modes, notes, and testing
- Pixel-measured layout for the glasses' proportional firmware font
- Four-panel redraw experiments balancing latency, flicker, and readability
- Idempotent capture, local persistence, retry-safe jobs, and privacy boundaries
- Simulator tooling, screen checks, tests, and guarded device releases

## Architecture

```text
glasses microphone and controls
            |
            v
phone WebView / Even SDK
            |
            v
local hub --> speech-to-text --> transcript and summaries
    |                                  |
    +--> durable notes and lists       +--> AI cue job
                                               |
                                               v
                                      local desktop model
                                               |
                                               v
                                  compact glasses HUD response
```

The hub stores state and queues bounded jobs. Speech and model processing can
run locally on the user's computer, keeping ordinary conversation audio away
from a hosted service. Cloud speech is an explicit opt-in fallback.

## Portability

The transcript, memory, summary, note, job, and cue layers do not depend on the
Even display. `glasses/` is the current device adapter: another wearable,
desktop overlay, phone client, or accessibility display can consume the same
hub APIs with its own renderer and controls. A new client mainly needs to map
its microphone and input events to the existing session endpoints and render
the returned transcript board and cues.

## Repository layout

- `glasses/`: Even G2 app, renderers, input handling, and simulator tools
- `server/`: local hub, transcript processing, notes, lists, and tests
- `agents/`: local model runner for AI cues and assistant turns
- `DEVLOG.md`: capability milestones and the design lessons behind them
- `BUILD_HISTORY.md`: the complete documented device-build ledger
- `SANITIZATION.md`: source commit and export boundary for this snapshot

## Try the software path

The portfolio snapshot intentionally does not include a production package or
private deployment configuration.

```bash
npm --prefix server install
npm --prefix glasses install
npm test
npm run demo
```

Start the local hub with `npm --prefix server start`. Hardware packaging needs
the EvenHub SDK and a package identity registered by the developer.

## Development disclosure

Development is AI-assisted. Mike owns the problem definition, product scope,
system design, interaction decisions, integration, field testing on the
hardware, debugging evidence, privacy choices, and release decisions. Claude
and Codex have been used as implementation collaborators. That collaboration is
documented because coordinating multiple agents safely became part of the
engineering work.
