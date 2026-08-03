# Delete Account Backend Foundation v1

## Scope

This milestone adds the trusted server-side deletion primitive for Project
Recall. It deliberately does **not** add the mobile/web Delete Account screen or
local SQLite/file cleanup. Those belong to the next milestone.

The implementation is an authenticated Supabase Edge Function:

```text
supabase/functions/delete-account
```

No PostgreSQL migration is added. The live development schema was audited
before implementation:

- application rows that point directly to `auth.users` with `NO ACTION` are
  also scoped to `public.workspaces` with `ON DELETE CASCADE`;
- `profiles`, workspace ownership/membership, upload queue records, and
  session-user preferences cascade from `auth.users`;
- the `session-assets` bucket is private;
- the remote migration ledger is empty even though migrations `0001`-`0006`
  are present locally and the live schema is applied. Do not run `db push`,
  `migration repair`, or `db reset` as part of this milestone.

## Security boundary

The client never sends a user ID. The function derives the current user from a
platform-verified user JWT and verifies it again with Supabase Auth.

The endpoint requires:

- HTTP `POST`;
- `Authorization: Bearer <user access token>`;
- exact confirmation phrase `DELETE`;
- a recent interactive authentication method reference, no older than 15
  minutes. A token refresh does not count as recent reauthentication.

The function is configured with `verify_jwt = true`. Do not deploy or serve it
with `--no-verify-jwt`.

Privileged credentials are read only inside the Edge Function from Supabase's
default server-side environment variables. No secret/service-role key is
included in frontend code, EAS variables, GitHub, or function responses.

## Conservative deletion policy

Automatic deletion is blocked when any of these conditions exists:

- an owned workspace has another non-removed member;
- the user is a non-removed member of a workspace they do not own;
- the user created project/session/content in a workspace they do not own;
- another user created content inside a workspace owned by the deleting user;
- a user-owned Storage object belongs to an existing non-owned workspace;
- the user owns an object in a bucket other than `session-assets`;
- an object in an owned workspace belongs to another user;
- an object in an owned workspace has no owner ID;
- the deletion Storage scope exceeds 10,000 objects.

The conservative policy avoids silently deleting shared/team data or files
whose ownership cannot be proven. It also fails before destructive work if a
future bucket contains user-owned files that this version does not know how to
clean safely.

## Storage retry model

The deletion scope contains:

1. user-owned objects below the user's currently owned workspace prefixes;
2. user-owned orphan objects whose first path segment no longer resolves to an
   existing workspace.

The second rule makes retries safe after a prior attempt deleted a workspace
but failed before all Storage objects were removed. A user-owned object below
an existing non-owned workspace remains a blocker.

Object paths are read from the database, validated, and removed through the
Supabase Storage API in batches of at most 1,000. Storage rows are never deleted
with SQL.

## Ordered execution

```text
JWT gateway validation
→ exact confirmation
→ recent-authentication check
→ Auth getUser verification
→ database/storage preflight
→ initial Storage cleanup
→ verify Storage scope is empty
→ transactional blocker re-check
→ delete owned workspaces
→ residual Storage cleanup (closes in-flight upload race)
→ verify Storage scope is empty
→ verify no NO ACTION references remain
→ auth.admin.deleteUser(current user)
```

The function is idempotent for the supported partial states:

- if the Auth user is already missing, it returns `already_deleted`;
- if owned workspaces were deleted by a previous attempt, user-owned orphan
  Storage objects remain in the retry scope;
- repeated calls in the same Edge isolate are coalesced by user ID;
- database preflight and workspace deletion are rechecked transactionally;
- owned workspace rows are locked before the final preflight so new child
  rows cannot be attached during the cascade-delete decision.

A failure after some destructive steps is reported as retryable when safe.
The next milestone must persist a local cleanup/deletion marker and retry the
server operation before removing local data.

## Files

```text
.gitignore
supabase/config.toml
supabase/functions/delete-account/core.ts
supabase/functions/delete-account/database.ts
supabase/functions/delete-account/deno.json
supabase/functions/delete-account/index.ts
frontend/__tests__/delete-account-backend.test.ts
docs/DELETE_ACCOUNT_BACKEND_V1_IMPLEMENTATION.md
docs/DELETE_ACCOUNT_BACKEND_V1_TEST.md
```

## Out of scope

- Delete Account UI;
- local SQLite and durable-file cleanup;
- client invocation service;
- local crash-recovery marker;
- team workspace ownership transfer;
- anonymizing shared content;
- database migration or migration-ledger repair;
- scheduled/background deletion jobs.
