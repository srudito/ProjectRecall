# Milestone 2B.4B.3B — Transcript Edit Sync Worker V1 Test

## Objective

Verify that the transcript-edit outbox synchronizes through the authenticated
migration-0016 RPC with stable UUID idempotency, compare-and-swap conflict
safety, bounded retry, crash recovery, conditional draft cleanup, and no schema
or editor-UI change.

## Source under test

Implementation base source:

```text
fafa96826180ef2ba4ebd07cab4388b7d51194c8
```

Changed source/test files:

```text
frontend/src/services/sqlite/repository.ts
frontend/src/services/sync/ProjectSyncCoordinator.tsx
frontend/src/services/transcription/edit-client.ts
frontend/src/services/sync/transcript-edit-worker.ts
frontend/__tests__/transcript-edit-local-repository.test.ts
frontend/__tests__/transcript-edit-client.test.ts
frontend/__tests__/transcript-edit-worker.test.ts
```

## RPC client coverage

`transcript-edit-client.test.ts` verifies that:

- the client calls only `create_transcript_user_edit_version_v1` with the exact
  session/base/client-version/text arguments;
- the current authenticated user must match `expectedUserId`;
- stable client UUID success responses are parsed and normalized;
- a late idempotent replay is valid even when `current_version_id` has moved to
  another later version;
- stale-base server markers become explicit non-retryable conflicts;
- unknown database details are replaced by a bounded safe retry message;
- network errors use a safe retryable message without leaking raw details;
- malformed or mismatched RPC results fail closed.

## Local repository transition coverage

`transcript-edit-local-repository.test.ts` retains the 3A draft/outbox
foundation tests and additionally verifies:

- claiming moves an eligible `pending`/`failed` row to `submitting`;
- claim increments the attempt count and rechecks retry due-time and maximum
  attempt budget;
- interrupted `submitting` rows recover to `pending` without consuming retry
  budget;
- terminal failure exhausts the attempt budget so the existing eligible query
  cannot select it again;
- terminal state mutation is guarded by `queue_status = 'submitting'`;
- successful completion validates queue identity/base/text before success;
- exact matching draft cleanup occurs only after guarded queue completion;
- a mismatched completion throws before draft deletion.

## Worker behavior coverage

`transcript-edit-worker.test.ts` verifies:

- one immutable queue snapshot is submitted and completed;
- a late stable-UUID replay succeeds even if a later version is current;
- stale-base saves become `conflict` and are not rescheduled;
- feature-disabled state is deferred rather than terminally failed;
- authentication-required state is deferred and stops the run;
- retryable network failures use bounded backoff;
- retry stops when the attempt budget is exhausted;
- unavailable server sessions become cancelled;
- offline workers do not claim queue rows;
- account-deletion quiescence prevents synchronization;
- interrupted `submitting` rows recover before each run.

## Local-first invariants

The test boundary requires that 3B:

- uses the existing SQLite v11 queue;
- creates no SQLite v12 migration;
- does not mutate local transcript versions on RPC success;
- does not create or copy transcript timestamp segments;
- preserves stale/conflicting drafts for later user resolution;
- does not delete a newer draft after an older queued snapshot succeeds;
- remains durable across app interruption and network ambiguity.

## Focused validation result

Node:

```text
v20.19.4
```

Focused gates:

```text
TypeScript: PASS

Focused Jest:
  Test Suites: 3 passed, 3 total
  Tests:       28 passed, 28 total

Targeted ESLint: PASS
```

## Full regression result

```text
Full Jest:
  Test Suites: 71 passed, 71 total
  Tests:       625 passed, 625 total
  Snapshots:   0 total

Release readiness: PASS
Expo install --check: PASS
Expo Doctor: 18/18 PASS
git diff --check: PASS
```

The protected implementation scope remained exactly seven source/test files
during the full gate.

## Not executed by design

The following are outside Milestone 2B.4B.3B and must not be introduced merely
to validate this source milestone:

```text
SQLite migration v12
Supabase migration apply
migration 0015 rerun
migration 0016 rerun
migration repair
linked db push/reset
Edge Function deploy
transcription-worker v8 redeploy
Cron change
provider live transcription
generic current-version pull
cross-device version synchronization
editor UI acceptance
production deployment
```

## Closure condition

2B.4B.3B can close when:

- this documentation is added;
- exact final source+documentation scope is verified;
- TypeScript, focused Jest, targeted ESLint, full Jest, release readiness, Expo
  install check, and Expo Doctor remain green;
- exact staging contains only the milestone files;
- the closure commit is pushed and local/remote heads align.

Milestone 2B.4B.3C and editor UI must not start as part of this closure.
