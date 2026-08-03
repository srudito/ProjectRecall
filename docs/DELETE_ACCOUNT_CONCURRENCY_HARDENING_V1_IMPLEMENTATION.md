# Delete Account Concurrency and Retry Hardening v1

## Scope

This milestone hardens the deployed Delete Account backend foundation before a
user-facing Delete Account screen is added. It closes the two release gates
identified by the Phase 5A security review:

1. a workspace or content write could race with the final delete decision;
2. an Edge Function crash or retry from another isolate had no durable
   cross-request ownership state.

The milestone remains backend-only. It does not add the Profile UI or local
SQLite/file cleanup.

## Migration 0007

`supabase/migrations/0007_account_deletion_gate.sql` adds:

```text
public.account_deletion_requests
```

The row is keyed by `user_id` and stores:

- the current request/lease ID;
- `processing` or `retryable_failed` status;
- the original set of preflighted workspace IDs;
- attempt count and timestamps;
- a renewable lease expiry;
- a safe last error code.

The row references `auth.users(id) ON DELETE CASCADE`, so successful Auth user
deletion removes the gate automatically.

The live project has an empty Supabase CLI migration ledger even though
migrations `0001`-`0006` are applied. Migrations `0007` through `0011` were
applied through the Supabase SQL Editor and must not be edited or replayed.
Each follow-up migration closes a separately verified release gate. Do not run
`db push`, `migration repair`, or replay older migrations.

## Distributed write gate

The migration creates a deterministic advisory-lock key per Auth user.
Authenticated/direct writes take a shared transaction advisory lock. A
Delete Account attempt takes the corresponding exclusive transaction lock
before it activates the durable gate.

This ordering provides the required barrier:

```text
in-flight guarded writes finish
→ exclusive deletion transaction acquires the lock
→ preflight runs again
→ durable gate row is committed
→ later writes acquire the shared lock and are rejected
```

A generic `BEFORE INSERT OR UPDATE` trigger protects:

- profiles and workspaces;
- workspace membership;
- projects, sessions, recordings, media, notes, bookmarks, and timeline;
- upload/processing records;
- transcription foundation tables;
- session user preferences.

The trigger checks the authenticated actor, row actor fields, and the owner of
the referenced workspace. On UPDATE it checks both OLD and NEW ownership, so a
row cannot be moved away from a deleting user/workspace to escape the gate.
This also protects trusted direct database writers that bypass RLS.

Storage mutation policies are replaced so insert/update/delete operations call
`public.can_write_workspace()`. Storage reads remain membership-based.
Service-role Storage writes remain trusted backend operations and must not be
used by untrusted clients.

## Session/workspace scope integrity (migration 0008)

Session-scoped tables commonly store both `workspace_id` and `session_id`. The
write guard now resolves both values independently, requires the workspace IDs
to match, and includes both workspace owners in the shared advisory-lock set.
A mismatch fails with the stable database error:

```text
WORKSPACE_SESSION_SCOPE_MISMATCH
```

Before replacing the trigger function, migration `0008` audits existing rows
in recordings, evidence/content, upload-queue, and processing tables. The
migration aborts without applying changes if legacy mismatches exist. Direct
`EXECUTE` privilege on the trigger function is also revoked from `PUBLIC`; the
function remains available through its existing triggers.


## Trigger-function privileges (migration 0009)

The development project retained explicit `EXECUTE` grants for `anon` and
`authenticated` after migration `0008` revoked `PUBLIC`. Migration
`0009_guard_function_privileges.sql` revokes direct execution from `PUBLIC`,
`anon`, and `authenticated`. The trigger remains usable by PostgreSQL during
normal table writes, while application roles cannot invoke the
security-definer trigger function directly.

## Final helper-privilege and session-parent hardening (migration 0010)

Migration `0010_account_deletion_gate_final_hardening.sql` removes direct
application-role execution from internal security-definer helpers while
preserving authenticated access to `can_write_workspace()` for Storage RLS.
The verified privilege matrix is:

```text
account_deletion_lock_key      anon=false authenticated=false service_role=true
is_account_deletion_active     anon=false authenticated=false service_role=true
lock_accounts_for_write        anon=false authenticated=false service_role=true
can_write_workspace            anon=false authenticated=true  service_role=true
guard_account_deletion_write   anon=false authenticated=false service_role=true
```

The same migration makes `sessions.workspace_id` immutable. Project Recall has
no supported cross-workspace session-move flow, and immutability prevents a
parent session from being reparented while its recordings, notes, evidence,
and timeline rows still reference the original workspace.

## Trigger record safety (migration 0011)

Migration `0011_guard_trigger_record_safety.sql` replaces direct
`OLD.workspace_id`/`NEW.workspace_id` dereferences with `to_jsonb(OLD)` and
`to_jsonb(NEW)` access. The write guard is attached to tables with different
row shapes, including `profiles`, so direct field dereferences could abort
signup and bootstrap transactions. The live regression verified that a new
email account can again create its Auth user, profile, personal workspace, and
owner membership.

## Durable lease and retry

The Edge Function now starts an attempt in a database transaction that:

1. takes the exclusive user advisory lock;
2. rejects another unexpired processing lease;
3. re-runs the conservative preflight;
4. records the original workspace ID set;
5. activates a renewable 15-minute lease.

The core renews the lease before destructive phases and Storage batches.
If a destructive step fails, the request becomes `retryable_failed`, the gate
remains active, and a future recently-authenticated invocation can take over.

Retries preserve the original workspace IDs even after workspace rows have
already been deleted. This allows residual user-owned orphan Storage paths to
be discovered and removed safely.

## Safer workspace deletion

The final workspace transaction:

- takes the same exclusive advisory lock;
- verifies the durable request and lease owner;
- re-runs preflight;
- rejects any newly-owned workspace outside the original set;
- deletes only the preflighted workspace IDs, never every row matching the
  owner predicate.

This removes the previous TOCTOU risk where a newly-created workspace could be
silently included by `DELETE ... WHERE owner_user_id = user`.

## Edge Function behavior

Concurrent calls in the same Edge isolate are still coalesced in memory. Calls
from different isolates are now coordinated by the database lease:

```text
first valid attempt   → processing lease
second active attempt → ACCOUNT_DELETION_IN_PROGRESS (retryable)
stale/failed attempt  → later invocation may safely resume
```

The public response remains narrow and token-free.

## Files

```text
supabase/migrations/0007_account_deletion_gate.sql
supabase/migrations/0008_workspace_scope_integrity.sql
supabase/migrations/0009_guard_function_privileges.sql
supabase/migrations/0010_account_deletion_gate_final_hardening.sql
supabase/migrations/0011_guard_trigger_record_safety.sql
supabase/functions/delete-account/core.ts
supabase/functions/delete-account/database.ts
supabase/functions/delete-account/index.ts
frontend/__tests__/delete-account-backend.test.ts
frontend/__tests__/account-deletion-gate-migration.test.ts
docs/DELETE_ACCOUNT_CONCURRENCY_HARDENING_V1_IMPLEMENTATION.md
docs/DELETE_ACCOUNT_CONCURRENCY_HARDENING_V1_TEST.md
docs/DELETE_ACCOUNT_BACKEND_V1_IMPLEMENTATION.md
docs/DELETE_ACCOUNT_BACKEND_V1_TEST.md
docs/DATABASE.md
```

## Out of scope

- Delete Account UI;
- client function invocation;
- crash-safe local cleanup marker;
- SQLite and durable local-file cleanup;
- team-workspace ownership transfer;
- anonymization of shared content;
- migration-ledger repair;
- production enablement before Phase 5B/5C verification.
