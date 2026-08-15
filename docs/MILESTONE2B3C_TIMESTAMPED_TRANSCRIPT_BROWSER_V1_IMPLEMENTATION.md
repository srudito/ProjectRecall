# Milestone 2B.3C — Timestamped Transcript Browser v1

## Purpose

This milestone extends the local-first Transcript tab with a timestamped segment
browser while preserving the continuous read view introduced in Milestone
2B.3B. It uses only the current transcript version and ordered segments already
stored in SQLite by Milestone 2B.3A.

The source checkpoint is `71ff7dd` on `milestone1sync`, after the read-only
Transcript tab passed online and offline device acceptance without creating any
new backend or provider work.

## Scope

Implemented here:

- an accessible local display-mode switch between continuous and timestamped
  transcript views;
- start/end time ranges for each cached segment;
- selectable text in both modes;
- optional local speaker and language metadata when present in the cached row;
- bounded timestamped rendering in batches of 100 segments;
- an explicit `Show more segments` action for long transcripts;
- safe empty state when a transcript has text but no timestamped segments;
- stricter local validation for segment identity, indexes, timestamp ranges,
  and text;
- English and Indonesian copy;
- source-boundary tests proving the browser remains local-only.

Explicitly deferred:

- tapping a segment to seek or control recording playback;
- transcript editing or immutable user-created versions;
- speaker correction and diarization controls;
- search, highlights, annotations, export, sharing, and copy actions;
- remote reads from the transcript UI;
- Supabase, SQLite, Edge Function, secret, Cron, or native dependency changes.

## Local-first browse path

```text
Session Detail -> Transcript tab
  -> loadLocalTranscriptReadModel(session_id)
  -> current local transcript version + ordered local segments
  -> Continuous mode: current plain_text / ordered-text fallback
  -> Timestamped mode: bounded local segment rows with start/end ranges
```

The timestamp formatter uses the existing duration utility and supports both
`MM:SS` and `HH:MM:SS`. Rendering is capped initially at 100 rows and grows in
100-row batches, avoiding an unbounded first render inside the existing Session
Detail scroll container.

The presentation read model strips provider-only identifiers. Timestamp rows
contain only local segment identity, index, time range, text, and optional
speaker/language labels.

## Validation boundary

The read model rejects local segment sets when any row:

- belongs to another workspace, session, or transcript version;
- has a duplicate identity or a duplicate/decreasing/negative/non-integer index;
- has negative/non-integer timestamps or `end_ms < start_ms`;
- contains empty text.

No remote request is made to recover invalid local cache data. The existing
result-sync worker remains responsible for replacing the local current version
atomically.

## Offline behavior

Both display modes use the same SQLite read model. Switching modes and loading
additional timestamped rows therefore remains available with Wi-Fi and mobile
data disabled after a transcript has synchronized once.

## No migration or native rebuild requirement

SQLite schema v10 already stores `start_ms`, `end_ms`, ordered segment text,
optional language/speaker metadata, and current transcript versions. This
milestone adds no migration and no native dependency. The existing development
build can load it through Metro.
