begin;

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
