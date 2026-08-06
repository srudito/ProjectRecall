# Roadmap

## Milestone 1 — Capture, evidence, cloud sync, and account security

Feature implementation is complete and verified in dependency-ordered passes:

- local-first project/session persistence and synchronization;
- notes, bookmarks, timeline events, recordings, and evidence sync;
- private Storage upload, signed restoration, retry, and orphan cleanup;
- cloud-aware session deletion;
- project context, Library organization, stars, sorting, and scrolling UX;
- email/password and Google authentication;
- connected accounts, safe Google linking/unlinking, and password recovery;
- authenticated route protection;
- permanent account deletion with distributed gating, crash-safe local cleanup,
  and release hardening.

Current release-closure gates:

- Android backup disabled and merged-manifest permissions verified;
- real support, privacy, and terms values configured for production;
- reproducible Node/Yarn and EAS versioning configuration verified;
- preview APK tested without Metro;
- production build configuration audited;
- migrations `0001–0012` smoke-tested in an isolated environment;
- final Milestone 1 regression checklist signed off.

Milestone 2 must not begin until the final release audit is PASS or explicitly
accepted as a documented conditional release.

## Milestone 2 — Batch transcription

- `TranscriptionProvider` interface with one real provider.
- Automatic language detection.
- Single-language and multilingual transcription.
- English/Bahasa Indonesia code-switching.
- Transcript editor and version history.

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
