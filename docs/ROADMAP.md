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

### Later Milestone 2 phases

- transcript synchronization and display;
- single-language and multilingual transcription;
- English/Bahasa Indonesia code-switching;
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
