# Milestone 2B.4B.3B — Transcript Edit Sync Worker V1 Implementation

## Status

Implemented and validated in development source. This document is part of the
Milestone 2B.4B.3B closure change.

Implementation base source:

```text
fafa96826180ef2ba4ebd07cab4388b7d51194c8
```

Milestone 2B.4B.3A is closed and provides SQLite v11 draft/outbox persistence.
Migration 0016 remains the already-applied server contract and must not be
rerun. This milestone creates no SQLite or Supabase migration.

## Purpose

Milestone 2B.4B.3B connects the durable local transcript-edit outbox to the
authenticated immutable user-edit RPC from migration 0016.

The implementation remains deliberately below the editor UI and generic
cross-device transcript-version pull layers. Its responsibilities are:

- submit the exact immutable queue snapshot under its stable client UUID;
- preserve compare-and-swap semantics through `expected_current_version_id`;
- recover safely after an interrupted or ambiguous network result;
- distinguish retryable failures from stale-base conflicts and terminal errors;
- preserve a newer local draft when an older queued snapshot completes;
- wake the worker from existing native lifecycle/network synchronization points.

## Source scope

Modified:

```text
frontend/src/services/sqlite/repository.ts
frontend/src/services/sync/ProjectSyncCoordinator.tsx
frontend/__tests__/transcript-edit-local-repository.test.ts
```

Added:

```text
frontend/src/services/transcription/edit-client.ts
frontend/src/services/sync/transcript-edit-worker.ts
frontend/__tests__/transcript-edit-client.test.ts
frontend/__tests__/transcript-edit-worker.test.ts
```

No SQLite migration v12 is introduced.

## Authenticated RPC client

`edit-client.ts` invokes:

```text
create_transcript_user_edit_version_v1
```

with the exact server-contract arguments:

```text
p_session_id
p_expected_current_version_id
p_client_version_id
p_plain_text
```

Before the RPC call the client verifies that the Supabase session belongs to the
expected signed-in user. No service-role key, privileged token, or custom secret
is used by the mobile client.

The response parser requires exactly one row containing:

```text
transcript_version_id
version_number
current_version_id
was_created
```

The returned transcript version ID must match the stable client UUID from the
queue row.

A late idempotent replay is intentionally accepted even when
`current_version_id` is no longer the submitted version. Migration 0016 returns
the original committed user-edit version for a stable UUID replay even if a
later edit has since become current. Therefore only the stable
`transcript_version_id` is required to match the queued operation.

## Safe error normalization

The client maps reviewed server markers to bounded safe mobile errors and does
not surface arbitrary database/transport details.

Important classifications:

- `TRANSCRIPT_EDIT_BASE_CONFLICT` is non-retryable and becomes a local
  `conflict` outcome;
- `TRANSCRIPT_EDIT_IDEMPOTENCY_CONFLICT`, invalid/unchanged input, forbidden
  access, and other reviewed terminal markers do not enter an automatic retry
  loop;
- `TRANSCRIPT_EDIT_AUTHENTICATION_REQUIRED` preserves the queue and defers;
- `TRANSCRIPT_EDIT_FEATURE_DISABLED` preserves the queue and defers;
- `TRANSCRIPT_EDIT_CURRENT_VERSION_CONFLICT` is treated as a transient
  serialization/current-switch race and may retry within the bounded budget;
- network and unknown request failures use safe retryable messages;
- malformed or mismatched RPC responses fail closed.

## Durable queue state machine

The existing SQLite v11 queue is reused without schema changes.

### Eligible and claim

Eligible lookup remains restricted to:

```text
pending
failed
```

with a remaining attempt budget and a due `next_retry_at`.

Claim repeats the due-time and attempt-budget checks atomically before moving
the row to:

```text
submitting
```

and increments `attempt_count`.

### Crash recovery

Before each authenticated worker run, user-scoped `submitting` rows are reset to
`pending` and the interrupted claim attempt is returned to the budget.

This is safe because replay uses the same immutable queue payload and stable
client transcript-version UUID. If the server committed before the app stopped,
migration 0016 returns the same existing user-edit version instead of creating a
duplicate.

### Retry and defer

Retryable transport/request failures move the row to `failed` with a due
`next_retry_at`. The existing bounded exponential backoff utility is reused.

Feature-disabled and authentication-required outcomes are deferred back to
`pending` while decrementing the just-consumed claim attempt, so waiting on
environment/auth state does not consume the operation's retry budget.

### Conflict and terminal outcomes

A stale-base server result becomes:

```text
conflict
```

and is never silently rebased or last-write-wins overwritten.

Terminal failures are made ineligible by exhausting the local attempt budget.
A server-side unavailable/deleted session becomes `cancelled`.

Outcome mutations are guarded so they only transition a row that is still
`submitting`.

## Conditional draft cleanup

Successful server completion first validates that the local `submitting` queue
row still matches the exact claimed identity:

```text
queue id
user
workspace
session
expected current version
plain text
```

Only after that guarded transition succeeds does the same serialized local
transaction delete a draft whose:

```text
user/workspace/session
base_version_id
plain_text
```

still match the submitted snapshot.

Therefore a user can continue editing locally while an older save is in flight;
completion of that older immutable server version cannot delete the newer draft.

If local queue completion no longer matches the claimed snapshot, completion
fails closed and the draft is not deleted.

## Worker lifecycle

`transcript-edit-worker.ts` follows the established native queue-worker pattern:

- account-deletion quiescence before work and between operations;
- web skip;
- online connectivity gate;
- authenticated-user gate;
- single-flight execution;
- interrupted `submitting` recovery;
- bounded operations per run;
- durable retry/backoff;
- safe synchronization-change notification.

`ProjectSyncCoordinator` wakes the edit worker from the existing
`requestAllSync()` path used at authenticated initialization, app-active
transitions, and network reconnection.

## Evidence and version-sync boundary

2B.4B.3B does not write the RPC result directly into
`local_transcript_versions` or fabricate timestamp segments.

The worker only records outbox completion. Generic synchronization of the
server's current immutable transcript version, including user-edit versions and
timestamp-evidence lineage handling, remains Milestone 2B.4B.3C.

This keeps provider timestamp evidence separate from arbitrary edited Full Text.

## Security and deployment boundary

No change was made to:

- Supabase migrations, RLS, or RPC definitions;
- SQLite schema version 11;
- Edge Functions;
- transcription-worker v8;
- Cron;
- provider integration;
- secrets or public environment variables;
- package or lock files;
- native configuration;
- transcript editor UI;
- production.

No server deployment or database operation is required for this source
milestone.

## Validation result

Development source validation passed with Node 20.19.4:

```text
TypeScript: PASS
Focused Jest: 3 suites, 28 tests PASS
Targeted ESLint: PASS
Full Jest: 71 suites, 625 tests PASS
Release readiness: PASS
Expo install --check: PASS
Expo Doctor: 18/18 PASS
git diff --check: PASS
```

The protected source scope remained exactly seven files throughout the gate
runs.
