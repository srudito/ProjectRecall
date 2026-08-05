# Delete Account UI and Crash-Safe Local Cleanup v1

## Scope

Phase 5B exposes the already deployed and hardened `delete-account` Edge
Function through the authenticated Profile UI and adds crash-safe local cleanup.
It does not change the server deletion protocol from Phase 5A/5A.1.

The user flow is:

```text
Profile → Danger Zone → Delete Account
→ type exact DELETE
→ native/web destructive confirmation
→ persist local deletion marker
→ stop new sync/upload claims
→ discard active recorder state
→ wait for already-running workers to finish
→ invoke authenticated delete-account Edge Function
→ mark server deletion complete locally
→ delete app-owned recording/evidence files
→ delete only the deleted account's SQLite graph
→ clear workspace and query caches
→ clear OAuth/password-recovery transient state
→ remove only the deleted user's persisted Supabase session
→ remove marker last
→ Welcome
```

## Persistent local marker

`frontend/src/services/account-deletion/state.ts` stores a narrow AsyncStorage
marker under:

```text
account.deletion.pending.v1
```

The marker contains only:

- deleted user UUID;
- locally known owned workspace UUIDs;
- status and timestamps;
- retry count;
- safe application error code;
- safe blocker codes.

It never stores email, password, JWT, access token, refresh token, provider
token, callback URL, raw server response, or raw error object. Marker reads and
writes use AsyncStorage directly so storage failures are distinguishable from a
missing marker. A non-empty corrupt marker or read failure fails closed: private
routes remain hidden behind a retryable privacy-check screen instead of erasing
the marker and resuming the application.

The marker is persisted before workers are stopped or the server is invoked.
It is removed only after all local files, SQLite rows, caches, transient auth
state, and the deleted user's local Supabase session have been cleared. A
process crash therefore resumes the idempotent workflow on the next launch.

## Root privacy boundary

`AccountDeletionBoundary` wraps the recording coordinator, sync coordinator,
and root navigator. Until both the deletion marker and persisted auth session
finish loading, it renders only a neutral loading screen.

When a marker exists, private routes and coordinators are not mounted. The
boundary displays a dedicated status screen and automatically resumes either:

- server deletion; or
- local cleanup after server success.

This prevents Back navigation or a cold-start route from briefly exposing
project/session content after permanent server deletion.

## Authenticated function invocation

`invokeDeleteAccount(expectedUserId)`:

1. reads the current Supabase session;
2. requires the session user UUID to match the persistent marker;
3. sends the captured bearer token explicitly to the `delete-account`
   function;
4. accepts only the narrow server response shape;
5. maps server error codes and blockers to safe application errors;
6. never returns Session, User, token, raw function error, or raw response
   fields to UI code.

An ambiguous network error is followed by a safe `getUser()` existence check.
If the Auth user is already missing, the workflow advances to local cleanup.
Otherwise the marker remains retryable and all private UI stays hidden.

## Worker quiescence

The metadata, recording upload, media upload, and session deletion workers now:

- refuse to start/claim more work while the local deletion marker exists;
- check the marker between claims;
- expose `waitForIdle()` for the deletion boundary.

The lifecycle sync coordinator also refuses to schedule work while deletion is
pending. Phase 5B waits for already-running work with a bounded timeout before
calling the server or deleting local data.

## Scoped SQLite cleanup

`collectLocalAccountCleanupScope()` derives:

- known owned workspace IDs from the deleted user's local profile plus the
  marker scope;
- sessions created by the deleted user or inside those owned workspaces;
- media assets created by the deleted user or in the owned session graph;
- recording/evidence/upload file URIs;
- JSON file URI lists retained by the durable session-deletion queue.

Whole-workspace deletion is intentionally limited to workspace IDs known to be
owned. A user-authored note or upload in a shared workspace does not cause all
other cached rows for that workspace to be removed on a shared device.

The cleanup transaction deletes the deleted user's profile, projects, sessions,
recordings, evidence metadata, notes, bookmarks, timeline events, upload
queues, metadata queues, session deletion queue, and per-user session
preferences. Device-wide app preferences, migration metadata, and another
user's unrelated rows are preserved.

## Local file cleanup

Before deleting SQLite metadata, the app removes:

- app-owned `file://` recording/evidence/upload URIs below the Expo document or
  cache directory;
- durable `sessions/<session-id>` directories;
- cached `evidence-open/<media-id>_*` files.

External `content://` URIs and file paths outside the app document/cache roots
are never deleted. Session-directory and evidence-cache identifiers must also
be valid UUIDs before they are interpolated into local paths, preventing corrupt
SQLite identifiers from expanding the deletion scope. File cleanup is
idempotent so it can safely run again after a crash.

## Shared-device session safety

`clearLocalAuthSession(expectedUserId)` removes only the matching deleted
user's persisted session. If another user is already signed in, that session is
preserved. If local logout reports a server-side error after the Auth row has
already been deleted, cleanup succeeds only when the SDK confirms the matching
local session is gone.

## Recording safety

The Delete Account button is disabled while the recorder is preparing,
recording, paused, or stopping. The deletion boundary also discards controller
state before quiescing background work, providing defense in depth.

## Migration 0012

