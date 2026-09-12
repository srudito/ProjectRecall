-- C2G.3E-R1 disposable/read-only role contract verification.
-- Run only after migration 0017. This script changes no database state.

begin transaction read only;

do $$
<<role_contract>>
declare
  worker_role constant text := 'project_recall_transcription_worker';
  worker_role_oid oid;
  worker_role_record record;
  outbound_membership_count integer;
  inbound_membership_count integer;
  invalid_inbound_membership_count integer;
  direct_table_acl_count integer;
  direct_sequence_acl_count integer;
  direct_function_acl_count integer;
  granted_worker_function_count integer;
  operator_function_count integer;
  expected_worker_functions constant text[] := array[
    'public.recover_expired_transcription_work(integer)',
    'public.claim_transcription_jobs(text,integer,integer)',
    'public.begin_transcription_submission(uuid,uuid,text)',
    'public.mark_transcription_job_submitted(uuid,uuid,text,text,jsonb,integer,integer)',
    'public.record_transcription_submission_failure(uuid,uuid,text,text,text,boolean,text,integer)',
    'public.record_transcription_poll_result(uuid,uuid,text,jsonb,integer)',
    'public.record_transcription_poll_failure(uuid,uuid,text,text,text,boolean,boolean,integer)',
    'public.complete_transcription_job(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text)',
    'public.claim_transcription_cleanup(text,integer,integer)',
    'public.complete_transcription_cleanup(uuid,text,text)',
    'public.fail_transcription_cleanup(uuid,text,text,text,boolean,integer)'
  ]::text[];
  function_signature text;
