# C2G.3E-R1 Worker Data API Bypass V1 — Test Plan

## Candidate source gate

Required baseline before applying the candidate:

```text
branch=milestone1sync
HEAD=origin/milestone1sync
HEAD=f93bf348457f678e718425b6ae874c489ec7ba23
worktree clean
index clean
no rebase, merge, cherry-pick, revert, or bisect in progress
```

The apply runner verifies the expected Git blob hashes of every existing file it
modifies and refuses partial or stale application.

## Focused TypeScript/Jest coverage

`transcription-worker-database-adapter.test.ts` verifies:

- all eleven methods map to one fixed executor operation;
- no adapter method retries;
- scalar cardinality and result type checks;
- set-returning function shape checks;
- strict UUID, state-enum, timestamp, and safe-integer handling;
- completion payload preservation;
- raw driver details are not propagated;
- the exact Postgres.js version and conservative pooler options;
- exactly eleven fixed SQL function calls;
- no `sql.unsafe`, query cancellation, or per-request `sql.end`;
- safe operation-only logging.

Existing worker tests continue to verify no-work behavior, provider-submission
ambiguity handling, database/provider error classification, atomic completion,
and cleanup persistence behavior.

## Role behavior test

After migration `0017` is applied to a disposable project,
`0017_transcription_worker_direct_database_role_behavior.sql` must report:

```text
TRANSCRIPTION_WORKER_DATABASE_ROLE_ATTRIBUTES=PASS
TRANSCRIPTION_WORKER_DATABASE_ROLE_MEMBERSHIPS=PASS
TRANSCRIPTION_WORKER_DATABASE_ROLE_SCHEMA_PRIVILEGES=PASS
TRANSCRIPTION_WORKER_DATABASE_ROLE_DIRECT_RELATION_ACL=PASS
TRANSCRIPTION_WORKER_DATABASE_ROLE_WORKER_FUNCTIONS=PASS
TRANSCRIPTION_WORKER_DATABASE_ROLE_OPERATOR_FUNCTIONS=PASS
PROJECT_RECALL_TRANSCRIPTION_WORKER_DIRECT_DATABASE_ROLE=PASS
```

The behavior script is read-only and ends with `ROLLBACK`.

## Local validation commands

Run from `frontend` after applying the candidate:

```bash
yarn tsc --noEmit

yarn jest --runInBand \
  __tests__/transcription-request-worker.test.ts \
  __tests__/transcription-worker-database-adapter.test.ts \
  __tests__/transcription-worker-migration.test.ts

yarn eslint --max-warnings 0 \
  __tests__/transcription-request-worker.test.ts \
  __tests__/transcription-worker-database-adapter.test.ts \
  __tests__/transcription-worker-migration.test.ts

yarn jest --runInBand

yarn lint

yarn eslint --max-warnings 0 --no-cache src app

npx expo install --check
npx expo-doctor
```

Run Deno type checking only with an already installed, approved Deno binary:

```bash
deno check \
  --config ../supabase/functions/transcription-worker/deno.json \
  ../supabase/functions/transcription-worker/index.ts
```

Do not accept an implicit package-install prompt from `npx`.

## Disposable deployment gate

Before production, use `project-recall-disposable` and keep transcription
disabled. Verify role attributes and grants, provision the password outside
source, verify transaction-pooler login, set the Edge Function secret, deploy
only `transcription-worker`, and observe twenty consecutive passive Cron
invocations.

Acceptance:

```text
HTTP_200=20
HTTP_500=0
HTTP_503=0
HTTP_504=0
active_processing_jobs=0
active_transcription_runs=0
unresolved_provider_artifacts=0
manual_review_provider_artifacts=0
transcription_enabled=false
```

## Production gate

Production deployment requires a new explicit approval after disposable success.
The production sequence must separately gate role creation, password
provisioning, pooler verification, secret creation, function deployment, and two
passive ten-cycle windows. No recording canary or feature enablement belongs to
this milestone.
