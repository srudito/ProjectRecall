begin;

revoke all
on function public.account_deletion_lock_key(uuid)
from public;

revoke all
on function public.account_deletion_lock_key(uuid)
from anon;

revoke all
on function public.account_deletion_lock_key(uuid)
from authenticated;

revoke all
on function public.is_account_deletion_active(uuid)
from public;

revoke all
on function public.is_account_deletion_active(uuid)
from anon;

revoke all
on function public.is_account_deletion_active(uuid)
from authenticated;

revoke all
on function public.lock_accounts_for_write(uuid[])
from public;

revoke all
on function public.lock_accounts_for_write(uuid[])
from anon;

revoke all
on function public.lock_accounts_for_write(uuid[])
from authenticated;

revoke all
on function public.can_write_workspace(uuid)
from public;

revoke all
on function public.can_write_workspace(uuid)
from anon;

grant execute
on function public.can_write_workspace(uuid)
to authenticated;

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
  if tg_op = 'UPDATE'
     and tg_table_schema = 'public'
     and tg_table_name = 'sessions'
     and old.workspace_id is distinct from new.workspace_id then
    raise exception using
      errcode = 'P0001',
      message = 'SESSION_WORKSPACE_IMMUTABLE';
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
          to_jsonb(row_record.row_value)->>'workspace_id',
          ''
        )::uuid;
    end if;

    if to_jsonb(row_record.row_value) ? 'session_id' then
      row_session_id :=
        nullif(
          to_jsonb(row_record.row_value)->>'session_id',
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
        guarded_user_ids || (
          select array_agg(distinct workspace.owner_user_id)
          from public.workspaces workspace
          where workspace.id = row_workspace_id
        );
    end if;

    if to_jsonb(row_record.row_value) ? 'owner_user_id' then
      guarded_user_ids :=
        guarded_user_ids || array[
          nullif(
            to_jsonb(row_record.row_value)->>'owner_user_id',
            ''
          )::uuid
        ];
    end if;

    if to_jsonb(row_record.row_value) ? 'user_id' then
      guarded_user_ids :=
        guarded_user_ids || array[
          nullif(
            to_jsonb(row_record.row_value)->>'user_id',
            ''
          )::uuid
        ];
    end if;

    if to_jsonb(row_record.row_value) ? 'created_by' then
      guarded_user_ids :=
        guarded_user_ids || array[
          nullif(
            to_jsonb(row_record.row_value)->>'created_by',
            ''
          )::uuid
        ];
    end if;

    if to_jsonb(row_record.row_value) ? 'added_by' then
      guarded_user_ids :=
        guarded_user_ids || array[
          nullif(
            to_jsonb(row_record.row_value)->>'added_by',
            ''
          )::uuid
        ];
    end if;
  end loop;

  guarded_user_ids := (
    select coalesce(
      array_agg(distinct user_id),
      array[]::uuid[]
    )
    from unnest(guarded_user_ids) as user_id
    where user_id is not null
  );

  perform public.lock_accounts_for_write(guarded_user_ids);

  if exists (
    select 1
    from unnest(guarded_user_ids) as user_id
    where public.is_account_deletion_active(user_id)
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
