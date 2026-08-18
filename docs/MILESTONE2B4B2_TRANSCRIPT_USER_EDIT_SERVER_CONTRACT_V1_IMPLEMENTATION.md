# Milestone 2B.4B.2 — Transcript User-Edit Server Contract v1

## Purpose

This milestone adds the server-side contract required for future local-first
transcript editing. A user edit creates a new immutable transcript version; it
never overwrites the provider transcript or mutates timestamp evidence.

Implementation base source:
`217d89a44a6827e437e80999bb6370b55228c854` on `milestone1sync`.

Final development-closure source:
`16e90555ccb950e4adbc9f257646419eace09740` on `milestone1sync`.

Milestone 2B.4B.1 was a read-only architecture audit. It confirmed that remote
`transcript_versions`, `transcript_segments`, the one-current-version index,
parent lineage, checksums, RLS reads, and SQLite result cache already provide a
usable foundation. It also confirmed that direct authenticated transcript writes
must remain closed and that a narrow RPC is required.

## Append-only database change

Migration `0016_transcript_user_edit_versioning_v1.sql` adds:

- a `user_edit` shape constraint requiring a final, non-empty, checksummed row
  with a parent version;
- a self-parent rejection constraint;
- an index for parent-version traversal;
- an immutable-content trigger for transcript versions;
- `create_transcript_user_edit_version_v1(...)`, a narrow authenticated RPC.

Migrations `0013`, `0014`, and `0015` are not edited or rerun.

## RPC contract

The RPC accepts only:

```text
session_id
expected_current_version_id
client_version_id
plain_text
```

`client_version_id` is a stable UUID generated before upload. It is both the
remote transcript-version ID and the durable idempotency key for that save.
The server computes the SHA-256 checksum; the client does not supply one.

A successful new save:

```text
lock account-write boundary
→ verify transcription feature enabled
→ verify active workspace membership
→ lock session row
→ lock current final transcript version
→ verify expected current version
→ allocate max(version) + 1
→ demote the previous current version
→ insert one final user_edit version
→ make the new version current
→ commit atomically
```

The new version inherits the current version's nullable transcription-run
reference and language summary, records `created_by = auth.uid()`, sets
`parent_version_id` to the observed current version, and stores no timestamp
segments.

## Idempotency and conflict behavior

Idempotent replay is checked before stale-base comparison. Repeating the same
`client_version_id`, parent ID, caller, and exact text returns the already
committed version even when a later edit has since become current.

Reusing a client UUID with a different caller, session, parent, or text fails
with `TRANSCRIPT_EDIT_IDEMPOTENCY_CONFLICT`.

A new UUID based on a version that is no longer current fails with
`TRANSCRIPT_EDIT_BASE_CONFLICT`. The RPC never performs last-write-wins and does
not auto-merge concurrent edits.

Saving text identical to the current version fails with
`TRANSCRIPT_EDIT_UNCHANGED` rather than creating meaningless history.

## Serialization with provider completion

The existing provider completion function locks the session row before it
allocates a version number and switches `is_current`. The user-edit RPC uses the
same session-row lock. Provider completion and user editing therefore cannot
allocate the same version number or both commit as current.

## Security boundary

Authenticated clients keep `SELECT`-only table privileges. Migration 0016 does
not add transcript-table INSERT or UPDATE policies or grants.

The RPC is `SECURITY DEFINER`, has an empty search path, and is executable only
by `authenticated`. It explicitly checks:

- `auth.uid()`;
- the server-side `transcription_enabled` feature flag;
- an available, non-deleting session;
- `can_write_workspace(...)`, which provides active-membership validation and
  the existing account-deletion shared-lock boundary.

No service-role key, provider key, worker token, database password, or privileged
credential crosses into the mobile app.

## Immutable version behavior

After insert, transcript identity, scope, version number, origin, status,
parent, text, language summary, checksum, and creation timestamp cannot change.

The guard deliberately still permits:

- `is_current` and `updated_at` changes used by atomic current switching;
- `transcription_run_id` changing from a UUID to null through the existing
  `ON DELETE SET NULL` provenance relationship;
- `created_by` changing from a UUID to null through its existing auth-user
  deletion relationship.

Deletes remain allowed so session/workspace/account cleanup continues to work.

## Timestamp evidence boundary

The RPC does not copy or synthesize `transcript_segments`. Arbitrary edited text
cannot be honestly mapped to provider timestamps without a separate reviewed
editing model. The original provider version and its timestamp segments remain
unchanged.

A later mobile milestone will display edited Full Text while clearly retaining
provider timestamps as source evidence from the appropriate ancestor version.

## Deferred scope

This milestone does not add:

- SQLite draft or outbox tables;
- transcript version pull/sync;
- editor UI;
- version history or restore UI;
- segment or timestamp editing;
- auto-merge;
- Edge Functions, worker changes, Cron changes, provider calls, or secrets;
- production activation.

Development rollout is complete. Migration 0016 was applied exactly once
after read-only precondition review. Post-apply schema/security checks passed,
and the rollback-wrapped behavior test passed after a test-only PL/pgSQL fixture
correction using `#variable_conflict use_variable`. The test left no verification
rows behind. Worker v8 was not redeployed, production remains untouched, and
migration 0016 must not be rerun.
