# Safe Google Unlinking v1 — Implementation

## Scope

This milestone adds a safe, user-initiated way to disconnect a linked Google
identity from the currently authenticated Project Recall account.

It does not add account deletion, password setup, another OAuth provider,
database migrations, SQLite changes, or Edge Functions.

## User flow

```text
Profile
→ Connected Accounts
→ Google identity
→ Disconnect Google
→ confirmation
→ Supabase Auth unlinkIdentity()
→ Connected Accounts refresh
```

After a successful unlink:

- the current `auth.users.id` remains unchanged;
- Project Recall data remains attached to the current account;
- the Google row disappears from Connected Accounts;
- the Connect Google action becomes available again;
- another connected identity remains available for authentication.

## Safety rules

The disconnect action is available only when:

- the selected identity is Google;
- the Google identity belongs to the current Supabase user;
- at least one other identity remains connected.

The auth service fetches the raw identity internally and passes it directly to
`supabase.auth.unlinkIdentity()`. The UI receives only a safe status result and
never receives the raw Supabase identity, user, session, provider token, access
token, refresh token, or identity data.

A module-level single-flight promise and a component-level ref prevent rapid
confirmation taps from sending duplicate unlink requests.

## Stable error handling

Supabase Auth codes are mapped to application codes:

- `manual_linking_disabled` → `AUTH_IDENTITY_UNLINK_NOT_CONFIGURED`
- `single_identity_not_deletable` → safe `lastIdentity` result
- `identity_not_found` → safe `notConnected` result
- `email_conflict_identity_not_deletable` →
  `AUTH_IDENTITY_UNLINK_EMAIL_CONFLICT`
- all other failures → `AUTH_IDENTITY_UNLINK_FAILED`

Raw Supabase messages are not rendered by Profile.

## Supabase requirements

Manual Identity Linking must remain enabled in Supabase Authentication
configuration. No migration is required.

## Files

- `frontend/src/services/supabase/auth.ts`
- `frontend/src/components/DisconnectGoogleIdentityButton.tsx`
- `frontend/app/(tabs)/profile.tsx`
- `frontend/src/domain/errors.ts`
- English and Indonesian localization files
- `frontend/__tests__/identity-unlinking.test.ts`
