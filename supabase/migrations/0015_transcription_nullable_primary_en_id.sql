-- ============================================================================
-- 0015_transcription_nullable_primary_en_id.sql
-- Milestone 2B.4A.4: permit a null provider primary only for the reviewed,
-- user-confirmed manual EN-ID completed-result shape.
--
-- This append-only migration replaces one immutable validation helper. It does
-- not alter tables, RLS, privileges, request intent, retry behavior, cleanup,
-- secrets, Cron, or production feature activation.
-- ============================================================================

begin;

create or replace function public.transcription_language_summary_matches_request(
  p_request_payload jsonb,
  p_language_summary jsonb
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  mode_value text;
  requested_values text[];
  detected_values text[];
  normalized_detected_values text[];
  primary_value text;
  normalized_primary text;
  detection_enabled boolean;
  confidence_value numeric;
begin
  if not public.transcription_request_payload_is_valid(p_request_payload)
     or p_language_summary is null
     or jsonb_typeof(p_language_summary) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_language_summary) key)
       is distinct from array[
         'confidence','detectedLanguages','detectionEnabled','primaryLanguage'
       ]::text[]
     or jsonb_typeof(p_language_summary->'primaryLanguage') not in ('string','null')
     or jsonb_typeof(p_language_summary->'detectedLanguages') <> 'array'
     or jsonb_typeof(p_language_summary->'detectionEnabled') <> 'boolean'
     or jsonb_array_length(p_language_summary->'detectedLanguages') not between 1 and 2 then
    return false;
  end if;

  mode_value := p_request_payload->>'languageMode';

  select coalesce(array_agg(value order by ordinal), array[]::text[])
    into requested_values
  from jsonb_array_elements_text(p_request_payload->'requestedLanguages')
    with ordinality as language(value, ordinal);

  select coalesce(array_agg(value order by ordinal), array[]::text[])
    into detected_values
  from jsonb_array_elements_text(p_language_summary->'detectedLanguages')
    with ordinality as language(value, ordinal);

  if cardinality(detected_values) <> cardinality(array(
       select distinct value from unnest(detected_values) value
     ))
     or exists (
       select 1 from unnest(detected_values) value
       where not public.transcription_language_code_is_supported(value)
     ) then
    return false;
  end if;

  primary_value := p_language_summary->>'primaryLanguage';
  if primary_value is not null
     and (
       not public.transcription_language_code_is_supported(primary_value)
       or not (primary_value = any(detected_values))
     ) then
    return false;
  end if;

  if jsonb_typeof(p_language_summary->'confidence') = 'null' then
    confidence_value := null;
  elsif jsonb_typeof(p_language_summary->'confidence') = 'number' then
    confidence_value := (p_language_summary->>'confidence')::numeric;
    if confidence_value < 0 or confidence_value > 1 then
      return false;
    end if;
  else
    return false;
  end if;

  detection_enabled := (p_language_summary->>'detectionEnabled')::boolean;
  normalized_detected_values := array(
    select case when value in ('en','en-au','en-uk','en-us') then 'en' else value end
    from unnest(detected_values) value
  );
  normalized_primary := case
    when primary_value is null then null
    when primary_value in ('en','en-au','en-uk','en-us') then 'en'
    else primary_value
  end;

  if mode_value = 'AUTO_DETECT' then
    return detection_enabled and normalized_primary is not null;
  end if;

  if detection_enabled then
    return false;
  end if;

  if mode_value = 'SINGLE_LANGUAGE' then
    return normalized_primary is not null
      and cardinality(requested_values) = 1
      and cardinality(normalized_detected_values) = 1
      and normalized_primary = requested_values[1]
      and normalized_detected_values[1] = requested_values[1];
  end if;

  return cardinality(normalized_detected_values) = 2
    and array(
      select distinct value
      from unnest(normalized_detected_values) value
      order by value
    ) = array['en','id']::text[]
    and (
      normalized_primary is null
      or normalized_primary = any(array['en','id']::text[])
    );
exception
  when others then
    return false;
end;
$$;

comment on function public.transcription_language_summary_matches_request(jsonb, jsonb)
  is 'Validates provider language evidence; a null primary is accepted only for the reviewed user-confirmed manual EN-ID pair.';

commit;
