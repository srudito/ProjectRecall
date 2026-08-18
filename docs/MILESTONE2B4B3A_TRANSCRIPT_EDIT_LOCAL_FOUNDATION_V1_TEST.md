# Milestone 2B.4B.3A — Transcript Edit Local Foundation V1 Test

## Objective

Verify that the local transcript-edit foundation is additive, local-first,
idempotent, cleanup-safe, and isolated from immutable transcript evidence.

This test plan covers SQLite migration v11, repository behavior, cleanup
integration, and project-wide regression gates. It does not exercise an edit
RPC, network worker, editor UI, Supabase migration, or production deployment
because those are outside 2B.4B.3A.

## Source under test

Implementation base source:

```text
1d62df7449f3166572d268171a03d0a0f07e574d
```

Changed source/test files:

```text
frontend/src/services/sqlite/migrations.ts
frontend/src/services/sqlite/repository.ts
frontend/__tests__/sqlite-migrations.test.ts
frontend/__tests__/local-account-cleanup-repository.test.ts
frontend/__tests__/transcript-edit-local-repository.test.ts
```

## Migration contract

The SQLite migration tests verify that:

- the latest local schema advances from version 10 to version 11;
- upgrades from older schema versions apply v11 through the existing serialized
  migration runner;
- v11 creates `local_transcript_edit_drafts`;
- v11 creates `local_transcript_edit_queue`;
- the draft table is unique per user/session;
- the queue uses a stable primary-key client UUID;
- queue status and retry constraints are present;
- next-eligible and session indexes are created;
- existing v10 transcription tables and their contracts remain present.

This is an application-local SQLite migration. No Supabase migration is created
or applied.

## Repository behavior

`transcript-edit-local-repository.test.ts` verifies:

1. draft text is stored in `local_transcript_edit_drafts`, not in
   `local_transcript_versions` or `local_transcript_segments`;
2. autosave SQL does not replace `base_version_id`, preserving the originally
   observed edit base;
3. an outbound save creates a pending immutable snapshot keyed by the supplied
   stable client version UUID;
4. an identical UUID/scope/base/text replay is idempotent and returns the
   existing queue row without another insert;
5. reuse of the same UUID with different transcript content is rejected;
6. blank outbound transcript content is rejected.

The focused repository suite uses mocked SQLite boundaries; it does not claim a
physical-device editor flow or network submission.

## Cleanup behavior

`local-account-cleanup-repository.test.ts` verifies both new tables are removed
before hard session deletion reaches the session row.

Account deletion coverage verifies the new tables are deleted using the same
user/workspace/session scoping rules as the existing local transcription graph.
The pre-existing WAL truncate/fail-closed cleanup behavior remains covered.

## Evidence and offline invariants

The tests and source review require that draft/outbox operations do not write to
immutable transcript versions or timestamp segments.

This preserves:

- offline durability of draft/outbox state;
- provider transcript/timestamp evidence;
- stable UUID idempotency for later retries;
- compare-and-swap base lineage for the later server call;
- no last-write-wins replacement of a stale base.

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
  Tests:       24 passed, 24 total

Targeted ESLint: PASS
```

A test-only TypeScript inference correction typed mocked `runAsync` statement
arguments explicitly. It changed no runtime behavior.

## Full regression result

```text
Full Jest:
  Test Suites: 69 passed, 69 total
  Tests:       602 passed, 602 total
  Snapshots:   0 total

Release readiness: PASS
Expo install --check: PASS
Expo Doctor: 18/18 PASS
git diff --check: PASS
```

The exact protected implementation scope remained five source/test files during
the gate run.

## Not executed by design

The following are not 2B.4B.3A gates and must not be introduced merely to test
this local foundation:

```text
Supabase migration apply
migration 0015 rerun
migration 0016 rerun
migration repair
linked db push/reset
Edge Function deploy
transcription-worker v8 redeploy
Cron change
provider live transcription
editor UI acceptance
production deployment
```

## Closure condition

2B.4B.3A can close when:

- this documentation is added;
- the exact final source+documentation scope is verified;
- TypeScript, focused Jest, targeted ESLint, full Jest, release readiness, Expo
  install check, and Expo Doctor remain green;
- exact staging contains only the milestone files;
- the closure commit is pushed and local/remote heads align.

2B.4B.3B must not start as part of this closure.
