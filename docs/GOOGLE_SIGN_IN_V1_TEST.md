# Google Sign-In + OAuth Deep Link v1 Test Checklist

## Automated validation

```text
TypeScript: PASS / FAIL
Jest: PASS / FAIL
Targeted ESLint: PASS / FAIL
Expo Doctor: PASS / FAIL
Localization parity: PASS / FAIL
```

## Provider configuration

```text
Google provider enabled in Supabase:
Google Web Client ID configured:
Google Client Secret configured in Supabase only:
projectrecall://auth/callback allow-listed:
projectrecall://auth/reset allow-listed:
Web callback allow-listed:
Migration 0005 applied:
```

## New Google user

1. Sign out.
2. Tap Continue with Google.
3. Select a Google account that has never used Project Recall.
4. Complete consent.

Expected:

```text
System browser closes and returns to Project Recall
Home opens
Session persists after application restart
One auth.users row exists
One profiles row exists
One personal workspace exists
One owner membership exists
Display name is derived from Google profile metadata
```

## Existing email/password user with same verified email

1. Confirm the existing email/password user has a verified email.
2. Sign out.
3. Continue with Google using the same email.

Expected:

```text
No duplicate application data owner
Existing projects and sessions remain visible
No second personal workspace is created for a separate auth user
Auth identity list contains the expected identities
```

If Supabase creates a second auth user, stop testing and review identity-linking configuration before production.

## Cancellation

```text
Tap Continue with Google
Close/cancel the browser flow
Return to the auth screen
No red screen
No false signed-in state
Button becomes available again
```

## Provider/configuration failure

Temporarily test in a non-production environment with the provider disabled or redirect removed.

Expected:

```text
A safe localized error is shown
No token or callback URL is printed
No partial session is stored
```

## Web preview

```text
Continue with Google opens a popup/auth window
Successful callback closes the auth window
Home opens
Refresh preserves the session
Sign out returns to Welcome
```

## Password reset deep link regression

```text
Request password reset
Open the email link on the device
projectrecall://auth/reset opens Project Recall
Reset Password screen opens
Password update succeeds
New password can sign in
```

## Email verification regression

```text
Create an email/password account with confirmation enabled
Open confirmation link
projectrecall://auth/callback opens Project Recall
Authenticated Home opens or sign-in state updates correctly
```

## Protected navigation

```text
Sign out
Attempt to open a tab route directly
User is redirected to Welcome
No protected project/session data is displayed
```

## Security checks

```text
No Google Client Secret in tracked files
No service-role key in frontend
No callback URL with tokens logged
No OAuth token persisted outside Supabase Auth storage
RLS still isolates User A and User B data
```
