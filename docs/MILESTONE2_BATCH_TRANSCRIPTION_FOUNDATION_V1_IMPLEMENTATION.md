# Milestone 2A — Batch Transcription Foundation v1 Implementation

## Objective

Establish durable, provider-neutral batch-transcription contracts before any
provider, worker, UI, or feature flag is enabled.

This phase must preserve Project Recall's local-first behavior, stable UUIDs,
idempotent queues, private Storage, RLS, Delete Account safety, and tested
Milestone 1 UI.

## Scope

### Supabase migration `0013`

`0013_transcription_foundation_v1.sql` is append-only. It does not edit or
rerun migrations `0001–0012`.

It fails closed with `TRANSCRIPTION_FOUNDATION_ALREADY_IN_USE` if any of the
three disabled Milestone 1 foundation tables contain rows. This avoids guessing
how to migrate unexpected pre-Milestone-2 data.

The migration adds:

- canonical recording/session/workspace composite constraints;
- durable processing job fields for idempotency, priority, bounded attempts,
  next retry, lease ownership/expiry, safe errors, and request payload;
- multiple provider-run attempts per job;
- request mode and language-detection metadata;
- version origin/status, parent version, plain text, language summary, checksum,
  and current-version marker;
- one canonical scoped relationship between provider runs and transcript
  versions; deleting a run or its durable job clears only the nullable run ID,
  while session/workspace deletion still cascades versions and segments;
- timestamped transcript segments with language, confidence, and provider IDs;
- indexes for job claiming, session history, current versions, and segment time;
- account-deletion guard and `updated_at` triggers for transcript segments.

### Server-only cloud writes

Migration `0002` originally granted broad member write policies to foundation
tables. Migration `0013` replaces those policies with workspace-member SELECT
policies and normalizes the Data API table privileges explicitly: `anon` has no
access, `authenticated` is SELECT-only, and `service_role` receives the
server-side SELECT/INSERT/UPDATE/DELETE privileges required by a reviewed
worker. This avoids depending on Supabase project-level default grants.

Phase 2B will add a reviewed server-side request/worker path. Provider output is
not writable directly from the mobile client, and no service-role credential is
stored in the mobile bundle or migration source.

### Local SQLite schema version `10`

The mobile database gains:

- `local_processing_jobs`;
- `local_transcription_runs`;
- `local_transcript_versions`;
- `local_transcript_segments`;
- `local_transcription_request_queue`.

The queue stores only stable IDs, normalized language settings, retry metadata,
and safe errors. It does not store provider credentials. Local request
uniqueness is scoped by `user_id`, workspace, and semantic idempotency key so a
retained row for one signed-out user cannot block another user on the same
device. Cloud processing-job idempotency remains workspace-scoped.

### Provider-neutral request contract

`src/services/transcription/contracts.ts` prepares a request only when:

- session and recording scopes match;
- the session is not deleting/deleted;
- recording upload status is `synchronized`;
- a private Storage path exists;
- the path uses the expected workspace/session/recording prefix and includes
  a non-empty canonical object path with no empty, dot, dot-dot, backslash, NUL,
  or edge-whitespace segment;
- normalized language codes are valid;
- language count matches auto/single/multilingual mode.

Idempotency keys include:

```text
contract version
workspace UUID
session UUID
recording UUID
spoken-language mode
normalized language fingerprint
```

The prepared request intentionally excludes local file URI, provider name,
provider model, provider secret, signed URL, and privileged Supabase key.

### Domain validation

New Zod models validate:

- processing job status, attempts, and active lease requirements;
- provider execution attempt number and metadata;
- positive transcript versions and checksums;
- segment timestamp ordering and confidence bounds;
- stable UUID queue IDs and bounded retries.

### Deletion integration

Session hard deletion removes local transcript segments, versions, runs, jobs,
and request-queue rows before parent session data.

Delete Account scoped cleanup removes local transcription rows by owned
workspace, owned session, or user actor ID while preserving unrelated rows on
shared devices. Server preflight and final-reference checks include
`processing_jobs.created_by`, `transcription_runs.created_by`, and
`transcript_versions.created_by`; creator rows in non-owned workspaces block
before Storage, workspace, or Auth deletion begins. Content created by other
users in an owned workspace also blocks destructive workspace cleanup.

Before an owned workspace is deleted while the durable account-deletion gate
is active, its transcript versions are deleted explicitly. This lets segment
rows cascade and prevents provider-run `ON DELETE SET NULL` actions from
attempting a guarded transcript-version update during workspace/session
cascades. Delete Account therefore does not depend on PostgreSQL foreign-key
trigger ordering. WAL truncation behavior remains unchanged.

## Deliberately excluded

Phase 2A does not include:

- a real transcription provider;
- provider API credentials;
- provider selection/routing;
- signed provider input URLs;
- a job intake Edge Function or worker;
- polling or webhooks;
- result synchronization repositories;
- transcript UI/editor;
- diarization;
- summaries, Ask AI, OCR, or embeddings;
- enabling `transcription_enabled`.

## Migration handling

After final review and commit:

- first run a fresh `0001–0013` smoke test in a disposable isolated project,
  including deterministic run/job/session/workspace delete behavior, the
  removed-member shared-workspace blocker, and owned-workspace deletion while
  the durable account-deletion gate is active;
- only after that isolated smoke test passes, apply **only**
  `0013_transcription_foundation_v1.sql` once to the existing development
  project through the approved manual process;
- deploy the reviewed `delete-account` Edge Function immediately after the
  development migration succeeds; do not deploy the new function before
  `0013`, because its preflight SQL references the new foundation columns;
- keep `transcription_enabled=false` and do not deploy a transcription writer
  during this short migration/function rollout; the empty-table precondition
  ensures no new transcription actor references can appear in between;
- do not rerun `0001–0012`;
- do not use `supabase db push`, migration repair, or linked reset as a shortcut.

## Next phase

Phase 2B will choose one provider and implement a server-side
`TranscriptionProvider` interface plus durable worker. It must reuse the job,
lease, attempt, scope, and idempotency contracts established here.
