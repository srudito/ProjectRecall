# Milestone 2B.4B.3A — Transcript Edit Local Foundation V1 Implementation

## Status

Implemented and validated in development. This document is part of the
Milestone 2B.4B.3A closure change.

Implementation base source:

```text
1d62df7449f3166572d268171a03d0a0f07e574d
```

Milestone 2B.4B.2 is already closed in development. Migration 0016 was applied
once to the linked development database and must not be rerun. This milestone
does not add or apply a Supabase migration.

## Purpose

Milestone 2B.4B.3A adds the local-first persistence boundary required before a
mobile Full Text editor or authenticated edit-sync worker can exist.

The goal is deliberately narrow:

- keep in-progress user text outside immutable transcript versions;
- pin each draft to the transcript version from which editing started;
- persist an immutable outbound save snapshot under a stable client UUID;
- retain enough retry/conflict metadata for a later worker;
- include the new rows in existing local session/account cleanup boundaries.

No network submission, cross-device pull, editor UI, version-history UI, or
restore behavior is implemented here.

## Source scope

Modified:

```text
frontend/src/services/sqlite/migrations.ts
frontend/src/services/sqlite/repository.ts
frontend/__tests__/sqlite-migrations.test.ts
frontend/__tests__/local-account-cleanup-repository.test.ts
```

Added:

```text
frontend/__tests__/transcript-edit-local-repository.test.ts
```

Documentation closure adds this implementation document, its test document,
`docs/README.md`, and `docs/ROADMAP.md`.

## SQLite v11 contract

Local schema version 11 adds two tables.

### `local_transcript_edit_drafts`

The draft table stores mutable work-in-progress text separately from
`local_transcript_versions`.

Important properties:

- one row per `(user_id, session_id)`;
- `workspace_id` and `base_version_id` are captured when the draft is created;
- autosave updates only `plain_text` and `updated_at`;
- the existing draft's base version is therefore pinned and cannot silently
  rebase when the cloud current version changes;
- draft text may be empty because an editor can temporarily contain no text;
- saving a draft does not insert, update, or delete transcript versions or
  transcript segments.

The pinned base is the local precursor to the compare-and-swap
`p_expected_current_version_id` contract implemented by migration 0016.

### `local_transcript_edit_queue`

The queue stores immutable outbound save snapshots.

Important properties:

- `id` is the stable client-generated transcript version UUID;
- the row records user, workspace, session, expected current version, and the
  exact nonblank Full Text payload;
- queue status is one of `pending`, `submitting`, `failed`, `conflict`,
  `succeeded`, or `cancelled`;
- retry state includes attempt count, maximum attempts, next retry time, and
  bounded safe error fields;
- the client UUID is the primary key, making retry lookup deterministic;
- replaying the same UUID with the same scope/base/text returns the existing
  row without rewriting it;
- reusing the UUID with different scope, base, or text fails closed;
- eligible lookup considers only `pending` and `failed` rows whose retry time is
  due and whose attempt budget remains.

2B.4B.3A intentionally does not implement queue-status mutation or a network
worker. Those transitions belong to the later authenticated sync phase.

## Immutable evidence boundary

Draft and outbox persistence never mutates:

```text
local_transcript_versions
local_transcript_segments
```

This preserves the evidence rule established in 2B.4B.1 and 2B.4B.2:
arbitrary edited Full Text must not fabricate timestamp mappings. Provider
segments remain evidence attached to their provider transcript lineage.

Creating an actual immutable `user_edit` transcript version remains a
server-side operation through the authenticated RPC added by migration 0016.

## Cleanup integration

The new draft/outbox rows participate in existing local deletion boundaries.

Hard session deletion removes, in order, local transcript segments, edit queue,
edit drafts, transcript versions, transcription runs/jobs/requests, and the
remaining session graph.

Account cleanup removes edit queue and draft rows when they belong to the
deleted user or fall within the already-authorized workspace/session cleanup
scope. The existing WAL checkpoint and scoped cleanup behavior remain unchanged.

## Deferred work

This milestone does not start later phases.

Deferred:

- authenticated RPC client and durable edit queue worker;
- retry/backoff/status transitions and explicit server conflict handling;
- generic current transcript-version pull and cross-device synchronization;
- local-first Full Text editor UI;
- conflict presentation;
- version history and restore-as-new-version;
- timestamp-evidence lineage presentation for edited current versions.

## Security and deployment boundary

No change was made to:

- Supabase migrations or RLS;
- Edge Functions;
- transcription-worker v8;
- Cron;
- provider behavior;
- feature flags;
- secrets or public environment variables;
- package or lock files;
- native configuration;
- production.

No privileged key or secret is added to the frontend.

## Validation result

Development validation passed with Node 20.19.4:

```text
TypeScript: PASS
Focused Jest: 3 suites, 24 tests PASS
Targeted ESLint: PASS
Full Jest: 69 suites, 602 tests PASS
Release readiness: PASS
Expo install --check: PASS
Expo Doctor: 18/18 PASS
git diff --check: PASS
```

The validated protected source scope remained exactly the five source/test
files listed above before this documentation closure.
