# Milestone 2B.3A — Transcript Result Sync and Local Persistence v1

## Purpose

This milestone synchronizes durable server transcription results back into the
native SQLite cache after Milestone 2B.2 has submitted a recording. It does not
add transcript reading/editor UI and never moves provider execution or secrets
into React Native.

Source checkpoint: `67407416d5801491b4f532b5c068ac018716797e` on
`milestone1sync`.

## Existing read surface

Migration `0013` already grants authenticated, RLS-scoped `SELECT` access to:

- `processing_jobs`;
- `transcription_runs`;
- `transcript_versions`;
- `transcript_segments`.

Writes remain server/service-role only. No Supabase migration or new Edge
Function is required.

SQLite schema v10 already contains matching provider-neutral cache tables, so
no local migration is required either.

## Flow

```text
submitted local request + server_job_id
  -> authenticated RLS read of processing_jobs
  -> queued/leased/processing: persist progress + durable next poll
  -> failed/cancelled: persist terminal state
  -> succeeded: require provider cleanup succeeded
  -> fetch current transcript version
  -> fetch all segments in 500-row pages
  -> validate job/workspace/session/recording/run/version scope
  -> one serialized SQLite transaction
       upsert local job
       upsert latest run
       demote prior local current version
       upsert current version
       replace that version's segments
       clear result retry diagnostics
```

The submitted request row is the durable polling anchor. `next_retry_at` and
`attempt_count` are reused only after server submission for bounded consecutive
transport backoff; normal server processing resets that counter.

## Crash, offline, and retry behavior

- No remote read is attempted while offline or signed out.
- Lifecycle/network events wake result sync.
- A successful request submission emits a dedicated wake event.
- Pending server state stores a durable next-poll timestamp.
- A module-local timer handles continued polling while the app remains active.
- App suspension is safe because resume/network events restart the worker.
- Transport failures preserve `submitted` intent and use bounded exponential
  backoff rather than discarding the result anchor.
- Atomic SQLite ingestion prevents half-written transcripts after interruption.
- Repeated sync is idempotent and replaces only the target version's segments.

## Security boundary

The mobile client uses its existing Supabase session and RLS. It does not read,
store, or invoke:

- `ASSEMBLYAI_API_KEY`;
- `PROJECT_RECALL_TRANSCRIPTION_WORKER_TOKEN`;
- Supabase service-role/secret keys;
- AssemblyAI APIs;
- `transcription-worker`.

Raw provider job identifiers and provider metadata are deliberately not written
to SQLite. Only a boolean cleanup prerequisite crosses the in-memory read
boundary.

## Deferred scope

- transcript display/reader UI;
- transcript editing and version creation;
- realtime subscriptions;
- production rollout changes.
