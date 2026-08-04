# Delete Account UI and Crash-Safe Local Cleanup v1 — Verification

Use only the Supabase development project and disposable accounts. Never test
permanent deletion with a primary account.

## 1. Apply migration 0012 once

The remote CLI migration ledger is empty, so do not use `db push` or migration
repair. Run only:

```text
supabase/migrations/0012_profile_account_deletion_gate.sql
```

through the development Supabase SQL Editor.

Do not edit or replay migrations `0001`–`0011`.

Verify the function privilege:

```sql
select
  has_function_privilege(
    'anon',
    'public.guard_profile_account_deletion_write()',
    'EXECUTE'
  ) as anon_can_execute,
  has_function_privilege(
    'authenticated',
    'public.guard_profile_account_deletion_write()',
    'EXECUTE'
  ) as authenticated_can_execute,
  has_function_privilege(
    'service_role',
    'public.guard_profile_account_deletion_write()',
    'EXECUTE'
  ) as service_role_can_execute;
```

Expected:

```text
false,false,true
```

## 2. Profile gate live regression

With a disposable user and no real deletion request, a normal profile update
must still work. Restore the original value after the test.

With a synthetic `retryable_failed` request for that user, an update to
`public.profiles` must fail with:

```text
ACCOUNT_DELETION_IN_PROGRESS
```

Delete only the synthetic row identified by the dedicated test error code.
Never remove a real retryable deletion request.

## 3. Automated validation

From `frontend/`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/account-deletion-state.test.ts \
  __tests__/account-deletion-client.test.ts \
  __tests__/delete-account-backend.test.ts \
  __tests__/account-deletion-local-cleanup.test.ts \
  __tests__/local-account-cleanup-repository.test.ts \
  __tests__/account-deletion-auth-cleanup.test.ts \
  __tests__/account-deletion-quiescence.test.ts \
  __tests__/account-deletion-boundary.test.ts \
  __tests__/account-deletion-worker-gate.test.ts \
  __tests__/account-deletion-gate-migration.test.ts \
  __tests__/root-stack.test.tsx \
  __tests__/localization.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  "./app/account/delete.tsx" \
  "./app/(tabs)/profile.tsx" \
  "./app/_layout.tsx" \
  "./src/components/AccountDeletionBoundary.tsx" \
  "./src/services/account-deletion/client.ts" \
  "./src/services/account-deletion/local-cleanup.ts" \
  "./src/services/account-deletion/quiescence.ts" \
  "./src/services/account-deletion/state.ts" \
  "./src/services/sqlite/repository.ts" \
  "./src/services/supabase/auth.ts" \
  "./src/services/sync/ProjectSyncCoordinator.tsx" \
  "./src/services/sync/project-sync-worker.ts" \
  "./src/services/sync/recording-upload-worker.ts" \
  "./src/services/sync/media-upload-worker.ts" \
  "./src/services/sync/session-deletion-worker.ts" \
  "./src/services/workspace/service.ts" \
  "./__tests__/account-deletion-state.test.ts" \
  "./__tests__/account-deletion-client.test.ts" \
  "./__tests__/delete-account-backend.test.ts" \
  "./__tests__/account-deletion-local-cleanup.test.ts" \
  "./__tests__/local-account-cleanup-repository.test.ts" \
  "./__tests__/account-deletion-auth-cleanup.test.ts" \
  "./__tests__/account-deletion-quiescence.test.ts" \
  "./__tests__/account-deletion-boundary.test.ts" \
  "./__tests__/account-deletion-worker-gate.test.ts" \
  --max-warnings=0

