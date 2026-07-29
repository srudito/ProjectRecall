# Roadmap

Milestone 1 is still being closed in verified, dependency-ordered passes.

## Milestone 1 — Capture and cloud foundation

Completed and verified before this pass:

- Supabase authentication and personal workspace creation;
- project local-to-cloud synchronization;
- project offline retry, stable UUID, and RLS isolation;
- session metadata synchronization;
- project-before-session dependency ordering;
- session lifecycle, duration, language settings, and cloud-to-local merge.

Implemented in the current Note/Bookmark/Timeline Sync v1 pass and awaiting
real-environment verification:

- note and bookmark local-to-cloud synchronization;
- recording lifecycle and note/bookmark timeline synchronization;
- session-before-content and source-before-timeline dependency ordering;
- web timeline reads and native cloud-to-local restoration;
- offline retry and stable content UUIDs.

Remaining Milestone 1 work:

- recording and media metadata synchronization;
- binary upload to private `session-assets` Storage;
- durable cloud-aware deletion and cleanup;
- remaining playback, timeline-seek, onboarding, and edit-flow gaps;
- Android development-build verification.

## Milestone 2 — Batch transcription

- `TranscriptionProvider` interface with a single real provider.
- Automatic language detection.
- Single-language transcription.
- Multilingual transcription with English and Bahasa Indonesia code-switching.
- Transcript editor.
- Multiple transcript versions.

## Milestone 3 — Multimodal analysis

- OCR.
- Document text extraction.
- Image captioning.
- AI summaries, decisions, and action items.

## Milestone 4 — Knowledge base

- Historical embeddings.
- Hybrid search.
- Ask AI with exact source citations.

## Milestone 5 — Live transcription

- Live draft transcript and final verified transcript.
- Reconnection handling.
- Live language detection and multilingual output.
- Live bilingual subtitles.
- Live translation.

## Milestone 6 — Multi-provider

- Provider registry, selection, routing, and fallback.
- BYOK support.

## Milestone 7 — Commerce

- Subscription.
- Credit purchases.
- Advertising, including optional rewarded ads.
- Administration control panel.
