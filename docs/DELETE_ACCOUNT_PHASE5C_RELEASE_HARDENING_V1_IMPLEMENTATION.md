# Delete Account Phase 5C Release Hardening v1

## Scope

This follow-up hardens the already approved Phase 5B client flow for release
verification. It does not change the deployed Edge Function protocol or the
PostgreSQL migrations.

The change closes three Phase 5C concerns:

1. a remounted root boundary must resynchronize with an account-deletion
   workflow already running in the same JavaScript process;
2. shared-device cleanup must not expand through a user-authored session in a
   non-owned workspace and erase cached rows belonging to another user;
3. scoped SQLite deletion must overwrite deleted cell content and truncate the
   WAL before the persistent account-deletion marker can be removed.

## Same-process remount recovery

`AccountDeletionBoundary` still uses the persistent AsyncStorage marker as the
authoritative crash-recovery state. When a new boundary instance mounts while
`activeWorkflow` is already running, it now observes that promise and reloads
the durable marker after the workflow settles.

This avoids a stale status screen after an unusual root remount or development
Fast Refresh. It does not start a second server request or local cleanup.

## Shared-workspace cache isolation

Whole-session cleanup is now limited to sessions whose `workspace_id` is in
the deleted account's known owned-workspace set. A session merely authored by
the deleted user in a non-owned/shared workspace no longer expands the cleanup
scope through `session_id`.

The cleanup still removes user-specific rows in shared workspaces through
explicit ownership columns:

- `created_by` for notes, bookmarks, and timeline rows;
- `added_by` for evidence metadata;
- `user_id` for queues and per-user preferences.

Projects, sessions, recordings, and child rows belonging to other users remain
cached when their workspace is not owned by the deleted account. This keeps a
second user's local cache intact on a shared device.

## SQLite privacy hardening

The shared SQLite connection enables:

```sql
PRAGMA secure_delete = ON;
```

before migrations and normal repository use. After the scoped account-cleanup
transaction commits, the repository runs:

```sql
PRAGMA wal_checkpoint(TRUNCATE);
```

A busy or missing checkpoint result is treated as a local-cleanup failure. The
persistent deletion marker therefore remains in place and private routes stay
hidden until the checkpoint can be retried.

Automatic `VACUUM` is intentionally not used. It can be expensive, rewrites the
entire shared-device database, and is unnecessary for rows deleted while
`secure_delete` is active. Phase 5C verifies the checkpoint path instead.

## Files

```text
frontend/src/components/AccountDeletionBoundary.tsx
frontend/src/services/sqlite/schema.ts
frontend/src/services/sqlite/repository.ts
frontend/__tests__/account-deletion-boundary.test.ts
frontend/__tests__/local-account-cleanup-repository.test.ts
docs/DELETE_ACCOUNT_UI_LOCAL_CLEANUP_V1_IMPLEMENTATION.md
docs/DELETE_ACCOUNT_UI_LOCAL_CLEANUP_V1_TEST.md
docs/DELETE_ACCOUNT_PHASE5C_RELEASE_HARDENING_V1_IMPLEMENTATION.md
docs/DELETE_ACCOUNT_PHASE5C_RELEASE_HARDENING_V1_TEST.md
docs/DATABASE.md
```

## Out of scope

- changing migrations `0001`-`0012`;
- changing the deployed `delete-account` Edge Function;
- enabling team/shared-workspace product UI;
- migration-ledger reconciliation;
- whole-database deletion or automatic `VACUUM`.

## Authoritative local cleanup scope gate

Cloud account deletion never starts unless the client has at least one valid
owned-workspace identifier for scoped local cleanup. The client combines the
workspace IDs already present in SQLite with the resolved personal workspace.
If both sources are unavailable or empty, marker persistence is skipped and the
operation fails with `ACCOUNT_DELETION_LOCAL_STATE_FAILED`. Workers remain
active, the Edge Function is not invoked, and the user can retry after local or
network state recovers. A validated SQLite workspace remains sufficient when
the personal-workspace lookup is temporarily unavailable.
