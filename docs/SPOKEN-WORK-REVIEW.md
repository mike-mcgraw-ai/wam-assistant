# Review Spoken Work: from recordings to deliberate action

**Status:** source checkpoint under development, not a published device build. All examples here are synthetic. The public export contains no real audio, transcripts, tasks, or runtime data.

## The problem

A spoken note could leave evidence in several places: a live session, an archived recording, a note, or an already-created task. Treating each place as a separate inbox item would duplicate work. Treating a two-second speech-to-text chunk as the final transcript could also turn a misheard word into a task.

The review layer makes one source-backed card discoverable without putting the entire backlog on the daily Home list. It shows the original evidence, a corrected working copy, audio availability, and any destination already linked to the source. Suggested work does not create a task; a person confirms that step.

## The phased design

1. **Read-only foundation.** Inventory old notes, sessions, and recordings by exact source IDs. Present a phone list and detail view without changing the old stores. Keep an append-only event log and rebuildable index ready for canonical records.
2. **Review and capture.** Archive one transcription of the complete recording after queued live chunks finish. Preserve those chunks as raw evidence. Corrections, classification, Ignore/Restore, and explicit task decisions use item revisions and command IDs. The phone can search past cards and retain an unsynced correction locally for retry. A first edit materializes an old preview into the canonical log; simply browsing does not.
3. **Multiple intents.** Split one card into child review cards by assigning each raw chunk exactly once. Merge two cards with one log event that changes both projections together. Original sources remain reachable, and a merge reopens the retained card for review.

For example, a synthetic recording says, “Replace the hallway bulb, and sketch an energy dashboard.” It can remain one mixed card, or become a bounded task and a separate idea. Neither destination is created by the split itself.

## Why the failure boundaries matter

- **Partial task write:** the review log records a pending promotion first. The task store uses a stable client ID, so retrying after an interruption finds the same task instead of creating a second row.
- **Existing task:** the phone offers an explicit link to an open task. It does not guess that similar wording means the same work.
- **Concurrent edits:** `If-Match` rejects a stale revision. The phone keeps the local fields visible and shows the saved revision for comparison.
- **Transcript disagreement:** the complete-recording pass is saved separately from live chunks. Review can use the better full context while the original chunk output remains inspectable.
- **Split/merge interruption:** each multi-card change is one append-only event, so replay sees all affected cards or none of them.

Focused tests use invented sources to check overlap deduplication, correction without raw-text loss, retry after a partial promotion, and deterministic split/merge replay. Isolated HTTP checks exercise capture and review without touching personal runtime data. This is intentionally a small set of tests around data-loss and duplication risks, not a test for every possible phrase.

## Next boundaries

Rules-first extraction with model fallback, project/idea/memory destinations, glasses review, and backed-up legacy migration are separate checkpoints. No public portfolio milestone should claim them until their source and synthetic evidence are ready.
