# Password Recovery Hardening v1 — Implementation

## Scope

This milestone hardens the existing email password-recovery flow without adding
password changes from Profile, password setup for OAuth-only accounts, account
deletion, database migrations, Edge Functions, or another identity provider.

## Problem addressed

The previous shared callback handler could treat any existing authenticated
session as sufficient proof that a password-recovery callback was valid. The
public Reset Password screen also called the generic authenticated
`updateUser({ password })` operation directly.

That created two undesirable states:

- an unrelated existing session could bypass the recovery-code exchange;
- direct navigation to the public Reset Password route could reach password
  update logic without a recovery-specific authorization check.

## Hardened flow

```text
Forgot Password
→ resetPasswordForEmail(..., auth/reset)
→ projectrecall://auth/reset (or web /auth/reset)
→ dedicated recovery callback service owns PKCE exchange
→ short-lived in-memory recovery grant
→ Reset Password screen verifies grant + current user
→ updateUser({ password })
→ recovery grant consumed
→ Home
```

## Security properties

- `/auth/reset` disables automatic web PKCE detection so the dedicated recovery
  service is the only code-exchange owner.
- An existing unrelated session is never reused as proof of recovery.
- The callback public result is only `{ status: "ready" }`; sessions, users,
  tokens, callback URLs, and raw provider data do not cross into UI code.
- The in-memory recovery grant contains only the recovered user ID and a
  15-minute expiry timestamp.
- The reset screen hides password inputs until the grant and current Supabase
  user are verified.
- The grant is bound to the recovered user ID, expires automatically, is
  consumed after one successful password update, and is cleared on sign-out.
- Concurrent observers of the same callback reuse one in-flight exchange.
- Invalid, expired, wrong-purpose, or already-consumed callback data maps to
  stable localized application errors.

## Files

- `frontend/src/services/supabase/auth.ts`
- `frontend/src/services/supabase/client.ts`
- `frontend/src/components/PasswordRecoveryCallbackHandler.tsx`
- `frontend/app/auth/reset.tsx`
- `frontend/app/(auth)/reset-password.tsx`
- `frontend/src/domain/errors.ts`
- English and Indonesian auth/error localization files
- `frontend/__tests__/password-recovery.test.ts`
- `frontend/__tests__/supabase-client-auth-detection.test.ts`

## Supabase requirements

The following redirect URLs remain required:

- native: `projectrecall://auth/reset`
- web: exact deployed origin plus `/auth/reset`

No migration, service-role key, Client Secret, or frontend secret is added.

## Callback capture hardening

Expo Router and `expo-linking` can expose the same native deep link on slightly
different schedules. The callback route now rebuilds an actionable callback
from route-local search parameters, while the handler also observes the live
linking URL, the initial URL, and URL events. A bare `/auth/reset` route remains
in a bounded loading state for three seconds rather than being rejected
immediately. Equivalent callbacks are deduplicated by their one-time PKCE code
instead of raw query ordering.

Recovery failures are now separated into safe, localized categories for an
expired/used link, a PKCE device/verifier mismatch, and a callback that never
returned verification parameters. No code, token, callback URL, or raw provider
message is rendered or logged.

## Follow-up hardening v1.1

- Recovery callback capture is now purpose-bound to the exact native
  `projectrecall://auth/reset` route or an exact web `/auth/reset` path. Normal
  sign-in and identity-link callback URLs are ignored even when they contain a
  PKCE-looking code.
- The auth service repeats that route check before exchanging any code, so a
  caller cannot bypass the UI callback filter.
- Password-update success is verified from the `user` returned directly by
  `updateUser({ password })`. A later network-only `getUser()` failure can no
  longer turn an already-completed server update into a false failure message.
- Focused tests cover wrong-route callbacks, returned-user mismatch, and the
  absence of a post-update verification request.
