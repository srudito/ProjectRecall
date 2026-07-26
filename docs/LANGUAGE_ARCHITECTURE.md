# Language Architecture

Two concepts, never conflated:

- **Application language** — the language of the UI. Field: `app_language`.
- **Spoken language(s)** — the language(s) the user speaks in a recording.
  Fields on session: `spoken_language_mode`, `expected_spoken_languages`.

## Application language

- Default: `en`.
- Persisted per user in `profiles.app_language` and locally via the i18n
  provider.
- English is the fallback for missing Indonesian strings. Missing keys never
  render as `error.code`-style dots — they display the English value.

## Spoken language mode

`AUTO_DETECT | SINGLE_LANGUAGE | MULTILINGUAL`.

- AUTO_DETECT: stored preference only. Milestone 1 never runs detection.
- SINGLE_LANGUAGE: exactly one BCP 47 tag.
- MULTILINGUAL: two or more BCP 47 tags. Enables code-switching support in
  future transcription milestones (e.g. English + Bahasa Indonesia).

`services/language/precedence.ts` implements validation and precedence.

## Future language fields (persisted, unused in M1)

- `summary_output_language`
- `translation_target_language`
- `transcript_display_mode` (`ORIGINAL | TRANSLATED | BILINGUAL`)
- `detected_spoken_languages`, `primary_detected_language`,
  `language_detection_status` (`NOT_STARTED` in M1)
- `preserve_original_language`, `prefer_bilingual_view`

## Precedence

For any effective spoken-language value on a new session:

```
session-specific  →  project default  →  user default  →  app default (en)
```

Milestone 1 never mutates any of the future fields with fabricated values.

## BCP 47 tags

The catalog in `src/i18n/languages.ts` includes at least 20 languages,
including English, Bahasa Indonesia, Malay, Mandarin (Simplified + Traditional),
Cantonese, Japanese, Korean, Spanish, French, German, Italian, Portuguese
(BR + PT), Dutch, Arabic, Hindi, Thai, Vietnamese, Filipino, Russian, Turkish,
Polish. The set is filterable and does not hard-code any provider capability.
