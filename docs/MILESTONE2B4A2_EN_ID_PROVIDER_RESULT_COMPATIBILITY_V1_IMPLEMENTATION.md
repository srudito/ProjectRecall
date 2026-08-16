# Milestone 2B.4A.2 — EN–ID Provider Result Compatibility v1

## Purpose

This milestone hardens the server-only AssemblyAI result boundary after the
controlled English + Bahasa Indonesia Gate 3 reached provider execution but
failed before transcript ingestion with:

```text
TRANSCRIPTION_PROVIDER_RESULT_INVALID
```

The failed run proved that the mobile and durable request contracts were
correct:

```text
languageMode = MULTILINGUAL
requestedLanguages = ["en", "id"]
```

The provider artifact was also deleted successfully, with no unresolved cleanup
or manual-review state. The failure was isolated to completed-result
normalization or claim validation.

The source checkpoint is
`432ca8abfdccc19e337e1fb40646e40eca9f21b5` on `milestone1sync`.

## Compatibility boundary

The AssemblyAI pre-recorded transcript response contract permits
`language_codes` to be nullable and may report English using a reviewed locale
variant such as `en_us` or `en_uk`.

The previous adapter already tolerated an omitted or null `language_codes` field,
but it accepted only canonical `en` or `id` when the array was present. The
worker also required the completed multilingual summary to contain both
languages before it could use the already-reviewed request intent.

This milestone changes only completed-result interpretation:

- reviewed English response locales normalize to canonical `en` for the
  configured code-switching pair;
- the documented `language_codes = null` shape remains accepted and now has an
  explicit regression test;
- a single returned English locale remains exact for a single-language result;
- the provider-returned primary language is preserved;
- the manual `MULTILINGUAL ["en", "id"]` claim may reconcile a response that
  reports either the full pair or only its primary language;
- the reconciled durable summary carries the reviewed user-confirmed pair while
  preserving the provider primary language;
- per-word language labels are cleared for this path because the response does
  not provide trustworthy word-level language attribution.

Reconciliation is deliberately narrow. It runs only when all of these are true:

1. the durable claim mode is `MULTILINGUAL`;
2. the canonical request pair is exactly `["en", "id"]`;
3. provider language detection is not enabled;
4. the provider primary is a reviewed English variant or `id`;
5. provider metadata reports either the reviewed pair or only that primary.

Unrelated languages, malformed arrays, duplicate canonical languages, unsafe
text, invalid timestamps, unexpected model provenance, and detection-mode
mismatches still fail closed.

## Sanitized diagnostics

`TRANSCRIPTION_PROVIDER_RESULT_INVALID` remains the provider failure class and
keeps the same safe user-facing message. The worker may now persist one bounded
internal diagnostic code instead of the generic code:

```text
TRANSCRIPTION_PROVIDER_RESULT_ENVELOPE_INVALID
TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_METADATA_INVALID
TRANSCRIPTION_PROVIDER_RESULT_WORDS_INVALID
TRANSCRIPTION_PROVIDER_RESULT_TEXT_INVALID
TRANSCRIPTION_PROVIDER_RESULT_MODEL_METADATA_INVALID
TRANSCRIPTION_PROVIDER_RESULT_CLAIM_SHAPE_INVALID
TRANSCRIPTION_PROVIDER_RESULT_CLAIM_LANGUAGE_INVALID
TRANSCRIPTION_PROVIDER_RESULT_CLAIM_METADATA_INVALID
TRANSCRIPTION_PROVIDER_RESULT_CLAIM_SEGMENTS_INVALID
```

These codes contain no provider response body, transcript text, signed URL,
provider job identifier, credential, or secret. They are intended only to make a
future controlled failure diagnosable without retaining raw provider artifacts.

## Durable semantics

This milestone does not change:

- stable request idempotency;
- job/run leases or retry counts;
- polling intervals or backoff;
- provider cleanup requirements;
- atomic transcript completion;
- RLS or table privileges;
- the mobile request queue;
- transcript local persistence or UI behavior.

A successful reconciled result still passes the existing worker validation and
the deployed atomic completion RPC. The run remains `USER_CONFIRMED` because the
language pair came from the explicit user request rather than automatic
language detection.

## Deployment boundary

This source change requires redeploying only the development
`transcription-worker` Edge Function after commit and push. It requires no:

- Supabase migration;
- database function rewrite;
- transcription-request deployment;
- secret rotation;
- Cron change;
- feature-flag change;
- SQLite migration;
- native dependency or APK rebuild.

Production remains untouched.

## Controlled rerun

The previous failed Gate 3 row must not be retried in place because the stable
idempotency key points to a terminal server job. After its provider cleanup is
confirmed, remove that test session through the existing application deletion
flow and verify the backend returns to zero. Then deploy the updated development
worker and create one fresh short EN–ID test session and one request.
