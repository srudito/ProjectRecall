# Password Recovery Hardening v1 — Test Checklist

## Automated checks

From `/app/frontend`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/password-recovery.test.ts \
  __tests__/supabase-client-auth-detection.test.ts \
  __tests__/oauth-utils.test.ts \
  __tests__/root-stack.test.tsx \
  __tests__/localization.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  "./src/services/supabase/auth.ts" \
  "./src/services/supabase/client.ts" \
  "./src/components/PasswordRecoveryCallbackHandler.tsx" \
  "./app/auth/reset.tsx" \
  "./app/(auth)/reset-password.tsx" \
  "./src/domain/errors.ts" \
  "./__tests__/password-recovery.test.ts" \
  "./__tests__/supabase-client-auth-detection.test.ts"

npx expo-doctor
```

## Supabase redirect configuration

Keep these exact native redirect URLs allowed:

```text
projectrecall://auth/callback
projectrecall://auth/link-callback
projectrecall://auth/reset
```

For web testing, add the exact deployed or local origin with:

```text
/auth/reset
```

## Manual Android recovery test

1. Sign out of Project Recall.
2. Open Sign In → Forgot password.
3. Enter a real email/password account.
4. Confirm the UI always shows the enumeration-safe sent message.
5. Open the reset email on the Android development build.
6. Confirm the dedicated recovery loading screen appears.
7. Confirm the Reset Password fields appear only after callback verification.
8. Set a new password.
9. Confirm Home opens and existing projects/sessions remain available.
10. Sign out and sign in using the new password.
11. Confirm the previous password no longer signs in.

## Existing-session test

1. Sign in as account A.
2. Request a reset link for account B.
3. Open account B's reset link on the same device.
4. Confirm the callback processes the link instead of silently reusing account
   A's session.
5. Confirm the password update applies only to account B.
6. Confirm account B's user UUID and data remain unchanged.

## Direct-route protection

Navigate directly to:

```text
/(auth)/reset-password
```

without first opening a valid recovery link.

Expected:

- password fields are not shown;
- a localized recovery-required message appears;
- the only action requests a new reset link;
- no password update request is sent.

## Invalid and replayed link

1. Open an expired or malformed reset link.
2. Confirm a safe localized error appears with no raw callback data.
3. Complete one valid recovery.
4. Attempt to reuse the same link.
5. Confirm it cannot authorize another password change.

## Regression

Confirm these remain working:

- normal email/password sign-in;
- normal Google sign-in callback;
- Google identity linking and unlinking;
- sign-out;
- route guard;
- Connected Accounts;
- existing project/session access.

## Callback timing regression

- Open a newly requested recovery email while the app is cold and while it is
  already running.
- Confirm a bare `/auth/reset` route does not fail immediately; the full callback
  may arrive through Expo Router params or a later linking event.
- Confirm the password form appears once the PKCE code is exchanged.
- If the UI reports that the link was already used/expired, inspect Supabase Auth
  logs for `otp_expired`; this indicates email prefetch/link scanning rather than
  a missing callback parameter.
- If the UI reports a same-device mismatch, request and open the newest link in
  the same installed app without clearing app data.
