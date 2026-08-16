# Milestone 2B.4A.4 — EN–ID Nullable Primary Compatibility v1

## Purpose

A controlled manual English + Bahasa Indonesia code-switching run reached the
AssemblyAI completed state but returned no `language_code`. The provider still
returned the reviewed `language_codes` pair. Milestone 2B.4A.3 classified the
shape without retaining raw provider data:

```text
TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_MISSING
```

The source checkpoint is
`fc5cf4a4fd44ccae4c68f924745122446f4bcff3` on `milestone1sync`.

## Narrow compatibility rule

The provider adapter now permits `primaryLanguage = null` only when the returned
language-code collection canonicalizes to exactly:

```text
["en", "id"]
```

This does not make a missing primary valid globally. Missing primary remains
invalid for:

- single-language transcription;
- automatic language detection;
- absent or null `language_codes`;
- a single returned language;
- malformed, unrelated, duplicate, or over-cardinality language collections.

The adapter does not invent a dominant language. It preserves:

```text
primaryLanguage = null
detectedLanguages = ["en", "id"]
segment.languageCode = null
```

## Worker boundary

The worker accepts a null primary only when all of these are true:

1. durable mode is `MULTILINGUAL`;
2. requested languages are canonical `en,id`;
3. detection is disabled;
4. detected languages normalize to exactly `en,id`;
5. segment language labels remain valid or null.

Single-language and automatic-detection claims still require a valid primary.
Existing provider cleanup, retry, lease, checksum, and atomic-ingestion behavior
is unchanged.

## Database contract

Migration `0015_transcription_nullable_primary_en_id.sql` is append-only. It
replaces only `transcription_language_summary_matches_request(jsonb, jsonb)` so
the atomic completion RPC can persist the same narrow null-primary shape.

The migration:

- does not edit or rerun migration 0014;
- does not alter a table, column, RLS policy, privilege, or trigger;
- keeps a primary mandatory for automatic and single-language modes;
- accepts null only for the exact manual EN–ID pair with detection disabled;
- preserves string-primary behavior including reviewed English locales.

A successful run therefore stores:

```text
transcription_runs.detected_languages = ["en", "id"]
transcription_runs.primary_detected_language = null
transcription_runs.language_detection_status = USER_CONFIRMED
transcript_versions.language_summary.primaryLanguage = null
```

## Security and evidence integrity

No raw provider response, language value outside existing transcript evidence,
signed URL, provider identifier, credential, worker token, service-role key, or
secret is added. The absence of a provider primary remains explicit instead of
being replaced with an arbitrary English or Indonesian value.

## Deployment boundary

After source validation and commit:

1. confirm and delete the failed diagnostic session through the app;
2. restore the development backend to zero;
3. apply only pending migration 0015 to development;
4. run the disposable 0015 behavior test;
5. deploy only `transcription-worker` from the same commit;
6. verify Cron HTTP 200 on the empty backend;
7. create one fresh controlled EN–ID session and request exactly once.

Production remains untouched. No mobile build, package, lockfile, native, Cron,
feature-flag, or secret change is required.

## Development acceptance result

Development acceptance completed against source commit
`fc911bc5a21b6af894d4e96f8d64ae89e9cd60bf`:

- migration 0015 was applied once after a zero-state precondition and its
  rollback-wrapped behavior test passed;
- `transcription-worker` v8 was deployed from the same commit with
  `verify_jwt = false` unchanged;
- post-deployment Cron execution and the corresponding HTTP path returned 200
  while the transcription backend remained empty;
- the controlled session `M2B4A EN-ID Gate 3 Nullable Primary` submitted one
  canonical `MULTILINGUAL` request with requested languages `["en", "id"]`;
- the job and run both succeeded on attempt 1;
- the durable run stored `detected_languages = ["en", "id"]`,
  `primary_detected_language = null`, and
  `language_detection_status = USER_CONFIRMED`;
- the current transcript stored `primaryLanguage = null`, the reviewed EN–ID
  pair, a content checksum, non-empty plain text, and 20 timestamped segments;
- all 20 segment language labels remained null rather than inventing a dominant
  language;
- Full Text and Timestamps were both readable from the local application cache;
- provider cleanup succeeded with no unresolved artifact or manual-review row;
- the test session was deleted through the application and the development
  backend returned to zero jobs, runs, versions, and segments.

Production was not changed.

## Operational closure

- Migration 0015 must not be rerun on the linked development environment.
- Worker v8 does not need redeployment unless a later source change requires it.
- A null provider primary remains valid only for the reviewed manual EN–ID pair;
  no broader nullable-primary behavior was enabled.