begin
  select role.*
    into worker_role_record
  from pg_catalog.pg_roles role
  where role.rolname = worker_role;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_WORKER_DATABASE_ROLE_ATTRIBUTE_CHECK_FAILED';
  end if;

  worker_role_oid := worker_role_record.oid;

  if worker_role_oid is null
     or worker_role_record.rolsuper
     or worker_role_record.rolinherit
     or worker_role_record.rolcreaterole
     or worker_role_record.rolcreatedb
     or not worker_role_record.rolcanlogin
     or worker_role_record.rolreplication
     or worker_role_record.rolbypassrls then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_WORKER_DATABASE_ROLE_ATTRIBUTE_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_WORKER_DATABASE_ROLE_ATTRIBUTES=PASS';

  select count(*)::integer
    into outbound_membership_count
  from pg_catalog.pg_auth_members membership
  where membership.member = worker_role_oid;

  if outbound_membership_count <> 0 then
    raise exception using
      errcode = 'P0001',
      message =
        'TRANSCRIPTION_WORKER_DATABASE_ROLE_OUTBOUND_MEMBERSHIP_CHECK_FAILED';
  end if;
  raise notice
    'TRANSCRIPTION_WORKER_DATABASE_ROLE_OUTBOUND_MEMBERSHIPS=PASS';

  select count(*)::integer
    into inbound_membership_count
  from pg_catalog.pg_auth_members membership
  where membership.roleid = worker_role_oid;

  if inbound_membership_count > 1 then
    raise exception using
      errcode = 'P0001',
      message =
        'TRANSCRIPTION_WORKER_DATABASE_ROLE_CREATOR_ADMIN_CHECK_FAILED';
  end if;

  select count(*)::integer
    into invalid_inbound_membership_count
  from pg_catalog.pg_auth_members membership
  join pg_catalog.pg_roles member_role
    on member_role.oid = membership.member
  join pg_catalog.pg_roles grantor_role
    on grantor_role.oid = membership.grantor
  where membership.roleid = worker_role_oid
    and (
      member_role.rolname <> 'postgres'
      or grantor_role.rolname <> 'supabase_admin'
      or not membership.admin_option
      or membership.inherit_option
      or membership.set_option
    );

  if invalid_inbound_membership_count <> 0 then
    raise exception using
      errcode = 'P0001',
      message =
        'TRANSCRIPTION_WORKER_DATABASE_ROLE_CREATOR_ADMIN_CHECK_FAILED';
  end if;
  raise notice
    'TRANSCRIPTION_WORKER_DATABASE_ROLE_CREATOR_ADMIN_MEMBERSHIP=PASS';
  raise notice 'TRANSCRIPTION_WORKER_DATABASE_ROLE_MEMBERSHIPS=PASS';

  if not pg_catalog.has_database_privilege(
       worker_role,
       current_database(),
       'CONNECT'
     )
     or not pg_catalog.has_schema_privilege(
       worker_role,
       'public',
       'USAGE'
     )
     or pg_catalog.has_schema_privilege(
       worker_role,
       'public',
       'CREATE'
     )
     or pg_catalog.has_schema_privilege(
       worker_role,
       'extensions',
       'CREATE'
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_WORKER_DATABASE_ROLE_SCHEMA_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_WORKER_DATABASE_ROLE_SCHEMA_PRIVILEGES=PASS';

  select count(*)::integer
    into direct_table_acl_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace
    on namespace.oid = relation.relnamespace
  cross join lateral pg_catalog.aclexplode(
    coalesce(
      relation.relacl,
      pg_catalog.acldefault(
        case relation.relkind
          when 'S' then 'S'::"char"
          else 'r'::"char"
        end,
        relation.relowner
      )
    )
  ) acl
  where namespace.nspname = 'public'
    and relation.relkind in ('r','p','v','m','f')
    and acl.grantee = worker_role_oid;

  select count(*)::integer
    into direct_sequence_acl_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace
    on namespace.oid = relation.relnamespace
  cross join lateral pg_catalog.aclexplode(
    coalesce(
      relation.relacl,
      pg_catalog.acldefault('S', relation.relowner)
    )
  ) acl
  where namespace.nspname = 'public'
    and relation.relkind = 'S'
    and acl.grantee = worker_role_oid;

  if direct_table_acl_count <> 0 or direct_sequence_acl_count <> 0 then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_WORKER_DATABASE_ROLE_DIRECT_RELATION_ACL_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_WORKER_DATABASE_ROLE_DIRECT_RELATION_ACL=PASS';

  select count(*)::integer
    into direct_function_acl_count
  from pg_catalog.pg_proc procedure
  cross join lateral pg_catalog.aclexplode(
    coalesce(
      procedure.proacl,
      pg_catalog.acldefault('f', procedure.proowner)
    )
  ) acl
  where acl.grantee = worker_role_oid
    and acl.privilege_type = 'EXECUTE';

  if direct_function_acl_count <> 11 then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_WORKER_DATABASE_ROLE_DIRECT_FUNCTION_ACL_CHECK_FAILED';
  end if;

  granted_worker_function_count := 0;
  foreach function_signature in array expected_worker_functions loop
    if to_regprocedure(function_signature) is null
       or not pg_catalog.has_function_privilege(
         worker_role,
         to_regprocedure(function_signature),
         'EXECUTE'
       ) then
      raise exception using
        errcode = 'P0001',
        message = 'TRANSCRIPTION_WORKER_DATABASE_ROLE_FUNCTION_CHECK_FAILED';
    end if;
    granted_worker_function_count := granted_worker_function_count + 1;
  end loop;

  if granted_worker_function_count <> 11 then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_WORKER_DATABASE_ROLE_FUNCTION_COUNT_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_WORKER_DATABASE_ROLE_WORKER_FUNCTIONS=PASS';

  select count(*)::integer
    into operator_function_count
  from unnest(array[
    'public.confirm_transcription_provider_absence(uuid)',
    'public.prune_transcription_job_after_membership_loss(uuid)'
  ]::text[]) signature
  where to_regprocedure(signature) is null
     or pg_catalog.has_function_privilege(
       worker_role,
       to_regprocedure(signature),
       'EXECUTE'
     );

  if operator_function_count <> 0 then
    raise exception using
      errcode = 'P0001',
      message = 'TRANSCRIPTION_WORKER_DATABASE_ROLE_OPERATOR_FUNCTION_CHECK_FAILED';
  end if;
  raise notice 'TRANSCRIPTION_WORKER_DATABASE_ROLE_OPERATOR_FUNCTIONS=PASS';

  raise notice 'PROJECT_RECALL_TRANSCRIPTION_WORKER_DIRECT_DATABASE_ROLE=PASS';
end;
$$;

rollback;
