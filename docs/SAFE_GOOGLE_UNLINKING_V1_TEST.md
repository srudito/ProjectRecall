# Safe Google Unlinking v1 — Verification

## Automated checks

From `frontend`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/identity-unlinking.test.ts \
  __tests__/identity-linking.test.ts \
  __tests__/connected-accounts.test.ts \
  __tests__/localization.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  "./src/services/supabase/auth.ts" \
  "./src/domain/errors.ts" \
  "./src/components/DisconnectGoogleIdentityButton.tsx" \
  "./app/(tabs)/profile.tsx" \
  "./__tests__/identity-unlinking.test.ts"

npx expo-doctor
```

## Successful unlink

Use a test account with two identities, for example:

```text
Email:  sulistyo.rudito@yahoo.com
Google: ike.sulistyo@gmail.com
```

1. Sign in using the email/password identity.
2. Open Profile → Connected Accounts.
3. Confirm both Email and Google are connected.
4. Tap Disconnect Google.
5. Cancel once and confirm nothing changes.
6. Repeat and confirm the destructive action.

Expected:

```text
Google row disappears
Connect Google appears again
Email row remains connected
Current user UUID does not change
Projects and sessions remain available
```

## Last identity protection

Use a Google-only test account.

Expected:

```text
No Disconnect Google button
Only connected identity remains visible
Direct service test returns lastIdentity
```

## Persistence

After a successful unlink:

1. Force-close Project Recall.
2. Open it again.
3. Open Profile.

Expected:

```text
Google remains disconnected
Connect Google is available
Email identity remains connected
```

## Login regression

After unlinking:

```text
Sign out
→ sign in with the remaining email/password identity
→ existing data remains available
```

Normal Google Sign-In using the disconnected Google address may create or open
a separate Supabase account. Do not use it as the primary regression test for
the original email account.

## SQL verification

Before and after unlinking, record the current user UUID:

```sql
select id, email
from auth.users
where lower(email) = lower('sulistyo.rudito@yahoo.com');
```

List identities:

```sql
select
  u.id as user_id,
  u.email as account_email,
  i.provider,
  i.identity_data ->> 'email' as identity_email
from auth.users u
join auth.identities i
  on i.user_id = u.id
where u.id = '<CURRENT_USER_UUID>'
order by i.provider;
```

Expected after unlink:

```text
Same user UUID
Email identity remains
Google identity is absent
```

## Regression

Verify:

- Connect Google still works after unlinking.
- Sign Out works.
- Auth route guard works.
- Wi-Fi-only setting, language, and theme are unchanged.
- No database, Storage, recording, sync, Library, or evidence behavior changes.
