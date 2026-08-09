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

### Phase 2B — one real provider and server worker

Planned after Phase 2A is reviewed, committed, and migration `0013` is applied
once in the development environment:

- server-side `TranscriptionProvider` interface;
- one real provider implementation;
- authenticated request endpoint and durable worker claiming;
- private Storage input access without exposing provider credentials;
- safe retry, cancellation, polling/webhook handling, and result ingestion.

### Later Milestone 2 phases

- automatic language detection;
- single-language and multilingual transcription;
- English/Bahasa Indonesia code-switching;
- transcript synchronization and display;
- transcript editor and immutable version history;
- release hardening before the feature flag is enabled.

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
