# Library Organization v1

## Scope

Library Organization v1 improves the Projects and Sessions result lists without
changing the cloud schema or synchronization model.

Implemented behavior:

- session recording timestamp;
- Today / Yesterday / This week / Earlier sections for chronological sorts;
- session sort options: newest, oldest, longest, shortest;
- project sort options: recent activity, newest project, project name;
- independent Card and Compact view modes for Projects and Sessions;
- device-local persistence of sort and view preferences;
- project session count and last-activity timestamp;
- locale-aware date and time formatting using the application language and
  device time zone.

## Timestamp source

A session displays:

```text
started_at ?? created_at
```

`started_at` represents the time recording actually began. `created_at` is the
fallback for drafts or sessions that never began recording. `updated_at` is not
used because synchronization or metadata edits can change it later.

## Date grouping

Chronological sorts use:

```text
Today
Yesterday
This week
Earlier
```

Duration sorts are global and intentionally omit date headers so that the
longest or shortest recording is truly first across the whole result set.

## Project activity

Project last activity is the newest of:

- `project.updated_at`;
- the display timestamp of a session belonging to the project.

Session counts and last activity are calculated in memory from the Projects and
Sessions already loaded by Library. No extra per-card database query is made.

## Preferences

The following view preferences are stored locally:

```text
library.sessions.viewMode.v1
library.sessions.sortMode.v1
library.projects.viewMode.v1
library.projects.sortMode.v1
```

They are presentation-only preferences and are intentionally not synchronized
to Supabase.

## Not included

The following remain separate work:

- Starred or pinned sessions;
- personal cloud-synchronized library preferences;
- rename/move quick actions;
- transcript status and summary previews;
- note/bookmark/evidence aggregate counts.

Starred state should be per user rather than a global property of the session,
so it requires its own local/cloud data model and RLS policies.
