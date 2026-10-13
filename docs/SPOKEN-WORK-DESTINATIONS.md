# Spoken Work: proposals and explicit destinations

**Status:** phase-3 source checkpoint, not a published or installed device build. Every example is synthetic; runtime speech, recordings, tasks, and credentials stay private.

## The boundary

Recognizing an intent is not the same as acting on it. A complete recording can describe a task, a multi-step project, an idea, or a moment worth keeping. The review layer proposes that meaning, then waits for a person to choose a destination. A project or idea never appears as an invented Home checkbox.

For example, “Sketch an energy dashboard, then check which sensors exist” can yield an idea with a possible first step. It does not create a task until someone deliberately confirms one.

## Rules first, model second

An editable rules file contains only human-approved patterns. A matching rule creates a proposal without a model call or destination write. If no rule matches, one desktop-agent job reads the complete transcript, not each live audio chunk. Its proposal must cite supporting words; candidates without a matching excerpt are dropped. A missing agent leaves the card visible with its original words and a retry path.

Every proposal is tied to a transcript revision. A correction or later full transcript makes an older model result stale. Human-edited fields remain authoritative even when a delayed proposal arrives. The review event history keeps the proposal and subsequent choices available for identifying patterns that may deserve a future approved rule.

## Durable destinations

- **Project:** a goal, only source-backed candidate steps, open questions, and any task that launched a voice plan.
- **Idea:** a topic, rationale, and optional source-backed next step; no Home task is implied.
- **Memory:** a transcript excerpt and an audio reference only after the recording is confirmed kept. If audio is gone, the record says transcript-only.
- **Start Day:** each recording links to the exact draft items it contributed. Confirmation records created or reused task IDs against those sources, without replaying the draft as a second action.

Destination records and their source links are persisted with the review event log. After a person corrects the source card, the phone shows a before/after preview. Updating a linked task adds a deliberate context note; it never silently renames that task. Updating a project, idea, or memory requires a separate confirmation.

## Checks that matter

Synthetic tests cover an approved rule bypassing the model, an unsupported model citation being discarded, a correction invalidating an in-flight proposal, project/idea replay without task creation, verified versus missing memory audio, reused Start Day items across two recordings, and an explicit destination update after preview. These checks target lost sources, unintended actions, and duplicate writes rather than exhaustive phrase permutations.

Glasses review and backed-up legacy migration remain later checkpoints. This source is prepared for a sanitized portfolio export, not represented as a hardware release.
