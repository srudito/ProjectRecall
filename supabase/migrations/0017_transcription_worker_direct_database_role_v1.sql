-- ============================================================================
-- 0017_transcription_worker_direct_database_role_v1.sql
-- C2G.3E-R1: least-privilege login role for direct PostgreSQL worker calls.
--
-- This append-only migration creates no password and changes no application
-- table, RLS policy, trigger, data, feature flag, secret, Cron job, or function
-- body. The role can connect, use public, and execute only the eleven existing
-- SECURITY DEFINER worker functions used by transcription-worker.
-- ============================================================================

begin;

do $$
declare
  worker_role constant text := 'project_recall_transcription_worker';
  existing_role record;
  membership_count integer;
begin
  select
    role.rolname,
    role.rolsuper,
    role.rolinherit,
    role.rolcreaterole,
    role.rolcreatedb,
    role.rolcanlogin,
    role.rolreplication,
    role.rolbypassrls
  into existing_role
  from pg_catalog.pg_roles role
  where role.rolname = worker_role;

  if not found then
    execute format(
      'create role %I login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password null',
      worker_role
    );
  else
    if existing_role.rolsuper
       or existing_role.rolinherit
       or existing_role.rolcreaterole
       or existing_role.rolcreatedb
       or not existing_role.rolcanlogin
       or existing_role.rolreplication
       or existing_role.rolbypassrls then
      raise exception using
        errcode = 'P0001',
        message = 'TRANSCRIPTION_WORKER_DATABASE_ROLE_DRIFT';
    end if;

    select count(*)::integer
      into membership_count
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles member_role
      on member_role.oid = membership.member
    join pg_catalog.pg_roles granted_role
      on granted_role.oid = membership.roleid
    where member_role.rolname = worker_role
       or granted_role.rolname = worker_role;

    if membership_count <> 0 then
      raise exception using
        errcode = 'P0001',
        message = 'TRANSCRIPTION_WORKER_DATABASE_ROLE_MEMBERSHIP_DRIFT';
    end if;
  end if;
end;
$$;

do $$
declare
  worker_role constant text := 'project_recall_transcription_worker';
begin
  execute format(
    'revoke all privileges on database %I from %I',
    current_database(),
    worker_role
  );
  execute format(
    'grant connect on database %I to %I',
    current_database(),
    worker_role
  );
end;
$$;

revoke all on schema public
  from project_recall_transcription_worker;
grant usage on schema public
  to project_recall_transcription_worker;

revoke all on schema extensions
  from project_recall_transcription_worker;

revoke all privileges on all tables in schema public
  from project_recall_transcription_worker;
revoke all privileges on all sequences in schema public
  from project_recall_transcription_worker;
revoke execute on all functions in schema public
  from project_recall_transcription_worker;

grant execute on function
  public.recover_expired_transcription_work(integer)
  to project_recall_transcription_worker;

grant execute on function
  public.claim_transcription_jobs(text, integer, integer)
  to project_recall_transcription_worker;

grant execute on function
  public.begin_transcription_submission(uuid, uuid, text)
  to project_recall_transcription_worker;

grant execute on function
  public.mark_transcription_job_submitted(
    uuid,
    uuid,
    text,
    text,
    jsonb,
    integer,
    integer
  )
  to project_recall_transcription_worker;

grant execute on function
  public.record_transcription_submission_failure(
    uuid,
    uuid,
    text,
    text,
    text,
    boolean,
    text,
    integer
  )
  to project_recall_transcription_worker;

grant execute on function
  public.record_transcription_poll_result(
    uuid,
    uuid,
    text,
    jsonb,
    integer
  )
  to project_recall_transcription_worker;

grant execute on function
  public.record_transcription_poll_failure(
    uuid,
    uuid,
    text,
    text,
    text,
    boolean,
    boolean,
    integer
  )
  to project_recall_transcription_worker;

grant execute on function
  public.complete_transcription_job(
    uuid,
    uuid,
    text,
    text,
    text,
    jsonb,
    jsonb,
    jsonb,
    text
  )
  to project_recall_transcription_worker;

grant execute on function
  public.claim_transcription_cleanup(text, integer, integer)
  to project_recall_transcription_worker;

grant execute on function
  public.complete_transcription_cleanup(uuid, text, text)
  to project_recall_transcription_worker;

grant execute on function
  public.fail_transcription_cleanup(
    uuid,
    text,
    text,
    text,
    boolean,
    integer
  )
  to project_recall_transcription_worker;

comment on role project_recall_transcription_worker is
  'Least-privilege login role for Project Recall transcription-worker direct PostgreSQL function calls; password provisioned outside migrations.';

commit;
