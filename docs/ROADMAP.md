# Roadmap

## Milestone 1 — Capture, evidence, cloud sync, and account security

Milestone 1 engineering is complete and verified:

- local-first project/session persistence and synchronization;
- notes, bookmarks, timeline events, recordings, and evidence sync;
- private Storage upload, signed restoration, retry, and orphan cleanup;
- cloud-aware session deletion;
- project context, Library organization, stars, sorting, and scrolling UX;
- email/password and Google authentication;
- connected accounts, safe Google linking/unlinking, and password recovery;
- authenticated route protection;
- permanent account deletion with distributed gating, crash-safe local cleanup,
  and release hardening;
- public Privacy Policy, Terms of Service, and account-deletion pages;
- isolated migration verification for `0001–0012`;
- preview runtime, reinstall, and production AAB binary audits.

The verified Milestone 1 release-candidate checkpoint is:

```text
milestone1-release-candidate-v1
```

Google Play testing is intentionally deferred until the broader product scope
is closer to public release.

## Milestone 2 — Batch transcription

### Phase 2A — provider-neutral transcription foundation

Implemented in this phase:

- append-only migration `0013_transcription_foundation_v1.sql`;
- durable jobs with leases, retry bounds, stable idempotency, and strict
  recording/session/workspace scope;
- provider execution attempts, versioned transcript records, and timestamped
  language-aware segments;
- local SQLite schema version `10` with a crash-safe request queue and cached
  processing/transcript records;
- normalized language and request-precondition contracts;
- Delete Account local cleanup plus cloud preflight/final-reference coverage
  for transcription actor relationships and shared-workspace blockers;
- session-deletion cleanup coverage for new local tables;
- read-only authenticated RLS for processing/transcript results;
- `transcription_enabled=false` remains enforced.

Phase 2A does **not** select or call a transcription provider, expose provider
credentials, enable transcription UI, or process recordings.

### Phase 2B.1A — AssemblyAI provider adapter foundation

Implemented without live provider execution:

- server-only `TranscriptionProvider` interface;
- AssemblyAI Universal-2 REST adapter;
- EU endpoint by default with explicit US override only;
- automatic, single-language, and initial English/Indonesian code-switching
  request mapping;
- optional speaker diarization;
- polling status normalization;
- safe retry/error classification;
- word-level canonical transcript normalization;
- idempotent provider-artifact deletion;
- mock transport and secret-leakage tests;
- `transcription_enabled=false` remains enforced.

This phase does not create an AssemblyAI key, worker, request endpoint, Cron,
signed-URL generator, migration `0014`, mobile UI, or live provider spend.

### Phase 2B.1B — authenticated intake and durable polling worker

Source foundation implemented and controlled development rollout completed;
production rollout remains disabled:

- append-only migration `0014` with atomic request, claim, lease, recovery,
  completion, and cleanup RPCs;
- authenticated transcription request Edge Function;
- token-protected server-only polling worker;
- short-lived private Storage signed URL generation after durable claim;
- durable `submitting` boundary that prevents blind duplicate provider POSTs;
- one active job per recording and recording-scoped unresolved-cleanup gates;
- atomic transcript/version/segment ingestion;
- provider artifact cleanup retry/manual-review handling and safe membership-loss
  pruning after cleanup;
- direct recording/session deletion guards while provider state is unresolved;
- same-commit redeployment of the updated `delete-account` Edge Function is a
  mandatory rollout gate before request/worker deployment or live provider work;
- controlled development migration, deployment, live provider cleanup, durable
  worker, authenticated Cron, and feature-activation gates have passed;
- production remains untouched and requires its own later release-hardening gate.

### Phase 2B.2 — mobile transcription request integration

Implemented in this phase:

- provider-neutral native `Request transcription` action on the recording card;
- durable local request intent using the existing SQLite v10 transcription
  request queue;
- offline-first queueing before binary upload finishes;
- lifecycle/network/metadata-triggered request synchronization;
- authenticated mobile invocation of `transcription-request` only;
- stable local idempotency and crash-safe submitting-row recovery;
- server-scope validation and local server-job tracking;
- non-authoritative cached feature availability with the server kill switch
  remaining authoritative;
- no provider secrets or service-role credentials in React Native.

The development Milestone 2B.1B backend has completed controlled live provider,
durable worker, Cron, and feature-activation validation. Production remains
untouched. This phase stops after the backend accepts/reuses a durable job; it
does not synchronize or display transcript content on mobile.

