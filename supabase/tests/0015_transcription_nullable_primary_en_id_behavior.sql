-- Milestone 2B.4A.4 disposable PostgreSQL behavior verification.
-- Run only after migrations 0001-0015 on a disposable or linked development
-- project. This transaction changes no durable rows and is rolled back.

begin;

do $$
declare
  multilingual_request jsonb := '{"contractVersion":1,"languageMode":"MULTILINGUAL","requestedLanguages":["en","id"],"speakerDiarization":false}'::jsonb;
  single_request jsonb := '{"contractVersion":1,"languageMode":"SINGLE_LANGUAGE","requestedLanguages":["id"],"speakerDiarization":false}'::jsonb;
  auto_request jsonb := '{"contractVersion":1,"languageMode":"AUTO_DETECT","requestedLanguages":[],"speakerDiarization":false}'::jsonb;
  nullable_pair jsonb := '{"confidence":null,"detectedLanguages":["en","id"],"detectionEnabled":false,"primaryLanguage":null}'::jsonb;
  nullable_single jsonb := '{"confidence":null,"detectedLanguages":["id"],"detectionEnabled":false,"primaryLanguage":null}'::jsonb;
  nullable_detecting jsonb := '{"confidence":null,"detectedLanguages":["en","id"],"detectionEnabled":true,"primaryLanguage":null}'::jsonb;
  string_primary jsonb := '{"confidence":0.9,"detectedLanguages":["en-us","id"],"detectionEnabled":false,"primaryLanguage":"en-us"}'::jsonb;
begin
  if not public.transcription_language_summary_matches_request(
    multilingual_request,
    nullable_pair
  ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_NULLABLE_PRIMARY_MULTILINGUAL_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_NULLABLE_PRIMARY_MULTILINGUAL_CHECK=PASS';

  if public.transcription_language_summary_matches_request(
    single_request,
    nullable_single
  ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_NULLABLE_PRIMARY_SINGLE_LANGUAGE_REJECTION_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_NULLABLE_PRIMARY_SINGLE_LANGUAGE_REJECTION_CHECK=PASS';

  if public.transcription_language_summary_matches_request(
    auto_request,
    nullable_pair
  ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_NULLABLE_PRIMARY_AUTO_DETECT_REJECTION_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_NULLABLE_PRIMARY_AUTO_DETECT_REJECTION_CHECK=PASS';

  if public.transcription_language_summary_matches_request(
    multilingual_request,
    nullable_single
  ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_NULLABLE_PRIMARY_PAIR_REQUIREMENT_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_NULLABLE_PRIMARY_PAIR_REQUIREMENT_CHECK=PASS';

  if public.transcription_language_summary_matches_request(
    multilingual_request,
    nullable_detecting
  ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_NULLABLE_PRIMARY_DETECTION_REJECTION_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_NULLABLE_PRIMARY_DETECTION_REJECTION_CHECK=PASS';

  if not public.transcription_language_summary_matches_request(
    multilingual_request,
    string_primary
  ) then
    raise exception using errcode = 'P0001', message = 'TRANSCRIPTION_STRING_PRIMARY_REGRESSION_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_STRING_PRIMARY_REGRESSION_CHECK=PASS';

  raise notice 'PROJECT_RECALL_TRANSCRIPTION_NULLABLE_PRIMARY_BEHAVIOR=PASS';
end;
$$;

rollback;
