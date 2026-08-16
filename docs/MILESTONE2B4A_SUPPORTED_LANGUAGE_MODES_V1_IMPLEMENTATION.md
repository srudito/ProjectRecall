# Milestone 2B.4A — Supported Language Modes and EN–ID Code-Switching UX v1

## Purpose

This milestone aligns native session setup and local transcription contracts
with the reviewed development transcription intake already deployed in
migration `0014`.

Before this change, Record Setup exposed the general spoken-language catalog.
That catalog is useful for broader product preferences, but the active manual
transcription rollout accepts only:

- English single-language transcription;
- Bahasa Indonesia single-language transcription;
- English + Bahasa Indonesia code-switching;
- automatic language detection without a required manual hint.

Unsupported selections could therefore be saved locally and fail only after a
later transcription request reached the server. This milestone removes that
avoidable mismatch without widening provider or server capabilities.

The source checkpoint is `07fabe5` on `milestone1sync`, after the timestamped
local transcript browser passed online/offline acceptance.

## Capability contract

`language-capabilities.ts` is the single frontend transcription capability
boundary. It mirrors the existing server request normalization:

```text
English aliases accepted by server
  en, en-AU, en-GB, en-UK, en-US
  -> canonical en

Bahasa Indonesia
  id
  -> canonical id

AUTO_DETECT
  -> no manual choice required
  -> optional reviewed hints normalize to en/id

SINGLE_LANGUAGE
  -> exactly one canonical language: en or id

MULTILINGUAL
  -> exactly the fixed canonical pair: en + id
```

Well-formed but unsupported codes fail with
`TRANSCRIPTION_LANGUAGE_UNSUPPORTED`. Malformed values and invalid mode
cardinality remain separate safe local errors.

## Record Setup behavior

The unrestricted transcription picker is removed from `/record/setup`.
The general `spokenLanguageCatalog` remains available elsewhere for
non-transcription product language metadata.

Record Setup now behaves as follows:

```text
Auto detect
  -> no language buttons
  -> saved selection []

One language
  -> English or Bahasa Indonesia
  -> exactly one selected value

English + Bahasa Indonesia
  -> fixed pair selected by the mode
  -> no unsupported combination can be created
```

Switching modes is deterministic:

- Auto detect clears manual values;
- One language preserves the first supported current value when possible;
- Code-switching always restores `["en", "id"]`.

## Local request and idempotency safety

The same capability resolver is used by the provider-neutral request contract.
A session created outside the setup screen cannot silently pass an unsupported
manual language into the local request queue.

Before a request is prepared:

1. raw language values are validated;
2. supported aliases are canonicalized;
3. mode cardinality is enforced;
4. the idempotency fingerprint is built only from canonical values.

This keeps equivalent English aliases on the same stable request fingerprint
and prevents unsupported languages from being silently dropped into a
colliding key.

## Security boundary

This milestone adds no provider execution to React Native. The client still:

- invokes only the authenticated `transcription-request` function through the
  existing request worker;
- receives no AssemblyAI API key or worker token;
- stores no service-role credential;
- cannot bypass the server feature flag or RLS;
- does not broaden the deployed server language rules.

The server remains authoritative and repeats all language normalization and
validation under the existing request RPC.

## No migration or deployment change

This milestone requires no:

- Supabase migration;
- Edge Function change or deployment;
- SQLite migration;
- provider secret rotation;
- Cron change;
- feature-flag change;
- native dependency or APK rebuild.

An existing development build can load the JavaScript changes through Metro.
Live language-mode acceptance is performed only after source validation,
commit, and push, with English, Bahasa Indonesia, and EN–ID code-switching
validated as separate controlled tests.