`0012_profile_account_deletion_gate.sql` closes the non-blocking release gate
from the Phase 5A.1 review. Profiles use `profiles.id` as the Auth user UUID and
therefore need a profile-specific trigger to acquire the shared account lock and
reject profile insert/update while a durable deletion request is active.

The generic migrations `0007`–`0011` are not edited or replayed.

## Files

```text
frontend/app/account/delete.tsx
frontend/app/(tabs)/profile.tsx
frontend/app/_layout.tsx
frontend/src/components/AccountDeletionBoundary.tsx
frontend/src/navigation/RootStack.tsx
frontend/src/services/auth/route-access.ts
frontend/src/services/account-deletion/client.ts
frontend/src/services/account-deletion/local-cleanup.ts
frontend/src/services/account-deletion/quiescence.ts
frontend/src/services/account-deletion/state.ts
frontend/src/services/sqlite/repository.ts
frontend/src/services/supabase/auth.ts
frontend/src/services/sync/ProjectSyncCoordinator.tsx
frontend/src/services/sync/project-sync-worker.ts
frontend/src/services/sync/recording-upload-worker.ts
frontend/src/services/sync/media-upload-worker.ts
frontend/src/services/sync/session-deletion-worker.ts
frontend/src/services/workspace/service.ts
frontend/src/domain/errors.ts
frontend/src/i18n/en/profile.json
frontend/src/i18n/id/profile.json
frontend/src/i18n/en/errors.json
frontend/src/i18n/id/errors.json
frontend/__tests__/account-deletion-*.test.ts
frontend/__tests__/delete-account-backend.test.ts
frontend/__tests__/local-account-cleanup-repository.test.ts
frontend/__tests__/root-stack.test.tsx
frontend/__tests__/account-deletion-gate-migration.test.ts
frontend/jest.setup.js

supabase/functions/delete-account/core.ts
supabase/functions/delete-account/database.ts
supabase/functions/delete-account/index.ts
supabase/migrations/0012_profile_account_deletion_gate.sql
docs/DATABASE.md
docs/DELETE_ACCOUNT_BACKEND_V1_IMPLEMENTATION.md
docs/DELETE_ACCOUNT_UI_LOCAL_CLEANUP_V1_IMPLEMENTATION.md
docs/DELETE_ACCOUNT_UI_LOCAL_CLEANUP_V1_TEST.md
```

## Out of scope

- ownership transfer for team workspaces;
- anonymizing shared content;
- production exposure before Phase 5C destructive/restart verification;
- migration-ledger reconciliation;
- scheduled deletion jobs;
- changing migrations `0001`–`0011`.

## Interrupted server-request and durable-gate follow-up

A persisted marker now distinguishes three server states:

- `serverRequestStartedAt` records that the client handed control to the
  authenticated Edge Function;
- `serverDeletionConfirmedAt` records a confirmed `deleted`,
  `already_deleted`, or missing-Auth-user result;
- a started request without confirmation is treated as an unverified server
  outcome.

If the app restarts after a request started and the deleted account session can
no longer be loaded, Project Recall performs privacy-first, idempotent local
cleanup instead of clearing the marker through the reauthentication path. The
marker remains until local cleanup completes. The user then acknowledges a
safe status screen explaining that cloud deletion could not be verified. A
second user's active session is preserved on shared devices.

The Edge Function error contract now contains an explicit `gateActive` boolean.
The UI exposes Return to Profile only for a confirmed preflight error with
`gateActive: false`. Errors raised after a durable deletion request exists keep
the privacy boundary and retry flow active, including late
`ACCOUNT_DELETION_TOO_LARGE` failures.

Local Supabase session cleanup is also fail-closed. A null session accompanied
by a storage/read error is not accepted as proof that no session exists, and a
post-sign-out read error does not allow the deletion marker to be removed.

## Reauthentication after an earlier server attempt

A later retry can require fresh authentication even when an earlier request may
have created the durable server deletion gate. The client therefore preserves
`serverRequestStartedAt` across that response and switches to privacy-first
local cleanup instead of clearing the marker through the ordinary
reauthentication flow. Only a first attempt with no prior server-request
evidence may clear the marker after signing out for reauthentication.

Local cleanup failures also use the unverified-cloud error copy whenever
`serverDeletionConfirmedAt` is absent, so the UI never states that cloud
deletion succeeded without evidence. A missing configured Supabase client is
treated as a local-cleanup verification failure rather than proof that the
persisted session was removed.

## Marker-persistence failure evidence

If AsyncStorage fails after `serverRequestStartedAt` was already persisted, the
workflow error screen derives its retry marker from the newest successfully
persisted in-memory marker rather than from the older React effect closure. A
subsequent retry therefore cannot erase evidence that the server request may
have started.

## Phase 5C release hardening

Phase 5C narrows whole-session local cleanup to sessions inside workspaces
known to be owned by the deleted account. User authorship alone no longer
expands the cleanup graph through a shared/non-owned session, preserving other
users' cached rows on a shared device.

The root boundary also observes an already-running same-process deletion
workflow after remount and reloads the durable marker when it settles.

SQLite now enables `PRAGMA secure_delete = ON`, and account cleanup requires a
successful `PRAGMA wal_checkpoint(TRUNCATE)` after its scoped transaction.
Automatic `VACUUM` remains intentionally out of scope for the shared-device
database.
