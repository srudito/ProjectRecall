# Synchronisation

## Queue lifecycle

```
local_only → pending → uploading → uploaded → synchronized
                              └────→ failed → (retry) → uploading …
                              └────→ cancelled
```

## Retry & backoff

`src/services/upload-queue/backoff.ts`:

- Initial delay: 2s, factor 2, cap 5 min, ±25% jitter.
- Max attempts: 8.
- Manual retry always resets `next_retry_at` and enqueues immediately.

## Idempotency

Every queue row carries an `idempotency_key` derived from stable identifiers
(session id, entity type, entity id). Combined with the SQLite
`UNIQUE (idempotency_key)` and Postgres `UNIQUE (user_id, idempotency_key)`,
retries never create duplicate objects.

## Conflict handling

Milestone 1 is single-writer per user, so structural conflicts are unlikely.
If a metadata upsert reports `Conflict`, the item is marked `failed` with a
`SYNC_CONFLICT` code so the user can retry once the underlying issue is
resolved.

## Background limitations (honest)

- Android app force-stop discards in-progress uploads. On next launch the
  queue is restored from SQLite and pending items resume.
- Background sync on Android without a development build is best-effort. Do
  not promise instant upload while the app is force-stopped.

## Local ↔ cloud reconciliation

- Uploads only mark an item `synchronized` when the file upload AND cloud
  metadata insert both succeed AND the row is readable back through RLS.
- On session load the client reads local first, then reconciles cloud sync
  status from Supabase where connectivity + auth permit.

## Wi-Fi only

The `Profile → Upload over Wi-Fi only` toggle is respected by the queue runner
via `@react-native-community/netinfo`. On cellular it defers pending items
until Wi-Fi is available.
