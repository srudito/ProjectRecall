# Milestone 2A — Batch Transcription Foundation v1 Test Plan

## Automated validation

From `/app/frontend`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/transcription-contracts.test.ts \
  __tests__/transcription-foundation-migration.test.ts \
  __tests__/sqlite-migrations.test.ts \
  __tests__/local-account-cleanup-repository.test.ts \
  __tests__/delete-account-backend.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  "./src/domain/enums.ts" \
  "./src/domain/models.ts" \
  "./src/services/transcription/contracts.ts" \
  "./src/services/sqlite/migrations.ts" \
  "./src/services/sqlite/repository.ts" \
  "./__tests__/transcription-contracts.test.ts" \
  "./__tests__/transcription-foundation-migration.test.ts" \
  "./__tests__/sqlite-migrations.test.ts" \
  "./__tests__/local-account-cleanup-repository.test.ts" \
  "./__tests__/delete-account-backend.test.ts" \
  --max-warnings=0

node ./scripts/validate-release-readiness.js

npx expo-doctor
```

The frontend ESLint config does not cover the Deno Edge Function directory.
Because this milestone changes `delete-account/core.ts` and `database.ts`, run
Deno's own checks from `/app` when Deno is available:

```bash
cd /app

deno check supabase/functions/delete-account/index.ts

deno lint \
  supabase/functions/delete-account/core.ts \
  supabase/functions/delete-account/database.ts \
  supabase/functions/delete-account/index.ts
```

If Deno is unavailable locally, the reviewed function deployment/bundling check
is mandatory after migration `0013`; do not treat the frontend ESLint result as
coverage for files outside `/app/frontend`.

From `/app`:

```bash
git diff --check
git status --short
```

Expected:

```text
TypeScript      0 errors
Focused Jest    passed
Full Jest       passed
ESLint          0 errors, 0 warnings
Release check   passed
Deno check/lint passed when available; deployment bundle check otherwise
Expo Doctor     18/18 passed
git diff check  no output
```

## Migration static checks

The Jest migration test must verify:

- `0013` follows `0012` without modifying applied files;
- fail-closed behavior for unexpected existing foundation data;
- recording/session/workspace composite scope;
- workspace-scoped idempotency;
- bounded attempts and active leases;
- multiple provider attempts per durable job;
- one canonical scoped run/version relationship, with the legacy single-column
  run FK removed and explicit `ON DELETE SET NULL (transcription_run_id)`;
- version and segment constraints;
- deterministic role privileges: anon has no table access, authenticated is
  SELECT-only, and `service_role` has explicit server-side DML privileges;
- read-only authenticated result access;
- account-deletion guard trigger on segments;
- feature flag remains false;
- no provider or privileged credential names are introduced.

## Request-contract checks

Tests must cover:

- normalization, de-duplication, and deterministic sorting of language tags;
- semantic idempotency across reordered/case-changed language hints;
- different key when request mode/languages change;
- synchronized recording requirement;
- session/workspace scope mismatch rejection;
- private Storage prefix mismatch rejection;
- rejection of prefix-only, empty-segment, dot, and dot-dot object paths;
- single-language and multilingual cardinality after normalization;
- invalid language tag rejection;
- prepared payload contains no local file URI or provider credential.

## Local SQLite checks

Migration version `10` must create all five local tables and required indexes.
The local request queue must enforce
`UNIQUE(user_id, workspace_id, idempotency_key)` and user-scoped claim/session
indexes so two users on one retained SQLite database can hold the same semantic
request independently. The migration runner must advance atomically from `9`
to `10` and must not advance on failure.

Session deletion and Delete Account repository tests must verify the five local
transcription tables are deleted before parent session/profile cleanup. Delete
Account backend tests must also verify creator references in all three cloud
foundation tables block shared-workspace deletion before Storage/workspace/Auth
destruction and are included in the final-reference count.

## Isolated fresh migration smoke test after approval

Do not touch the development project yet. After the patch receives `APPROVE`
and is committed, first create a disposable Supabase project and apply
`0001–0013` once in filename order. Verify:

```text
MIGRATIONS_0001_0013_APPLY=PASS
TRANSCRIPTION_FOUNDATION_EMPTY_PRECONDITION=PASS
TRANSCRIPTION_SCOPE_CONSTRAINTS=PASS
TRANSCRIPTION_RUN_DELETE_SET_NULL_CHECK=PASS
TRANSCRIPTION_JOB_DELETE_GRAPH_CHECK=PASS
TRANSCRIPTION_SESSION_DELETE_CASCADE_CHECK=PASS
TRANSCRIPTION_WORKSPACE_DELETE_CASCADE_CHECK=PASS
DELETE_ACCOUNT_OWNED_WORKSPACE_TRANSCRIPTION_BLOCK=PASS
DELETE_ACCOUNT_SHARED_TRANSCRIPTION_BLOCK=PASS
DELETE_ACCOUNT_ACTIVE_GATE_TRANSCRIPTION_CASCADE_CHECK=PASS
TRANSCRIPTION_PRIVILEGE_MATRIX_CHECK=PASS
TRANSCRIPTION_RLS_READ_ONLY=PASS
TRANSCRIPT_SEGMENT_GUARD=PASS
TRANSCRIPTION_FEATURE_FLAG_DISABLED=PASS
```

Run `supabase/tests/0013_transcription_foundation_behavior.sql` after creating
two confirmed disposable Auth users. The script runs inside a transaction and
rolls back all verification rows.

Delete the disposable project after review of the results.

## Development Supabase verification after isolated PASS

Only after the disposable `0001–0013` smoke test passes:

1. Confirm the development project has migrations `0001–0012` already applied.
2. Run only `0013_transcription_foundation_v1.sql` once through SQL Editor.
3. Confirm it succeeds without `TRANSCRIPTION_FOUNDATION_ALREADY_IN_USE`.
4. Deploy the reviewed `delete-account` Edge Function. Do not deploy that
   function before `0013`, because its preflight SQL references the new
   transcription tables.
5. Run the function deployment/bundling check and the targeted Delete Account
   live verification before enabling any transcription writer.
6. Verify `transcription_enabled=false`.
7. Verify authenticated members can SELECT scoped rows but cannot directly
   INSERT/UPDATE/DELETE processing/transcript rows.
8. Confirm no transcription UI appears.

Do not use:

```text
npx supabase db push
npx supabase migration repair
npx supabase db reset --linked
```

## Exit criteria

Phase 2A is complete only when:

- final review says `APPROVE`;
- automated validation passes;
- fresh `0001–0013` isolated migration, privilege, RLS, trigger, feature-flag,
  and behavior verification passes;
- only after that isolated PASS, migration `0013` is applied once to
  development;
- feature flag remains disabled;
- no provider secret or provider execution path exists in mobile code.

Do not begin Phase 2B automatically.
