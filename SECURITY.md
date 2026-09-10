# Privacy and Security

This portfolio repository must contain synthetic information only.

Please do not submit real conversation audio, transcripts, household tasks,
calendar information, credentials, private server addresses, or packaged
EvenHub builds in issues or pull requests.

Secrets belong in a local `.env` file, which is ignored. The glasses package
must never contain API credentials because installed packages can be inspected.
Runtime state belongs under `server/data/`, which is also ignored.

The public snapshot is generated from an explicit allowlist and scanned for
private paths, identities, network addresses, archives, recordings, and common
credential formats before publication.
