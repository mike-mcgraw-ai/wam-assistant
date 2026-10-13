# A resumable spoken-work migration

The migration design treats old notes, voice sessions, assistant turns, Start
Day links, and recording archives as evidence—not commands to replay. A
read-only inventory joins exact session IDs and persisted client IDs. It shows
source availability, stable review-card identity, and existing destinations
before any write.

In a synthetic fixture, one voice session already had a Captured Note, a Home
task, a committed Start Day link, and audio. The migration created one review
card, kept the available recording, linked the two existing destinations, and
created **zero** new tasks. A retry after restart added no duplicate events.

Apply requires a content-hashed manifest, a verified full backup, an explicit
matching approval hash, and small resumable batches. Source snapshots arrive
before audio is labeled playable; audio is kept and verified before exact
destination links are attached. Source changes stop the run. Uncertain links
remain for human review rather than being guessed from similar wording.

The retention policy is manual purge: reviewed audio stays kept until the
owner explicitly purges it. Purge and legacy-router retirement are separate,
guarded milestones, not side effects of this migration checkpoint. The public
case study contains only synthetic examples and no private manifests or audio.
