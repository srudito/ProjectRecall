# Milestone 2B.3B — Transcript Read UI v1

## Purpose

This milestone exposes the current transcript synchronized by Milestone 2B.3A
as a read-only, local-first session view. It adds no provider call, server write,
transcript editor, search, export, or database schema.

The source checkpoint is `bec53bb` on `milestone1sync`, after authenticated RLS
result reads, paginated segment synchronization, atomic SQLite persistence, and
offline local reread passed controlled development acceptance.

## Scope

Implemented here:

- a native `Transcript` tab on the existing Session Detail screen;
- current-version and segment loading from SQLite only;
- continuous selectable transcript text;
- fallback to ordered local segment text if `plain_text` is empty;
- current version number, segment count, and offline-availability metadata;
- loading, empty, retryable read-error, and stale-content-preservation states;
- refresh when the result sync worker publishes local changes;
- English and Indonesian copy;
- model validation for session/version/segment scope and segment ordering.

Explicitly deferred:

- timestamped segment browsing;
- transcript editing or immutable user-created versions;
- speaker correction and diarization controls;
- search, highlights, annotations, export, sharing, and copy actions;
- remote reads from the transcript UI;
- Supabase, SQLite, Edge Function, secret, Cron, or native dependency changes.

## Local-first read path

```text
Session Detail -> Transcript tab
  -> loadLocalTranscriptReadModel(session_id)
  -> getCurrentTranscriptVersionForSession(session_id)
  -> listTranscriptSegmentsForVersion(version_id)
  -> local SQLite current version + ordered segments
```

The read model validates that the current version belongs to the requested
session and that every segment belongs to the same workspace/session/version
with strictly increasing indexes. The UI never trusts unrelated local rows.

## Offline behavior

The component subscribes to the existing transcription sync event. When the
result worker atomically commits a current version and segment set, an open tab
refreshes in place. Once loaded, the same SQLite content remains readable with
Wi-Fi and mobile data disabled.

A background refresh error does not replace already rendered transcript text.
The last known local version remains visible with a safe warning.

## Security and privacy boundary

The transcript reader imports only local repository methods. It does not import
the Supabase client, call an Edge Function, read provider identifiers, or access
provider/worker credentials.

The existing account and session cleanup paths remain authoritative for deleting
local transcript cache data.

## No migration or native rebuild requirement

SQLite schema v10 already contains transcript version and segment tables, and
Milestone 2B.3A already populates them. This milestone requires no migration and
no new native dependency. An existing development build can load the UI through
Metro.
