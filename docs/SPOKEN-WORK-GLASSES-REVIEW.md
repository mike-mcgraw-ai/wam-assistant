# Spoken Work: review on a nine-line display

**Status:** phase-4 source checkpoint, not a published or installed device build. All examples are synthetic; actual speech, recordings, and task history stay private.

The glasses keep the running order as Home. Capture and Notes show only an active `Review N` count. Entering Review fetches the backlog and presents one card at a time: source and date, title, a useful line, and an uncertainty or audio marker. Scrolling stops at the ends rather than wrapping through a long queue. Opening a card reveals one action at a time, with a phone handoff for richer editing and evidence.

Actions that change state require two clicks. The first arms a specific action on a specific card; the second confirms it. Moving the cursor, backing out, or waiting five seconds disarms it. Merely opening Review never starts the microphone or creates a Home task.

For example, a recording that hears “Clean the cap” stays unchanged. Choosing **Correct** opens deliberate voice capture tied to that review item. A new recording saying “Clean the kitchen” becomes a separate amendment card; the old words and recording remain. The card shows **Was** and **Now** before an armed **Apply words** action. The server applies both card updates in one replayable event only if the full transcript is available and the original revision has not changed. Uncertain or incomplete speech stays in review and directs the wearer to the phone instead of guessing.

The synthetic checks focus on the expensive failure modes: duplicate apply, restart replay, stale original, uncertain words, and accidental legacy task creation. Four new fixtures run through the actual bitmap screens page; each uses at most nine readable lines and has no overflow warning. Hardware behavior, including the phone handoff, remains to be verified before a private build is uploaded.