npx expo-doctor
```

Also validate localization JSON and parity:

```bash
node - <<'NODE'
const fs = require("fs");
for (const file of [
  "src/i18n/en/profile.json",
  "src/i18n/id/profile.json",
  "src/i18n/en/errors.json",
  "src/i18n/id/errors.json",
]) {
  JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`Valid JSON: ${file}`);
}
NODE
```


Before manual client tests, redeploy the development Edge Function because the
structured safe-error response now includes `gateActive`:

```bash
cd /app
npx supabase functions deploy delete-account
```

Do not use `--no-verify-jwt`.

## 4. Marker read failure fails closed

The focused marker tests simulate a corrupt marker and a native AsyncStorage
read failure. Expected:

```text
private coordinators/routes remain unmounted
privacy-check error screen is shown
Retry re-reads the marker
corrupt non-empty state is not silently erased
```

## 5. Confirmation and recording guard

1. Open Profile → Delete Account.
2. Enter anything except exact uppercase `DELETE`.
3. Verify the destructive button remains disabled and the function is not
   invoked.
4. Start a recording and return to the delete screen.
5. Verify deletion is blocked until recording is stopped or discarded.

## 6. Server blocker behavior

Use a disposable account deliberately configured with a backend blocker.
Invoke from the UI.

Expected:

```text
server returns safe 409 blocker
local SQLite/files remain intact
marker can be cleared with Return to Profile
workers resume only after marker removal
```

## 7. Reauthentication behavior

Use a session older than the backend recent-auth window.

Expected:

```text
Sign in again screen
no local data deletion
Sign out action clears only the matching session and marker
user must sign in freshly and start deletion again
```

## 8. Successful destructive flow

Prepare a disposable user with:

```text
at least 1 owned personal workspace
at least 1 project/session
recording and evidence files in private Storage
matching local SQLite rows and durable local files
no collaboration blockers
```

Before deletion, record safe counts and app-owned local paths. From Profile:

```text
Delete Account
→ type DELETE
→ confirm destructive alert
```

Expected immediately:

```text
private app UI is replaced by deletion status screen
Back cannot reopen Library/session/project routes
new sync/upload work is not claimed
```

Expected after server and local cleanup:

```text
Welcome screen
Auth user = 0
owned workspaces = 0
Storage objects = 0
account_deletion_requests = 0
matching local SQLite rows = 0
matching app-owned local files do not exist
workspace cache removed
deleted account cannot sign in
```

## 9. Crash/restart recovery

Use another disposable account.

After the server returns success but while the app shows local cleanup, force
close the app. On restart:

```text
private routes never render
persistent marker is loaded before coordinators/root navigator
local cleanup resumes automatically
Welcome appears only after cleanup and session removal
marker is removed last
```

Repeat a force close during `retryable_error` and verify retry remains available
without restarting normal workers.

## 10. Shared-device isolation

On a test device with cached data from User A and User B:

1. Delete User A.
2. Verify User A's profile, owned workspace graph, queues, files, and workspace
   cache are removed.
3. Verify User B's unrelated SQLite rows and external/content URIs remain.
4. If User B is already signed in during recovery of an old User A marker,
   verify User B's Supabase session is preserved.

## 11. Network and partial-failure behavior

- Offline before invocation: marker remains retryable and local data is not
  deleted.
- Ambiguous network response after server deletion: account existence check
  detects the missing Auth user and advances to local cleanup.
- Worker idle timeout: safe retry error, no server invocation.
- Local file/SQLite failure after server success: marker remains
  `local_cleanup_failed`, private UI stays hidden, retry resumes cleanup.

## 12. Git audit

The final Phase 5B staged diff contains 44 files after the security follow-up.

Before commit:

```bash
git diff --cached --name-only
git diff --cached --check
git diff --name-only
```

Do not stage `.env`, `.emergent`, patch/ZIP files, `package-lock.json`, tokens,
or `supabase/.temp/` metadata.

## 13. Interrupted server request with missing or changed session

Simulate or unit-test a marker with:

```text
status = in_progress
serverRequestStartedAt != null
serverDeletionConfirmedAt = null
```

Then initialize Auth with either no user or a different User B. Expected:

```text
private routes remain hidden
User A local SQLite/files are cleaned idempotently
User B session is preserved when present
marker is not removed before local cleanup finishes
local_cleanup_complete_server_unverified is shown
Continue safely clears the marker only after user acknowledgment
```

## 14. Durable-gate error classification

Verify both structured responses:

```text
ACCOUNT_DELETION_TOO_LARGE + gateActive=false
→ safe blocked screen may Return to Profile

ACCOUNT_DELETION_TOO_LARGE + gateActive=true
→ retry/privacy boundary remains active
→ Return to Profile is not available
```

Redeploy the development `delete-account` function before this test because the
safe error payload now includes `gateActive`.

## 15. Local Auth storage verification failures

Focused tests must prove:

```text
getSession before sign-out: session=null + error
→ signOut not called
→ local cleanup fails closed

getSession after sign-out: session=null + error
→ not treated as cleared
→ marker remains

getSession after sign-out: session=null + no error
→ cleared
```

## 16. Reauthentication after a prior server attempt

Create or mock a marker with `serverRequestStartedAt` set and a retryable
status, then make the next server attempt return
`ACCOUNT_DELETION_REAUTHENTICATION_REQUIRED`. Expected:

```text
marker keeps server-request evidence
privacy-first local cleanup runs
marker is not cleared through the ordinary sign-out flow
cloud deletion is never described as confirmed
```

Also verify that an unavailable Supabase client and session-storage read errors
fail closed and leave the marker available for retry.

## 17. Marker persistence failure after server request start

Focused state tests must prove that when an older fallback marker has no
`serverRequestStartedAt` but the latest successfully persisted marker does, a
workflow persistence failure keeps the newer timestamp and enters
`retryable_error`. Retrying must never overwrite the durable marker with the
older pre-request state.
