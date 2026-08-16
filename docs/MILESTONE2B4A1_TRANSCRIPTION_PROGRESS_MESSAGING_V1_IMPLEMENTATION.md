# Milestone 2B.4A.1 — Transcription Progress Messaging UX v1

## Purpose

This patch hardens the native transcription request UI after the controlled
English single-language Gate 1 exposed a misleading state: a retryable result
read temporarily displayed the safe diagnostic in red even though the durable
job continued processing and later completed successfully.

The source checkpoint is
`bbf92a7c5d53e710d5d9ed55338d40ec3f4f002a` on `milestone1sync`.
The English Gate 1 passed durable job/run, local transcript, provider cleanup,
and controlled test-artifact cleanup before this UI-only patch began.

## Problem

`local_transcription_request_queue.last_error_code` and `last_safe_error` carry
both terminal failures and non-terminal result-sync diagnostics. The result
worker deliberately persists ordinary progress using codes such as:

```text
TRANSCRIPTION_RESULT_PROCESSING
TRANSCRIPTION_RESULT_COMMIT_PENDING
TRANSCRIPTION_RESULT_CLEANUP_PENDING
```

It also persists retryable transport/query diagnostics while keeping the queue
in `submitted` state and scheduling another poll.

The prior UI rendered every `last_safe_error` as an accessibility alert in the
recording error color. That made temporary synchronization delay look like a
terminal transcription failure.

## Presentation boundary

`request-presentation.ts` is a pure presentation resolver. It does not alter
queue state, retry count, wake scheduling, server requests, or provider work.

Presentation rules:

```text
pending / submitting
  -> ordinary queue/request progress
  -> retry diagnostic, if present, is warning-toned and auto-retry copy

submitted + no diagnostic
  -> request accepted; waiting for processing

submitted + TRANSCRIPTION_RESULT_PROCESSING
  -> Transcription processing…

submitted + TRANSCRIPTION_RESULT_COMMIT_PENDING
  -> Finalizing transcript…

submitted + TRANSCRIPTION_RESULT_CLEANUP_PENDING
  -> Finishing secure cleanup…

submitted + other retry diagnostic
  -> warning-toned automatic retry message
  -> raw safe diagnostic is not shown as a red terminal error

failed / cancelled
  -> terminal treatment
  -> raw safe error may be shown in the existing red alert treatment
```

## Local ready state

The request control also reads the existing local current transcript version.
When the transcript has already been persisted by the result worker, the control
shows `Transcript ready` instead of leaving the disabled button/status at the
older `Transcription requested` wording.

This ready signal is local SQLite only. The component does not add a Supabase
read, Edge Function invocation, provider call, or remote status endpoint.
Existing transcription sync events already refresh the control after local
result persistence.

## Localization

English and Bahasa Indonesia receive matching progress keys for waiting,
processing, finalizing, secure cleanup, retrying, and ready states. Retryable
worker diagnostics are therefore no longer displayed as raw English text in an
Indonesian UI.

## Out of scope

This patch does not change:

- Supabase migrations or RLS;
- Edge Functions or worker deployment;
- result-worker polling delays or backoff;
- request queue schema or SQLite migration version;
- provider adapter behavior;
- provider cleanup rules;
- feature flags or Cron;
- native dependencies or APK configuration;
- transcript content, editor behavior, or playback seeking.

Controlled Bahasa Indonesia and EN–ID live gates remain separate work after
this patch passes source validation and commit/push.
