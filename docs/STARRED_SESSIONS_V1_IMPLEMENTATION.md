# Starred Sessions v1

## Scope

Starred Sessions v1 adds a personal, cross-device marker for sessions without
changing the shared session record itself.

Implemented behavior:

- one-tap star and unstar from Session card and Compact view;
- Starred filter in Library -> Sessions;
- Starred first sort while preserving newest-first order inside each group;
- local-first updates on Android/iOS;
- direct authenticated Supabase updates on web;
- durable offline synchronization and retry;
- cloud-to-local restoration after reinstall or sign-in on another device;
- user-specific Row Level Security;
- cascade cleanup when a session or user is deleted.

## Data model

A star is intentionally not stored on `public.sessions`. It belongs to one
user's organization preferences and must not be visible to another user.

Cloud table:

```text
public.session_user_preferences
├── user_id
├── session_id
├── is_starred
├── created_at
└── updated_at
```

Primary key:

```text
(user_id, session_id)
```

Local table:

```text
local_session_user_preferences
```

The local record additionally stores workspace context and synchronization
status. Its stable local identifier is:

```text
session-preference:<user_id>:<session_id>
```

## Synchronization

Native flow:

```text
Tap star
-> update UI optimistically
-> write preference and metadata queue operation in one SQLite transaction
-> shared metadata worker waits for the parent session
-> UPSERT public.session_user_preferences
-> mark local preference synchronized
```

The deterministic idempotency key is:

```text
upsert:session_preference:<user_id>:<session_id>
```

A later toggle reactivates the same queue operation, so rapid changes do not
create duplicate cloud rows. The worker reads the latest canonical local row
before synchronization.

Web flow:

```text
Tap star
-> authenticated Supabase UPSERT
-> update Library state
```

## Dependency order

Metadata priorities now include:

```text
project:             100
session:             200
session preference:  250
note/bookmark:       300
timeline:            400+
```

A preference is deferred until the parent session is synchronized. Dependency
deferral does not consume the normal retry budget.

## Row Level Security

Migration `0006_session_user_preferences.sql` allows an authenticated user to
read, insert, update, or delete only rows where:

```text
user_id = auth.uid()
```

and the referenced session belongs to a workspace the user can access.

This means two users who can see the same shared session may still have
independent star state.

## Library behavior

Sessions can be organized using:

```text
All
Starred
Local
Pending
Syncing
Synced
Failed
```

The additional sort option is:

```text
Starred first
```

Starred first is a global sort without date-section headers. Starred sessions
are ordered newest first, followed by all unstarred sessions newest first.

## Deletion

Cloud preferences use `ON DELETE CASCADE` from both `auth.users` and
`public.sessions`. Native cloud-aware session deletion also removes local
preference rows and queued preference operations.

## Migrations

Apply only the new cloud migration:

```text
supabase/migrations/0006_session_user_preferences.sql
```

Do not rerun migrations `0001` through `0005`.

Local SQLite automatically upgrades to schema version 9 when the native app
opens. No uninstall or clear-data step is required.

## Not included

The following remain outside this pass:

- pinned sessions;
- custom labels or colors;
- shared/team stars;
- reminder dates;
- priority levels;
- project starring;
- bulk star actions.
