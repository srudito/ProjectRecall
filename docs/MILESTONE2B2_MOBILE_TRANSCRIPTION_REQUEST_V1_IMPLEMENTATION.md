# Milestone 2B.2 — Mobile Transcription Request Integration v1

## Purpose

This milestone connects the native Expo/React Native client to the reviewed
`transcription-request` Edge Function without moving provider credentials or
provider execution into the app.

It starts from source checkpoint `fb46611` on `milestone1sync` after the
Milestone 2B.1B development backend completed controlled request, Cron-worker,
AssemblyAI, atomic-ingestion, and provider-cleanup validation. Production is
not part of this milestone.

## Scope

Implemented in this milestone:

- a provider-neutral mobile request service;
- durable local request intent using the existing SQLite v10
  `local_transcription_request_queue` table;
- offline-first queueing before the recording upload finishes;
- lifecycle/network/background retry through `ProjectSyncCoordinator`;
- authenticated invocation of `transcription-request` only;
- local idempotency keyed by recording scope and language intent;
- remote scope validation before storing the returned server job ID;
- safe retry/defer/fail/cancel transitions;
- non-authoritative cached feature availability for UI gating;
- a small recording-panel request/status control;
- English and Indonesian request/status strings.

Not implemented here:

- direct AssemblyAI calls from React Native;
- provider or worker secrets in frontend code;
- transcript download/synchronization into the local transcript cache;
- transcript reading/editor UI;
- automatic display of durable server completion state;
- any Supabase migration or Edge Function change;
- production activation.

## Local-first request flow

Native recordings receive their canonical private Storage path when the local
recording row is created, before binary upload completes. The user can therefore
persist transcription intent locally while offline or while upload is pending.
The background request worker does not call the server until both session
metadata and recording upload are synchronized.

```text
recording panel
  -> prepare provider-neutral local intent
  -> SQLite local_transcription_request_queue
  -> lifecycle/network/metadata sync trigger
  -> wait for session + recording synchronization
  -> authenticated transcription-request Edge Function
  -> server processing job ID persisted locally
```

The server remains authoritative for membership, synchronized recording state,
canonical Storage scope, language intent, feature-kill-switch state, and durable
job idempotency.

## Idempotency and crash recovery

The local queue reuses the stable Milestone 2A transcription idempotency key:

```text
batch-transcription:v1:<workspace>:<session>:<recording>:<mode>:<languages>
```

The SQLite uniqueness constraint remains:

```text
UNIQUE(user_id, workspace_id, idempotency_key)
```

Repeated user taps/retries therefore update the existing local intent instead
of inserting duplicate queue rows. `submitted` rows retain the same server job
ID. Rows left in `submitting` by a terminated process are restored to `pending`
before each worker run; the ambiguous local attempt is returned to the retry
budget because the server request itself is idempotent.

## Offline and dependency handling

The request worker does not claim work while the device is offline. If a queued
intent is eligible locally but its session metadata or recording binary is
still synchronizing, the worker defers the row without consuming the request
attempt budget. Recording/metadata sync events wake the worker again.

Retryable transport/backend failures use the existing bounded exponential
backoff helper. Authentication loss and the server-side feature kill switch are
deferred rather than converting the user's durable local intent into a terminal
failure.

## Feature availability

`feature_flags.transcription_enabled` is read by the client only as a UX hint.
The latest value is cached locally so an already-enabled development feature can
remain discoverable while offline.

The cache is **not** an authorization or safety boundary. The authenticated
Edge Function and database RPC repeat the feature check on every actual request.
A stale `true` client cache therefore cannot bypass a server-side kill switch.

## Security boundary

The mobile client invokes only:

```text
transcription-request
```

It never reads, stores, or sends:

```text
ASSEMBLYAI_API_KEY
PROJECT_RECALL_TRANSCRIPTION_WORKER_TOKEN
Supabase service-role/secret keys
private database credentials
```

The user's current Supabase session JWT authenticates the request. Workspace and
recording scope are re-derived on the server under RLS/security-definer guards;
the client does not submit workspace IDs, Storage URLs, signed URLs, or provider
configuration.

## UI behavior

The existing recording card receives a secondary `Request transcription`
action on native platforms when remote feature availability is enabled.

The action can be queued before binary upload completes. The panel then shows a
local queue status and explains that submission waits for secure cloud upload.
Failed/cancelled recording uploads must be retried before a transcription intent
can be created.

Local request states are intentionally limited to:

```text
pending
submitting
submitted
failed
cancelled
```

`submitted` means the authenticated backend accepted/reused the durable job. It
does **not** mean the transcript has been synchronized back to the mobile app.
Transcript result synchronization and transcript UI remain a later milestone.

## No database migration

SQLite schema version 10 already introduced the request queue and the backend
schema already exposes the reviewed request/worker control plane. This milestone
therefore adds no local migration and no Supabase migration.
