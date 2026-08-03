# Delete Account Backend Foundation v1 — Verification

> Permanent deletion is destructive. Use only the disposable development user
> that has already passed the cross-workspace and Storage preflight. Never use
> a primary or production account.

## 1. Source validation

From `/app/frontend`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/delete-account-backend.test.ts \
  __tests__/account-deletion-gate-migration.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  "./jest.config.js" \
  "./__tests__/delete-account-backend.test.ts" \
  "./__tests__/account-deletion-gate-migration.test.ts" \
  --max-warnings=0

npx expo-doctor
```

Validate function configuration:

```bash
cd /app
node -e "JSON.parse(require('fs').readFileSync('supabase/functions/delete-account/deno.json','utf8')); console.log('deno.json OK')"
python3 - <<'PY'
from pathlib import Path
import tomllib

tomllib.loads(Path('supabase/config.toml').read_text())
print('supabase/config.toml OK')
PY

git diff --check
```


The frontend ESLint configuration is used only for the platform-neutral core
module and Jest test. The Deno/Postgres entry files are validated by the
Supabase function bundler during deployment. If Deno is installed locally,
run the additional checks before deployment:

```bash
cd /app

deno check supabase/functions/delete-account/index.ts

deno lint \
  supabase/functions/delete-account/core.ts \
  supabase/functions/delete-account/database.ts \
  supabase/functions/delete-account/index.ts
```

Do not skip the deployment/bundling check merely because Deno is unavailable
locally.

Expected:

```text
TypeScript       0 errors
Focused Jest     passed
Full Jest        passed
ESLint           0 errors, 0 warnings
Expo Doctor      all checks passed
Config parsing   passed
```

## 2. Confirm linked development project

```bash
cd /app
npx supabase projects list
npx supabase functions list
```

Confirm the linked project is the Project Recall **development** project.
Do not run `db push`, `migration repair`, or `db reset`.

## 3. Deploy only the function

```bash
cd /app
npx supabase functions deploy delete-account
```

Do **not** add `--no-verify-jwt`.

Verify:

```bash
npx supabase functions list
```

The function must appear as deployed. The function uses Supabase-provided
server environment variables; do not create or expose a frontend secret.

## 4. Safe HTTP checks

### Method rejection

```bash
curl -i \
  "https://YOUR_PROJECT_REF.supabase.co/functions/v1/delete-account"
```

Depending on gateway order, the result is an authentication rejection or a
method rejection. It must not run deletion.

### Missing JWT

```bash
curl -i \
  -X POST \
  -H 'Content-Type: application/json' \
  --data '{"confirmation":"DELETE"}' \
  "https://YOUR_PROJECT_REF.supabase.co/functions/v1/delete-account"
```

Expected: platform `401`; function code must not execute.

## 5. Re-run disposable-account preflight

Immediately before destructive invocation, verify:

```text
target_user                                      1
owned_team_workspaces_with_other_active_members  0
memberships_in_non_owned_workspaces              0
all *_in_non_owned_workspaces                     0
objects_outside_owned_workspaces                  0
```

Also verify all objects below the owned workspace are owned by the disposable
user. Objects with another owner or a null owner intentionally block automatic
deletion.

Record privately (do not paste into chat):

```text
DELETE_TEST_USER_ID
DELETE_TEST_WORKSPACE_ID
Storage object count
```

## 6. Destructive invocation using the disposable password account

Run from `/app/frontend`. This script reads credentials silently, signs in as
the disposable user, and invokes the deployed function. It does not print the
password or access token.

```bash
cd /app/frontend

set -a
. ./.env
set +a

read -r -p 'Disposable delete-test email: ' DELETE_TEST_EMAIL
read -r -s -p 'Disposable delete-test password: ' DELETE_TEST_PASSWORD
printf '\n'
export DELETE_TEST_EMAIL DELETE_TEST_PASSWORD

node <<'NODE'
const { createClient } = require('@supabase/supabase-js');

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const email = process.env.DELETE_TEST_EMAIL;
const password = process.env.DELETE_TEST_PASSWORD;

if (!url || !key || !email || !password) {
  throw new Error('Missing public Supabase config or disposable credentials.');
}

const supabase = createClient(url, key, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

(async () => {
  const signIn = await supabase.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) {
    throw new Error('Disposable test sign-in failed.');
  }

  const response = await supabase.functions.invoke('delete-account', {
    body: { confirmation: 'DELETE' },
  });

  if (response.error) {
    const context = response.error.context;
    let safeBody = null;
    if (context && typeof context.json === 'function') {
      try {
        safeBody = await context.json();
      } catch {
        safeBody = null;
      }
    }
    console.error('Delete Account failed:', safeBody ?? response.error.message);
    process.exitCode = 1;
    return;
  }

  console.log('Delete Account response:', response.data);
})();
NODE

unset DELETE_TEST_EMAIL DELETE_TEST_PASSWORD
```

Expected safe response shape:

```text
status: deleted | already_deleted
deletedWorkspaceCount: number
deletedStorageObjectCount: number
requestId: UUID
```

No token, email, user object, or raw provider/database error may appear.

## 7. Verify permanent deletion

Using privately recorded IDs:

```sql
select id from auth.users where id = 'DELETE_TEST_USER_ID';
select id from public.workspaces where id = 'DELETE_TEST_WORKSPACE_ID';
select id, name
from storage.objects
where bucket_id = 'session-assets'
  and name like 'DELETE_TEST_WORKSPACE_ID/%';
```

Expected: zero rows for all three.

Verify dependent rows are absent for the deleted workspace in projects,
sessions, recordings, media, notes, bookmarks, timeline, processing jobs, and
upload queue records.

Attempting to sign in again with the deleted credentials must fail.

## 8. Retry behavior

If invocation returns a retryable server/storage error, do not manually delete
rows. Invoke the function again with a fresh, recently authenticated session.
The function is designed to resume after owned workspace deletion by cleaning
user-owned orphan Storage objects.

If the function returns `ACCOUNT_DELETION_BLOCKED`, inspect the returned generic
blocker codes and re-run the read-only preflight. Do not bypass blockers using
SQL.

## 9. Security regression

- Invoke with no JWT: rejected.
- Invoke with a non-user API key in `Authorization`: rejected by gateway.
- Use stale login older than 15 minutes: reauthentication required.
- Use confirmation other than exact `DELETE`: rejected.
- User with shared/team blockers: no Storage or workspace deletion occurs.
- User-owned object in existing non-owned workspace: blocked.
- User-owned object in a bucket other than `session-assets`: blocked.
- Other-user or null-owner object inside owned workspace: blocked.
- Function response/logs contain no bearer token, email, user ID, or raw error.


## Phase 5A.1 concurrency/retry verification

Run the additional migration, gate, distributed lease, and retry test plan in `DELETE_ACCOUNT_CONCURRENCY_HARDENING_V1_TEST.md` before exposing a Delete Account UI.
