begin;

create or replace function public.guard_account_deletion_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_record record;
  row_workspace_id uuid;
  row_session_id uuid;
  session_workspace_id uuid;
  guarded_user_ids uuid[] := array[]::uuid[];
begin
  -- This trigger is attached to tables with different row structures.
  -- Never dereference OLD.workspace_id or NEW.workspace_id directly.
  if tg_op = 'UPDATE'
     and tg_table_schema = 'public'
     and tg_table_name = 'sessions' then
    if (to_jsonb(old) ->> 'workspace_id')
         is distinct from
       (to_jsonb(new) ->> 'workspace_id') then
      raise exception using
        errcode = 'P0001',
        message = 'SESSION_WORKSPACE_IMMUTABLE';
    end if;
  end if;

  for row_record in
    select old as row_value
    where tg_op in ('UPDATE', 'DELETE')

    union all

    select new as row_value
    where tg_op in ('INSERT', 'UPDATE')
  loop
    row_workspace_id := null;
    row_session_id := null;
    session_workspace_id := null;

    if to_jsonb(row_record.row_value) ? 'workspace_id' then
      row_workspace_id :=
        nullif(
          to_jsonb(row_record.row_value) ->> 'workspace_id',
          ''
        )::uuid;
    end if;

    if to_jsonb(row_record.row_value) ? 'session_id' then
      row_session_id :=
        nullif(
          to_jsonb(row_record.row_value) ->> 'session_id',
          ''
        )::uuid;
    end if;

    if row_session_id is not null then
      select session_record.workspace_id
        into session_workspace_id
      from public.sessions session_record
      where session_record.id = row_session_id;

      if session_workspace_id is null then
        raise exception using
          errcode = 'P0001',
          message = 'SESSION_SCOPE_NOT_FOUND';
      end if;

      if row_workspace_id is not null
         and row_workspace_id <> session_workspace_id then
        raise exception using
          errcode = 'P0001',
          message = 'WORKSPACE_SESSION_SCOPE_MISMATCH';
      end if;

      row_workspace_id :=
        coalesce(row_workspace_id, session_workspace_id);
    end if;

    if row_workspace_id is not null then
      guarded_user_ids :=
        guarded_user_ids ||
        coalesce(
          (
            select array_agg(distinct workspace.owner_user_id)
            from public.workspaces workspace
            where workspace.id = row_workspace_id
          ),
          array[]::uuid[]
        );
    end if;

    if to_jsonb(row_record.row_value) ? 'owner_user_id' then
      guarded_user_ids :=
        guarded_user_ids || array[
          nullif(
            to_jsonb(row_record.row_value) ->> 'owner_user_id',
            ''
          )::uuid
        ];
    end if;

    if to_jsonb(row_record.row_value) ? 'user_id' then
      guarded_user_ids :=
        guarded_user_ids || array[
          nullif(
            to_jsonb(row_record.row_value) ->> 'user_id',
            ''
          )::uuid
        ];
    end if;

    if to_jsonb(row_record.row_value) ? 'created_by' then
      guarded_user_ids :=
        guarded_user_ids || array[
          nullif(
            to_jsonb(row_record.row_value) ->> 'created_by',
            ''
          )::uuid
        ];
    end if;

    if to_jsonb(row_record.row_value) ? 'added_by' then
      guarded_user_ids :=
        guarded_user_ids || array[
          nullif(
            to_jsonb(row_record.row_value) ->> 'added_by',
            ''
          )::uuid
        ];
    end if;
  end loop;

  guarded_user_ids := (
    select coalesce(
      array_agg(distinct guarded_user_id),
      array[]::uuid[]
    )
    from unnest(guarded_user_ids) as guarded_user_id
    where guarded_user_id is not null
  );

  perform public.lock_accounts_for_write(guarded_user_ids);

  if exists (
    select 1
    from unnest(guarded_user_ids) as guarded_user_id
    where public.is_account_deletion_active(guarded_user_id)
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'ACCOUNT_DELETION_IN_PROGRESS';
  end if;

  return coalesce(new, old);
end;
$$;

revoke all
on function public.guard_account_deletion_write()
from public;

revoke all
on function public.guard_account_deletion_write()
from anon;

revoke all
on function public.guard_account_deletion_write()
from authenticated;

commit;
