# Roadmap

Milestone 1 is still being closed in verified, dependency-ordered passes.

## Milestone 1 — Capture and cloud foundation

Completed and verified before this pass:

- Supabase authentication and personal workspace creation;
- project and session local-to-cloud synchronization;
- dependency-ordered offline retry with stable UUIDs;
- session lifecycle, duration, language settings, and cloud-to-local merge;
- note, bookmark, and recording/timeline-event synchronization;
- web timeline reads and native cloud-to-local restoration;
- durable primary recording metadata and private audio Storage upload;
- signed audio playback, Wi-Fi-only upload, reinstall recovery, and Storage RLS
  smoke tests.

Completed and verified in Evidence Storage Sync v1:

- durable local persistence for image, video, and document evidence;
- media metadata synchronization to `public.media_assets`;
- private binary upload to `session-assets`;
- session-before-evidence and evidence-before-timeline dependency ordering;
- signed image/video/document restoration on web and native;
- offline retry, Wi-Fi-only behavior, and stable media UUIDs/Storage paths.

Implemented in the current Cloud-Aware Deletion v1 pass and awaiting
real-environment verification:

- durable offline session deletion queue;
- recording, note, bookmark, timeline, and evidence database cleanup;
- private Storage prefix deletion and orphan discovery;
- local recording/evidence file cleanup;
- restart-safe partial-deletion recovery.

Remaining Milestone 1 work:

- audio-attachment evidence and post-recording Add Evidence UI;
- project-level deletion and cleanup management UI;
- remaining playback, timeline-seek, onboarding, and edit-flow gaps;
- Android development-build verification, including picker interruptions and
  background recording;
- authentication hardening/social login before public beta.

Completed in Starred Sessions v1:

- personal per-user session stars on Card and Compact views;
- Starred filter and Starred-first sort;
- local-first offline persistence and cloud restoration;
- self-only RLS and session-deletion cascade cleanup.

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