### Phase 2B.3A — transcript result sync and local persistence

Implemented in this phase:

- authenticated RLS reads for durable job, run, current version, and segments;
- bounded result polling tied to lifecycle, connectivity, and request submission;
- paginated segment reads;
- scope validation and atomic SQLite job/run/version/segment persistence;
- idempotent local replacement and offline result availability;
- provider cleanup must succeed before final local ingestion.

### Phase 2B.3B — local transcript read UI

Implemented in this phase:

- a native Transcript tab on Session Detail;
- read-only continuous transcript text from the local current version;
- local version/segment metadata and an offline-availability indicator;
- safe empty, loading, and local-read error states;
- refresh when the result worker publishes local changes;
- no Supabase or provider call from the reader UI.

### Phase 2B.3C — timestamped transcript segment browser

Implemented in this phase:

- accessible continuous/timestamped view selection;
- local timestamp ranges, selectable segment text, and optional speaker/language
  metadata;
- bounded progressive rendering for long local transcripts;
- stricter local segment time/text/identity validation;
- no playback seek, editing, remote read, provider call, or migration.

### Phase 2B.4A — supported language modes and EN–ID code-switching UX

Implemented in this phase:

- Record Setup no longer exposes the unrestricted spoken-language catalog for
  transcription configuration;
- Auto detect requires no manual language hint;
- One language exposes only English or Bahasa Indonesia;
- Multilingual is the fixed English + Bahasa Indonesia code-switching pair;
- reviewed English aliases canonicalize to `en` and Bahasa Indonesia to `id`;
- request preparation and idempotency use the same fail-closed capability
  contract before any remote request;
- no server migration, provider deployment, secret, Cron, or native change.

### Phase 2B.4A.1 — transcription progress messaging UX

Implemented in this phase:

- retryable result-sync diagnostics are no longer presented as red terminal
  transcription failures;
- waiting, processing, finalizing, secure-cleanup, retrying, and local-ready
  states have explicit native messaging;
- the ready signal comes from the existing local SQLite current transcript;
- terminal failed/cancelled rows retain red safe-error treatment;
- result-worker polling/backoff, backend, provider, and native configuration are
  unchanged.

### Phase 2B.4A.2 — EN–ID provider result compatibility

Implemented and deployed to development; the controlled rerun reached the
provider but isolated a remaining completed-result failure to the aggregate
language-metadata diagnostic:

- reviewed English response locales canonicalize safely for the EN–ID pair;
- the documented nullable `language_codes` response shape remains explicitly
  covered without retaining raw provider responses;
- manual EN–ID claim reconciliation uses the reviewed request pair while
  preserving provider primary-language evidence;
- code-switching words remain unlabeled when the provider does not supply
  trustworthy word-level language attribution;
- bounded diagnostic codes distinguish envelope, language, words, text, model,
  and claim-validation failures without secrets or provider payloads;
- no migration, retry/backoff, cleanup, mobile, Cron, or native change.

### Phase 2B.4A.3 - EN–ID language metadata shape diagnostics

Implemented and deployed to development. The controlled diagnostic rerun proved
that the manual EN–ID completed response carries no provider primary language:

- the aggregate provider language-metadata failure is split into bounded
  primary, collection-shape, empty, member, duplicate, and primary-membership
  categories;
- the live failure resolved to
  `TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_MISSING`;
- provider cleanup completed with no unresolved artifact or manual-review row;
- diagnostics contain no raw provider values, transcript content, signed URL,
  provider identifier, credential, or secret.

### Phase 2B.4A.4 - EN–ID nullable-primary compatibility

Implemented in source; migration/development deployment and one fresh rerun
remain pending:

- a completed result may omit provider `language_code` only when
  `language_codes` canonicalizes to exactly `en,id`;
- single-language and automatic-detection results still require a provider
  primary language;
- the worker retains `primaryLanguage = null`, carries the reviewed EN–ID pair,
  and leaves per-word language labels null;
- append-only migration 0015 updates only the atomic language-summary validator
  so the database accepts this exact user-confirmed shape;
- no existing migration is edited or rerun;
- no mobile, secret, Cron, retry, cleanup, package, lockfile, or native change.

### Later Milestone 2 phases

- one controlled EN–ID rerun after migration 0015 and worker redeployment;
- transcript editor and immutable version history;
- release hardening before production feature activation.

