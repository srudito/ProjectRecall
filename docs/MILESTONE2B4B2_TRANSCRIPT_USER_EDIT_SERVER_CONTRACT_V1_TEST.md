# Milestone 2B.4B.2 — Transcript User-Edit Server Contract Test Plan v1

## Source checkpoint

Implementation base source:
`217d89a44a6827e437e80999bb6370b55228c854` on `milestone1sync`.

Final verified behavior source:
`16e90555ccb950e4adbc9f257646419eace09740` on `milestone1sync`.

The implementation must remain limited to append-only migration 0016, its
rollback-wrapped SQL behavior test, one focused Jest source test, and milestone
documentation. Existing migrations must remain byte-for-byte unchanged.

## Automated source gates

From `/app/frontend` using Node `20.19.4`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/transcript-user-edit-versioning-migration.test.ts \
  __tests__/transcription-foundation-migration.test.ts \
  __tests__/transcription-worker-migration.test.ts \
  __tests__/account-deletion-gate-migration.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  ./__tests__/transcript-user-edit-versioning-migration.test.ts \
  ./__tests__/transcription-worker-migration.test.ts \
  --max-warnings=0

node ./scripts/validate-release-readiness.js
npx expo-doctor
```

Required result:

```text
TYPESCRIPT=PASS
FOCUSED_JEST=PASS
FULL_JEST=PASS
TARGETED_ESLINT=PASS
RELEASE_READINESS=PASS
EXPO_DOCTOR=PASS
```

## Static contract coverage

The focused Jest test verifies:

- migration 0016 follows 0015 without modifying earlier migrations;
- `user_edit` rows are final, parented, non-empty, and checksummed;
- version content and lineage are immutable;
- nullable run/user provenance cleanup remains compatible;
- the RPC uses `SECURITY DEFINER` with an empty search path;
- only `authenticated` receives execute privilege;
- direct authenticated transcript mutation stays denied;
- feature flag, membership, account-deletion, and session-lock gates exist;
- stable UUID replay occurs before stale-base conflict handling;
- current switching and version allocation are atomic;
- no timestamp segments are inserted or fabricated;
- no provider/worker credential or execution boundary is introduced.

## Database behavior test

After review and after migration 0016 has been applied exactly once to a
reviewed disposable or development environment, run:

```bash
supabase db query \
  --linked \
  --file supabase/tests/0016_transcript_user_edit_versioning_behavior.sql
```

Do not run this command before migration 0016 exists on the target database.
The behavior script requires at least one confirmed Auth user with an active
personal workspace membership and no active account-deletion request. It runs
inside `BEGIN ... ROLLBACK`, so verification rows do not persist.

Expected markers:

```text
TRANSCRIPT_USER_EDIT_PRIVILEGE_MATRIX=PASS
TRANSCRIPT_USER_EDIT_FEATURE_FLAG=PASS
TRANSCRIPT_USER_EDIT_CREATE=PASS
TRANSCRIPT_USER_EDIT_IDEMPOTENT_REPLAY=PASS
TRANSCRIPT_USER_EDIT_STALE_BASE_CONFLICT=PASS
TRANSCRIPT_USER_EDIT_IDEMPOTENCY_CONFLICT=PASS
TRANSCRIPT_USER_EDIT_UNCHANGED_REJECTED=PASS
TRANSCRIPT_VERSION_IMMUTABLE_CONTENT=PASS
TRANSCRIPT_USER_EDIT_MEMBERSHIP_GATE=PASS
TRANSCRIPT_USER_EDIT_ACCOUNT_DELETION_GATE=PASS
TRANSCRIPT_RUN_DELETE_SET_NULL_COMPATIBILITY=PASS
PROJECT_RECALL_TRANSCRIPT_USER_EDIT_VERSIONING=PASS
```

The test proves that:

- a provider v1 remains intact while a user edit becomes v2/current;
- the edit inherits source provenance and language metadata;
- no segment rows are created for edited text;
- exact replay returns the original committed operation;
- replay still succeeds after a later v3 becomes current;
- stale bases and UUID/payload reuse are rejected;
- identical text is rejected as a no-op;
- direct content mutation is blocked;
- removed membership and active account deletion block the RPC;
- deleting the provider run still clears nullable provenance without deleting
  transcript versions.

## Pre-apply boundary

Before applying migration 0016 to development, verify:

```text
branch = milestone1sync
local HEAD = origin/milestone1sync
migration 0016 is committed
migrations 0013-0015 are unchanged
no active account deletion
no transcript edit function with the same signature already exists
```

Do not require transcription tables to be empty. Migration 0016 is designed to
preserve existing provider transcript rows. If the new shape constraint finds an
unexpected malformed pre-existing `user_edit` row, stop and audit rather than
rewriting history.

## Operational boundary

For this SQL-only milestone:

```text
DO_NOT_RERUN_MIGRATION_0015
DO_NOT_REDEPLOY_TRANSCRIPTION_WORKER_V8
DO_NOT_CREATE_OR_ROTATE_SECRETS
DO_NOT_ENABLE_PRODUCTION
DO_NOT_START_EDITOR_UI_YET
```

After source and database behavior gates pass, close only Milestone 2B.4B.2.
Local drafts/outbox/version sync are the next separate milestone.

## Development verification result

Development verification completed successfully at source head
`16e90555ccb950e4adbc9f257646419eace09740` on `milestone1sync`.

The linked development database passed the read-only precondition audit before
migration apply. Migration 0016 was then applied exactly once. Post-apply checks
confirmed the constraints, indexes, immutable trigger, authenticated
security-definer RPC, privilege matrix, existing one-current-version invariant,
feature flag, and nullable-primary migration 0015 behavior remained valid.

The first behavior-test execution exposed a test-fixture-only PL/pgSQL name
ambiguity. The committed behavior test was corrected with
`#variable_conflict use_variable`; its SQL delimiter was then verified as
`do $$ ... $$`. The corrected rollback-wrapped behavior test passed, and the
post-test audit confirmed that verification sessions, jobs, runs, and user-edit
versions all returned to zero while `transcription_enabled` remained true.

Final source gates passed:

- TypeScript: PASS
- Focused Jest: 21 / 21 tests
- Full Jest: 68 / 68 suites, 596 / 596 tests
- Targeted ESLint: PASS
- Release readiness: PASS
- Expo install check: PASS
- Expo Doctor: 18 / 18
- Database behavior test: PASS
- Post-test rollback audit: PASS

Migration 0016 must not be rerun. Migration 0015 must not be rerun.
No worker redeployment, provider change, Cron change, secret change, native
change, or production rollout was part of this milestone.

Milestone 2B.4B.2 is complete in development. Local draft/outbox/version sync
remains the separate next milestone and is not started by this closure.
