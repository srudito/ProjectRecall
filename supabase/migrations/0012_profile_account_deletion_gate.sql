begin;

-- Profiles use their primary-key `id` as the auth user id. The generic
-- workspace/session guard intentionally handles heterogeneous table shapes,
-- so add an explicit profile guard to preserve a complete account-write
-- freeze while a durable deletion request is active.
create or replace function public.guard_profile_account_deletion_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  guarded_user_id uuid;
begin
  guarded_user_id := coalesce(
    nullif(to_jsonb(new) ->> 'id', '')::uuid,
    nullif(to_jsonb(old) ->> 'id', '')::uuid
  );

  if guarded_user_id is null then
    return coalesce(new, old);
  end if;

  perform public.lock_accounts_for_write(array[guarded_user_id]);

  if public.is_account_deletion_active(guarded_user_id) then
    raise exception using
      errcode = 'P0001',
      message = 'ACCOUNT_DELETION_IN_PROGRESS';
  end if;

  return coalesce(new, old);
end;
$$;

revoke all
on function public.guard_profile_account_deletion_write()
from public;

revoke all
on function public.guard_profile_account_deletion_write()
from anon;

revoke all
on function public.guard_profile_account_deletion_write()
from authenticated;

drop trigger if exists guard_profile_account_deletion_write
on public.profiles;

create trigger guard_profile_account_deletion_write
before insert or update on public.profiles
for each row
execute function public.guard_profile_account_deletion_write();

commit;