## Milestone 3 — Multimodal analysis

- OCR and document text extraction.
- Image captioning.
- AI summaries, decisions, and action items.

## Milestone 4 — Knowledge base

- Historical embeddings.
- Hybrid search.
- Ask AI with exact source citations.

## Milestone 5 — Live transcription

- Live draft and final verified transcript.
- Reconnection handling.
- Live language detection, subtitles, and translation.

## Milestone 6 — Multi-provider

- Provider registry, selection, routing, fallback, and BYOK.

## Milestone 7 — Commerce

- Subscription, credits, advertising, and administration.


## Milestone 2B.3A — Transcript result sync and local persistence

- Implementation: `MILESTONE2B3A_TRANSCRIPT_RESULT_SYNC_V1_IMPLEMENTATION.md`
- Test plan: `MILESTONE2B3A_TRANSCRIPT_RESULT_SYNC_V1_TEST.md`
- Scope: authenticated RLS result reads, durable polling, paginated segments, and atomic SQLite persistence. Transcript UI remains deferred.

## Milestone 2B.3B — Local transcript read UI

- Implementation: `MILESTONE2B3B_TRANSCRIPT_READ_UI_V1_IMPLEMENTATION.md`
- Test plan: `MILESTONE2B3B_TRANSCRIPT_READ_UI_V1_TEST.md`
- Scope: native, read-only continuous transcript display from the existing local SQLite result cache with offline availability.


## Milestone 2B.3C — Timestamped transcript segment browser

- Implementation: `MILESTONE2B3C_TIMESTAMPED_TRANSCRIPT_BROWSER_V1_IMPLEMENTATION.md`
- Test plan: `MILESTONE2B3C_TIMESTAMPED_TRANSCRIPT_BROWSER_V1_TEST.md`
- Scope: offline timestamped browsing of the current local SQLite segment cache, with bounded rendering and no playback seeking or editing.


## Milestone 2B.4A — Supported language modes and EN–ID code-switching UX

- Implementation: `MILESTONE2B4A_SUPPORTED_LANGUAGE_MODES_V1_IMPLEMENTATION.md`
- Test plan: `MILESTONE2B4A_SUPPORTED_LANGUAGE_MODES_V1_TEST.md`
- Scope: fail-closed native setup and canonical local request contracts for automatic detection, English, Bahasa Indonesia, and the reviewed English–Bahasa Indonesia code-switching pair.


## Milestone 2B.4A.1 — Transcription progress messaging UX

- Implementation: `MILESTONE2B4A1_TRANSCRIPTION_PROGRESS_MESSAGING_V1_IMPLEMENTATION.md`
- Test plan: `MILESTONE2B4A1_TRANSCRIPTION_PROGRESS_MESSAGING_V1_TEST.md`
- Scope: local presentation hardening for durable transcription progress/retry states and local transcript readiness, with no worker, provider, migration, or retry-semantics change.


## Milestone 2B.4A.2 — EN–ID provider result compatibility

- Implementation: `MILESTONE2B4A2_EN_ID_PROVIDER_RESULT_COMPATIBILITY_V1_IMPLEMENTATION.md`
- Test plan: `MILESTONE2B4A2_EN_ID_PROVIDER_RESULT_COMPATIBILITY_V1_TEST.md`
- Scope: server-only compatibility and safe diagnostics for reviewed EN–ID completed results, with no migration or mobile change. Controlled redeployment and rerun remain pending.


## Milestone 2B.4A.3 - EN–ID language metadata diagnostics

- Implementation: `MILESTONE2B4A3_EN_ID_LANGUAGE_METADATA_DIAGNOSTICS_V1_IMPLEMENTATION.md`
- Test plan: `MILESTONE2B4A3_EN_ID_LANGUAGE_METADATA_DIAGNOSTICS_V1_TEST.md`
- Scope: diagnostic-only structural classification of completed provider language metadata, with no compatibility or schema change.


## Milestone 2B.4A.4 - EN–ID nullable-primary compatibility

- Implementation: `MILESTONE2B4A4_EN_ID_NULLABLE_PRIMARY_COMPATIBILITY_V1_IMPLEMENTATION.md`
- Test plan: `MILESTONE2B4A4_EN_ID_NULLABLE_PRIMARY_COMPATIBILITY_V1_TEST.md`
- Scope: narrow server/database compatibility for manual EN–ID completed results that omit provider primary language, using append-only migration 0015 and no mobile change.
