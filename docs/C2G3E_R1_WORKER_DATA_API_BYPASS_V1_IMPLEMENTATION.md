# C2G.3E-R1 Worker Data API Bypass V1 — Implementation Candidate

## Status

- Candidate only; not deployed.
- Source baseline: `milestone1sync` at `f93bf348457f678e718425b6ae874c489ec7ba23`.
- Transcription must remain disabled throughout validation and rollout.
- No existing migration is rewritten or replayed.

## Problem boundary

The scheduled `transcription-worker` currently performs all worker database
operations through `supabase-js` RPC calls, which traverse API Gateway and
PostgREST. Passive production observations continued to return intermittent
HTTP 500 responses after one controlled project restart, even with no active
jobs, runs, or unresolved provider artifacts.

This candidate removes Data API/PostgREST only from the worker database path.
Supabase Auth, private Storage, RLS, mobile access, Cron, and AssemblyAI remain
unchanged.

## Runtime architecture

```text
transcription-worker
  |-- Supabase admin client -> private Storage signed URL
  `-- Postgres.js -> Shared Transaction Pooler -> existing worker functions
```

`core.ts` remains unchanged. The `TranscriptionWorkerDatabase` interface keeps
all durable state-machine boundaries intact.

## Dedicated database role

Migration `0017_transcription_worker_direct_database_role_v1.sql` creates the
login role `project_recall_transcription_worker` with:

- `LOGIN`, `NOINHERIT`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
  `NOREPLICATION`, and `NOBYPASSRLS`;
- no password in source or migration;
- `CONNECT` to the current database;
- `USAGE` on schema `public`;
- explicit `EXECUTE` on exactly the eleven worker functions called by the Edge
  Function;
- no explicit table, sequence, operator-helper, or role-membership privileges.

The function bodies, owners, signatures, RLS policies, tables, triggers, data,
feature flags, and Cron configuration are not changed.

Password provisioning is an operational gate and must use an interactive,
non-echoing mechanism such as `psql` `\\password`. A password or connection URI
must never be committed, printed, pasted into chat, or placed in an
`EXPO_PUBLIC_` variable.

## Edge Function secret

The candidate expects this server-only Edge Function secret:

```text
PROJECT_RECALL_TRANSCRIPTION_WORKER_DATABASE_URL
```

It must contain the Dashboard-provided Shared Transaction Pooler URI for the
dedicated role. Runtime validation requires:

- `postgres:` or `postgresql:` scheme;
- a `*.pooler.supabase.com` host;
- port `6543`;
- database `/postgres`;
- username `project_recall_transcription_worker.<project-ref>`;
- a nonempty password;
- no fragment;
- no query parameter except optional `sslmode=require`;
- project-ref parity with `SUPABASE_URL`.

The URI is never logged.

## PostgreSQL client contract

`postgres.ts` pins `postgres@3.4.9` and configures:

```text
max=1
prepare=false
ssl=require
connect_timeout=10
fetch_types=false
```

The client is initialized lazily after method, worker-token, and body validation
and is cached at module scope for a warm Edge Function instance.

The executor contains a fixed switch over eleven operations. It does not accept
raw SQL, dynamic identifiers, or request-supplied function names. Each operation
runs one tagged-template statement against one existing function.

## Result normalization

Every function result is converted inside PostgreSQL with
`pg_catalog.to_jsonb(... )::text`. The executor then parses only the `payload`
column. This preserves JSON-compatible UUID, boolean, text, timestamp, JSONB,
and safe-integer shapes before the existing strict claim/result parsers run.

All JSONB inputs are serialized once with `JSON.stringify` and sent as ordinary
protocol parameters with explicit `::jsonb` casts.

## Transaction and retry behavior

Each adapter method sends exactly one PostgreSQL statement. The complete worker
run, Storage signing, provider submission, provider polling, and provider
cleanup are never wrapped in a shared transaction.

The candidate deliberately adds no generic query retry and no client-side query
cancellation. Ambiguous mutating outcomes continue to be handled by existing
leases, stable IDs, bounded recovery, and provider-submission reconciliation.

## Safe errors

Raw Postgres.js errors, query text, parameters, connection details, private
paths, transcript content, provider metadata, and secrets are not logged or
returned.

The adapter exposes only:

```text
TRANSCRIPTION_DATABASE_CALL_FAILED
operation=<fixed operation name>
```

The HTTP response remains the existing generic
`TRANSCRIPTION_WORKER_FAILED` contract.

## Rollout boundary

This candidate does not:

- apply migration `0017`;
- create or set a role password;
- create or change Edge Function secrets;
- deploy a function;
- change Cron;
- enable transcription;
- invoke a provider;
- submit a recording;
- stage, commit, or push source.
