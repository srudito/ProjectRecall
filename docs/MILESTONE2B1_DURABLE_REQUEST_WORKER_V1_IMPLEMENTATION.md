# Milestone 2B.1B — Durable Request Endpoint and Polling Worker Foundation v1

## Purpose

This milestone connects the provider-neutral transcription foundation to a
server-only request and polling control plane while keeping transcription
turned off. It introduces no mobile provider execution, no provider secret,
no Cron schedule, and no live AssemblyAI request.

The source checkpoint for this work is
`milestone2b1a-assemblyai-provider-adapter-v1`.

## Feature state

```text
transcription_enabled=false
analysis_enabled=false
```

A user request is rejected with `TRANSCRIPTION_FEATURE_DISABLED` until a later
reviewed rollout explicitly enables the feature.

## Database migration

`0014_transcription_request_worker_v1.sql` is append-only after migration
`0013`. It must first be tested on a fresh disposable Supabase project with
migrations `0001` through `0014` applied exactly once.

The migration adds:

- a durable `submitting` provider-run state;
- request, claim, submission, polling, completion, recovery, and cleanup RPCs;
- `FOR UPDATE SKIP LOCKED` claim semantics;
- finite processing deadlines and bounded lease recovery;
- immutable request-intent validation;
- database-level secret/URL rejection for provider metadata;
- provider cleanup state and retry/manual-review transitions;
- session-deletion guards for in-flight submission and outstanding provider
  cleanup;
- explicit `service_role`-only execution privileges for worker RPCs.

The migration refuses to run if transcription foundation tables already contain
rows. This is intentional: the state-machine change must be reviewed before
live work is admitted. Digest-using security-definer RPCs include both `public`
and Supabase's `extensions` schema in their fixed search path so `pgcrypto` is
resolved consistently on fresh hosted projects.

## Request endpoint

`transcription-request` is JWT protected. Its request body is exactly:

```json
{ "recordingId": "<uuid>" }
```

The endpoint does not accept workspace IDs, session IDs, Storage paths,
provider selection, signed URLs, provider metadata, or provider credentials.
The database re-derives and validates:

- authenticated workspace membership;
- canonical recording/session/workspace scope;
- session deletion state;
- synchronized recording state and media type;
- canonical private Storage object path;
- immutable language intent;
- stable workspace-scoped idempotency;
- one active durable job per recording across queued, leased, and processing
  states;
- immediate removal of durable work with no in-flight submission or unresolved
  provider artifact when its creator loses workspace membership, including
  terminal failures that never produced transcript content;
- feature-flag state.

## Polling worker

`transcription-worker` is not a user endpoint. JWT gateway verification is
disabled for this one function, so the function requires a custom
`x-project-recall-worker-token` value and compares it in constant time.

The request endpoint accepts the hosted `SUPABASE_PUBLISHABLE_KEYS` JSON
dictionary, with singular and legacy anon-key fallbacks. The worker uses the
hosted `SUPABASE_SECRET_KEYS` JSON dictionary, with legacy service-role fallback;
key classes are never interchangeable.

The worker uses a unique ID per invocation and conservative defaults:

```text
job claim limit       1
cleanup claim limit   1
lease                  45 seconds
provider HTTP timeout 12 seconds
signed URL TTL         1 hour
poll delay             15 seconds
```

The provider timeout is shorter than the durable lease. Work is processed in
small batches so one Edge Function invocation cannot consume an unbounded
backlog. The one-hour signed URL default is intended to outlast normal provider
queueing; configuration remains bounded to two hours and the URL is never
persisted.

## Durable submission boundary

The order is intentional:

```text
claim durable job
→ validate claim row
→ create short-lived private Storage signed URL
→ persist provider run as submitting
→ construct AssemblyAI adapter lazily
→ POST to provider
→ persist provider job ID
→ release lease and schedule polling
```

If the worker dies after AssemblyAI accepts the POST but before the provider ID
is stored, the run is not blindly submitted again. Expired `submitting` work is
marked `TRANSCRIPTION_PROVIDER_SUBMISSION_OUTCOME_UNKNOWN` and requires
reconciliation.

Failures before provider submission, including signed-URL creation failures,
consume a bounded processing attempt. A queued provider run is reused after a
pre-submission retry; retry history is not duplicated.

