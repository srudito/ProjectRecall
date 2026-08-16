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
