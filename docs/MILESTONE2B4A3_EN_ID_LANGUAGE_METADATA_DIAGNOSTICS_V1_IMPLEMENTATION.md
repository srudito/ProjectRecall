# Milestone 2B.4A.3 - EN–ID Language Metadata Shape Diagnostics v1

## Purpose

The controlled EN–ID Gate 3 diagnostic rerun reached the deployed development
transcription worker and failed before transcript ingestion with the bounded
code:

```text
TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_METADATA_INVALID
```

The durable request remained correct:

```text
languageMode = MULTILINGUAL
requestedLanguages = ["en", "id"]
```

The provider artifact was deleted successfully, with no unresolved cleanup or
manual-review state. The remaining failure is therefore inside the completed
AssemblyAI language metadata boundary, before words, claim reconciliation, or
database completion can succeed.

The source checkpoint is
`0e2b87047752bcddf15c79c11723af9f2a20e409` on `milestone1sync`.

## Diagnostic-only boundary

This milestone does not broaden accepted provider response shapes. It only
replaces the aggregate language-metadata diagnostic with bounded structural
categories:

```text
TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_MISSING
TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_LANGUAGE_INVALID
TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_SHAPE_INVALID
TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_EMPTY
TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_MEMBER_INVALID
TRANSCRIPTION_PROVIDER_RESULT_LANGUAGE_CODES_DUPLICATE
TRANSCRIPTION_PROVIDER_RESULT_PRIMARY_NOT_IN_LANGUAGE_CODES
```

The existing aggregate code remains part of the durable diagnostic type so
historical rows remain interpretable, but new AssemblyAI completed-result
language failures use one of the structural codes above.

## Classification order

After the existing envelope and words-shape checks, the adapter classifies
language metadata deterministically:

1. `language_code` null or omitted -> primary language missing.
2. A present primary that is malformed, unsafe, or unsupported -> primary
   language invalid.
3. A present `language_codes` value that is not a dense array, or has more
   than two entries -> language-codes shape invalid.
4. A present empty `language_codes` array -> language-codes empty.
5. A null, malformed, unsupported, or non-reviewed array member ->
   language-codes member invalid.
6. Canonical duplicates, including English locale aliases that collapse to
   `en`, -> language-codes duplicate.
7. A valid primary that is not represented by a non-empty returned language set
   -> primary not in language codes.

An omitted or null `language_codes` field remains accepted exactly as it was
in Milestone 2B.4A.2. Request construction, English-locale normalization, manual
EN–ID reconciliation, and word-language clearing are unchanged.

## Safe diagnostics

The user-facing provider failure remains:

```text
The transcription provider returned an invalid result.
```

Only the bounded diagnostic code is persisted internally. No raw provider
response, language value, transcript text, signed audio URL, provider job
identifier, credential, token, or secret is added to the diagnostic.

## No behavior or schema change

This milestone changes no:

- provider submission request;
- accepted completed-result shape;
- worker retry, lease, or polling behavior;
- provider cleanup semantics;
- atomic transcript completion RPC;
- database migration, RLS, or privilege;
- SQLite schema or local queue;
- React Native UI;
- feature flag or Cron configuration;
- package, lockfile, or native dependency.

## Deployment and controlled rerun

After commit and push, deploy only the development `transcription-worker`.
Confirm the failed `M2B4A EN–ID Gate 3 Retry` artifact cleanup is succeeded,
delete that session through the application, and verify the backend returns to
zero before deployment.

Then create exactly one fresh session:

```text
Title: M2B4A EN–ID Gate 3 Diagnostic
Mode: MULTILINGUAL
Expected languages: en, id
```

If it succeeds, continue the normal transcript and cleanup acceptance. If it
fails, do not retry. Read only the new diagnostic code, confirm provider
cleanup, and use that one structural category to define the next bounded
compatibility change.
