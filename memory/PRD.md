# Product Requirements Document (PRD)

## Project Recall — Milestone 1

**Tagline:** *Capture every conversation. Remember every detail.*

An Android-first multimodal recording and knowledge-capture application. This
document tracks Milestone 1 scope, which is the foundation for later
transcription and AI milestones.

## Vision (long-term)

Give professionals a trustworthy place to record every conversation, attach
supporting evidence, and later transcribe, summarise, and search across their
knowledge base — all with strong privacy controls, first-class multilingual
support (including English + Bahasa Indonesia code-switching), and honest
handling of AI/ML capability limits.

## Milestone 1 scope (delivered)

**In scope**
- Real Supabase Authentication (email/password + verification + reset + persistent session + sign out).
- Personal workspace + owner membership created automatically on sign-up (DB trigger).
- Projects & sessions with expected spoken-language preferences.
- Real microphone recording with pause/resume/stop, offset tracking that excludes paused time, and a visible active-recording state.
- Add evidence during a recording: photo (camera / library), video (library), document (system picker), text notes, timestamped bookmarks.
- Chronological session timeline sorted by offset → created_at → id.
- Durable local persistence (SQLite metadata + app-controlled file directory).
- Upload queue with idempotency, exponential backoff with jitter, and manual retry.
- Private Supabase Storage bucket (`session-assets`) scoped by workspace via RLS.
- English + Bahasa Indonesia UI with English fallback.
- Light / Dark / Follow-system themes with centralised tokens.

**Out of scope (explicitly hidden, flags off)**
- Batch transcription, live transcription, streaming to AI providers.
- OCR, image / video / document analysis, embeddings, Ask AI, source citations.
- Multi-provider selection, BYOK, provider routing.
- Subscription, billing, credits, advertising, admin control panel.
- Team collaboration, public sharing, PDF reports.
- Call recording, meeting bots, real-time translation.

## Users & jobs

- **Individual professionals** who capture 1:1 or small-group conversations
  and later want to review them. Milestone 1 delivers the capture surface;
  Milestone 2+ delivers transcription and search.
- **Enterprise pilots** evaluating whether the platform can grow into a
  trusted knowledge base later. Milestone 1 must therefore land as a calm,
  premium, distraction-free tool with strong privacy defaults.

## Success metrics

- % of sign-ups that complete their first recording
- % of first recordings that reach the "recorded" state without a state-machine
  failure
- Median time from Stop → Review screen
- Retry success rate on the upload queue
- Crash-free sessions

## Non-negotiable acceptance items (verified where possible)

See `docs/README.md`. Highlights that pass in this environment:

- English is the default language and Bahasa Indonesia switches instantly.
- App language ≠ spoken language (separate fields, separate settings).
- No fake detected-language values are ever generated.
- No AI provider is called.
- Ask AI / Transcription / Billing / Ads / Admin screens are all hidden.
- TypeScript type checking passes.
- All 52 mobile unit tests pass. All 6 backend tests pass.
- Supabase migrations, RLS policies, storage policies committed to the repo.

Items that require a physical Android device with a development build are
enumerated in `docs/ANDROID_TEST_CHECKLIST.md` and reported as pending.
