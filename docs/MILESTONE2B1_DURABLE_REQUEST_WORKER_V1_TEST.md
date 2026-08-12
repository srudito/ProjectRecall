# Milestone 2B.1B — Durable Request/Worker v1 Test Plan

## Automated source validation

Run from `/app/frontend`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/transcription-request-worker.test.ts \
  __tests__/transcription-worker-migration.test.ts \
  __tests__/transcription-contracts.test.ts \
  __tests__/transcription-foundation-migration.test.ts \
  __tests__/delete-account-backend.test.ts \
  __tests__/session-deletion-repository.test.ts \
  __tests__/session-deletion-worker.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  "./__tests__/transcription-request-worker.test.ts" \
  "./__tests__/transcription-worker-migration.test.ts" \
  "./__tests__/delete-account-backend.test.ts" \
  "./__tests__/session-deletion-repository.test.ts" \
  "./__tests__/session-deletion-worker.test.ts" \
  --max-warnings=0

node ./scripts/validate-release-readiness.js
npx expo-doctor
```

Then from `/app`:

```bash
git restore .emergent/cron/webhook-crons 2>/dev/null || true
git --no-pager diff --check
```

Required result: all exit codes `0`, full Jest passed, and Expo Doctor `18/18`.
The static suite also locks the hosted publishable-key JSON dictionary, one-hour
signed URL default, `pgcrypto` extension search path, processing-job deletion
guards, and membership-loss cleanup for provider-free work.

## Edge Function validation

When Deno is available:

```bash
deno check \
  supabase/functions/delete-account/index.ts \
  supabase/functions/transcription-request/index.ts \
  supabase/functions/transcription-worker/index.ts

deno lint \
  supabase/functions/_shared/supabase/server.ts \
  supabase/functions/delete-account/core.ts \
  supabase/functions/delete-account/database.ts \
  supabase/functions/delete-account/index.ts \
  supabase/functions/transcription-request/core.ts \
  supabase/functions/transcription-request/index.ts \
  supabase/functions/transcription-worker/core.ts \
  supabase/functions/transcription-worker/database.ts \
  supabase/functions/transcription-worker/index.ts
```

If Deno is unavailable, API-based Supabase bundling/deployment validation is
mandatory for the updated `delete-account`, `transcription-request`, and
`transcription-worker` functions after source approval and disposable migration
verification. Do not create a live provider secret merely to perform bundling.

## Fresh disposable database test

Before development migration rollout:

1. create a fresh disposable Supabase project;
2. apply migrations `0001` through `0014` once, in order;
3. create at least two confirmed disposable Auth users;
4. run `supabase/tests/0013_transcription_foundation_behavior.sql`;
5. run `supabase/tests/0014_transcription_request_worker_behavior.sql`;
6. confirm every required `PASS` notice;
7. confirm `transcription_enabled=false` after the transaction.

Do not use `supabase db push`, migration repair, or a linked database reset.

## Required 0014 behavior markers

```text
TRANSCRIPTION_FEATURE_DISABLED_REQUEST_CHECK=PASS
TRANSCRIPTION_REQUEST_IDEMPOTENCY_CHECK=PASS
TRANSCRIPTION_ACTIVE_RECORDING_JOB_REUSE_CHECK=PASS
TRANSCRIPTION_MEMBERSHIP_LOSS_CANCELLATION_CHECK=PASS
TRANSCRIPTION_MEMBERSHIP_LOSS_TERMINAL_PROVIDER_FREE_CHECK=PASS
TRANSCRIPTION_MEMBERSHIP_LOSS_POST_SUBMISSION_FAILURE_CHECK=PASS
TRANSCRIPTION_MEMBERSHIP_LOSS_POST_CLEANUP_CHECK=PASS
TRANSCRIPTION_NULL_RETRYABLE_REJECTION_CHECK=PASS
TRANSCRIPTION_PRE_SUBMISSION_RETRY_CHECK=PASS
TRANSCRIPTION_PRE_SUBMISSION_ATTEMPT_ACCOUNTING_CHECK=PASS
TRANSCRIPTION_QUEUED_RUN_REUSE_CHECK=PASS
TRANSCRIPTION_AMBIGUOUS_SUBMISSION_RECOVERY_CHECK=PASS
TRANSCRIPTION_CONFIRMED_ABSENCE_CHECK=PASS
TRANSCRIPTION_CONFIRMED_ABSENCE_RETRY_CHECK=PASS
TRANSCRIPTION_SUBMISSION_RECONCILIATION_CHECK=PASS
TRANSCRIPTION_PROVIDER_DEADLINE_CHECK=PASS
TRANSCRIPTION_CLEANUP_MANUAL_REVIEW_CHECK=PASS
TRANSCRIPTION_POLL_ATTEMPT_ACCOUNTING_CHECK=PASS
TRANSCRIPTION_COMPLETION_INTENT_MISMATCH_CHECK=PASS
TRANSCRIPTION_ATOMIC_COMPLETION_CHECK=PASS
TRANSCRIPTION_CLEANUP_RETRY_CHECK=PASS
TRANSCRIPTION_NEW_REQUEST_BLOCKED_BY_CLEANUP_CHECK=PASS
TRANSCRIPTION_RETRY_BLOCKED_BY_CLEANUP_CHECK=PASS
TRANSCRIPTION_RETRY_AFTER_CLEANUP_CHECK=PASS
TRANSCRIPTION_RECORDING_DELETE_GATE_CHECK=PASS
TRANSCRIPTION_SESSION_DELETE_GATE_CHECK=PASS
TRANSCRIPTION_METADATA_SECRET_REJECTION_CHECK=PASS
TRANSCRIPTION_FEATURE_FLAG_DISABLED=PASS
PROJECT_RECALL_TRANSCRIPTION_REQUEST_WORKER_BEHAVIOR=PASS
```

The membership-loss checks must cover a claimed provider-free queued run, a
terminal provider-free failure, retryable and terminal provider-free failures
persisted after the durable `submitting` boundary, and a failed provider run whose
cleanup finishes after membership was removed. Confirmed provider absence must
prove that an
ambiguous no-ID submission can safely re-use the same durable job without blind
resubmission before absence is confirmed. Recording and session deletion checks
must prove that provider submission and unresolved cleanup cannot be removed
through a foreign-key cascade.

## Rollout order

```text
source validation
→ final Pro patch review
→ commit and push
→ fresh disposable migrations 0001–0014
→ disposable 0013 and 0014 behavior SQL
→ apply migration 0014 once to development
→ API bundle/deploy the updated delete-account function from the same commit
→ API bundle/deploy transcription-request and transcription-worker
→ unauthenticated/feature-disabled mock smoke tests for all three functions
→ create development secrets only after approval
→ controlled non-sensitive live provider smoke test
→ no Cron and no feature activation until live cleanup verification passes
```

## Forbidden during this milestone review

```text
ASSEMBLYAI_API_KEY creation
worker-token creation
migration 0014 on development
function deployment
Cron scheduling
live provider calls
transcription_enabled=true
```
