# Delete Account Phase 5C Release Hardening v1 - Verification

Use only the development Supabase project and disposable accounts.

## 1. Automated validation

From `frontend/`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/account-deletion-boundary.test.ts \
  __tests__/account-deletion-local-cleanup.test.ts \
  __tests__/local-account-cleanup-repository.test.ts \
  __tests__/account-deletion-state.test.ts \
  __tests__/account-deletion-auth-cleanup.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  "./src/components/AccountDeletionBoundary.tsx" \
  "./src/services/sqlite/schema.ts" \
  "./src/services/sqlite/repository.ts" \
  "./__tests__/account-deletion-boundary.test.ts" \
  "./__tests__/local-account-cleanup-repository.test.ts" \
  --max-warnings=0

npx expo-doctor
```

Expected: TypeScript, focused Jest, full Jest, ESLint, and Expo Doctor all pass.

## 2. Same-process remount

The focused boundary test verifies that a boundary mounting while
`activeWorkflow` is non-null observes the existing promise and reloads the
persistent marker when it settles.

Manual development check:

1. Start disposable-account deletion.
2. Trigger a development Fast Refresh while the deletion status screen is
   visible.
3. Verify no second browser/server deletion request starts.
4. Verify the screen advances after the existing workflow completes.
5. Verify private routes never render during the remount.

## 3. Shared-device cache isolation

Prepare a local test database containing:

- owned Workspace A and Session A for User A;
- non-owned/shared Workspace B;
- a session in Workspace B authored by User A;
- notes/media/timeline rows on that shared session authored by User B;
- at least one note/media row on the same session authored by User A.

Run User A local cleanup with only Workspace A in the owned-workspace marker
scope.

Expected:

```text
User A profile and owned Workspace A graph removed
User A-authored note/media rows in Workspace B removed
Workspace B project/session preserved
User B-authored child rows on the shared session preserved
shared-session recording rows and session directory preserved
User B session and unrelated preferences preserved
```

The repository tests also assert that user authorship alone no longer adds a
session to the whole-session cleanup scope.

## 4. SQLite secure deletion and WAL checkpoint

The repository tests verify:

```text
PRAGMA secure_delete = ON is enabled before migrations
scoped account rows are deleted in one serialized transaction
PRAGMA wal_checkpoint(TRUNCATE) runs after commit
busy checkpoint causes a safe retryable cleanup failure
```

Manual native check after a disposable deletion:

1. Confirm the app reaches Welcome only after local cleanup.
2. Force-close and reopen the same development build without uninstalling.
3. Confirm private routes do not return.
4. Confirm the deletion marker is gone only after cleanup completes.

Do not use uninstall or Clear Data as a crash-recovery test; both erase the
marker and local database externally.

## 5. Existing Phase 5B regressions

Repeat the release-critical checks:

```text
confirmation mismatch -> no invocation
gateActive=false blocker -> safe Return to Profile
gateActive=true/null -> privacy boundary remains
worker timeout -> no server invocation
server success + force-close -> cleanup resumes to Welcome
deleted account cannot sign in
Android Back/deep link cannot reveal private content
```

## 6. Fresh migration smoke test

Migrations `0007`-`0012` are already applied in the development project and
must not be replayed there. Use a disposable Supabase project or isolated local
Postgres environment to smoke-test a fresh migration sequence. Apply `0010`
and `0011` in one uninterrupted deployment batch.

## 7. Git audit

Before commit:

```bash
git diff --cached --name-only
git diff --cached --check
git diff --name-only
```

Never stage `.env`, `.emergent`, patch/ZIP files, `package-lock.json`, tokens,
or `supabase/.temp/` metadata.

## Owned-workspace scope preparation

Automated coverage must prove all three cases:

1. SQLite workspace scope empty and personal-workspace lookup fails: marker is
   not persisted and deletion fails with
   `ACCOUNT_DELETION_LOCAL_STATE_FAILED`.
2. SQLite scope empty and personal workspace resolves: the persisted marker
   contains that workspace ID.
3. SQLite already contains an owned workspace and cloud resolution fails: the
   marker is still persisted with the validated local workspace.

Invariant: a cloud account deletion must never begin unless the client has at
least one validated owned-workspace identifier for scoped local cleanup.