Requests for the same recording are serialized through the recording row and
reuse the existing active job even if session language preferences change while
that job is pending. A partial unique index provides database-level protection
against concurrent duplicate active jobs and duplicate provider cost.

If the requesting user loses active workspace membership, durable work with no
in-flight submission, unresolved provider artifact, or linked transcript
version is deleted immediately, including queued, leased, and provider-free
terminal failed/cancelled work. `begin_transcription_submission` re-checks and
locks active membership at the last durable boundary before provider POST.
Jobs that may still have a provider artifact remain fail-closed for cleanup or
manual reconciliation. Transcript versions and their completed evidence remain
preserved.

Membership may also be revoked after the durable `submitting` transition commits
but before a provider-free submission failure is persisted. Both retryable and
terminal no-ID failures therefore invoke the same safe-prune helper after their
job/run transition. If the creator is no longer an active member and no transcript
or unresolved provider artifact exists, the graph is removed immediately instead
of becoming an unclaimable shared-workspace creator reference or permanent Delete
Account blocker.

## Polling and completion

Polling occurs in later worker invocations without holding a lease between
polls. Polling does not consume provider-submission attempts.

Completion is one database transaction:

```text
validate lease, job, run, provider identity, and session
→ validate immutable request intent and normalized result
→ allocate next session transcript version
→ clear the prior current version
→ insert transcript version and timestamped segments
→ mark the new version current
→ mark provider run and processing job succeeded
→ enqueue provider-artifact cleanup
→ clear lease
```

Malformed JSON types, unsafe numbers, non-canonical languages, mismatched
provider metadata, invalid checksums, sparse/non-contiguous segments, and
session deletion state fail closed as `TRANSCRIPTION_RESULT_INVALID` or a
stable session/job error.

## Provider cleanup

Provider deletion is durable:

```text
pending → leased → succeeded
                 ↘ retry pending
                 ↘ manual_review
```

A confirmed `404` is treated as already absent by the adapter. If provider
absence is confirmed manually, `confirm_transcription_provider_absence` records
a completed cleanup even when no provider job ID is available. A failed
ambiguous no-ID submission is re-queued only after this explicit absence
confirmation, only while the original creator is still an active member and the
bounded submission-attempt budget remains. The same immutable processing job is
reused, so the workspace idempotency key cannot strand an otherwise safe retry.

If membership was already lost while provider cleanup was pending, successful
cleanup prunes the now-safe queued/terminal graph when it has no linked
transcript version. This
removes stale creator references only after the provider artifact is confirmed
safe; completed transcript evidence is not discarded.

A queued retry cannot be claimed while any prior provider run for the same
recording still has an unresolved provider artifact. A new request with changed
language intent also reuses the existing terminal job until cleanup is
confirmed. New provider submission is released only after cleanup is
`succeeded`, preventing repeated paid jobs from accumulating across multiple
durable jobs for one evidence recording.

## Delete Account and session deletion

Delete Account preflight blocks destructive account cleanup while any relevant
transcription run is:

- `submitting` or `processing`; or
- awaiting provider cleanup in `pending`, `leased`, or `manual_review` state.

A direct delete of a recording, processing job, session, or workspace cascade
is guarded at the processing-job parent before durable provider state can be
lost. Session deletion receives the same stable error codes. The mobile deletion
worker maps these errors as retryable, so local data is not hard-deleted before
cloud provider state is safe.

The `delete-account` Edge Function is changed by this milestone and is part of
the same controlled rollout. After migration `0014` is applied, the reviewed
`delete-account` function must be bundled and redeployed from the same commit
before `transcription-request`, `transcription-worker`, any live provider job, or
feature activation. A stale Delete Account deployment would not perform the new
provider-state preflight before removing private Storage objects, even though
database delete guards would later reject the workspace cascade.

## Credential boundary

This milestone does not create secrets. A later controlled rollout may use:

```text
ASSEMBLYAI_API_KEY
PROJECT_RECALL_TRANSCRIPTION_WORKER_TOKEN
SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY
```

Those values belong only in Supabase project secrets. They must never appear in
Git, migrations, logs, provider metadata, job payloads, client responses, or any
`EXPO_PUBLIC_*` variable.

## Explicitly out of scope

- Cron scheduling;
- live AssemblyAI calls;
- feature activation;
- mobile transcription request worker;
- transcript UI/editor;
- LLM Gateway analysis, summaries, or action items;
- migration application or Edge Function deployment before final review.
