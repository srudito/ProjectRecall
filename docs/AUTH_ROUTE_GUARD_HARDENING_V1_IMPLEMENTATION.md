# Authentication Route Guard Hardening v1

## Scope

This patch closes the root-route authorization gap without changing local
SQLite data, synchronization queues, Supabase policies, Storage paths, or the
existing visual layout.

The root navigator now uses Expo Router protected screens for every route that
can expose authenticated or locally retained user data.

Protected root routes:

```text
(onboarding)
(tabs)
record/setup
record/active
record/review
session/[id]
project/[id]
```

Public root routes:

```text
index
(auth)
auth/callback
auth/reset
```

The OAuth and password-recovery callbacks remain public because they are the
routes that establish or recover an authenticated session.

## Session hydration

The navigator does not decide protected-route access until the persisted
Supabase session has finished loading from the configured auth storage.

While hydration is pending, the app displays a neutral themed activity
indicator. Protected screens are not mounted during this state, so a signed-out
deep link cannot briefly render a retained local session or project.

After hydration:

```text
persisted session -> protected routes enabled
no session         -> protected routes unavailable
```

On sign-out, Expo Router removes protected screens from navigation history and
falls back through the public root route.

## Local-first behavior

The recording and synchronization coordinators remain mounted at the root as
before. This patch does not:

- delete or rewrite SQLite rows;
- alter stable UUIDs;
- change queue idempotency or retry behavior;
- require network access to accept a restored persisted session;
- modify private Storage behavior;
- change any Supabase RLS policy.

## Database and backend impact

No Supabase migration is added.

No Edge Function is added or changed.

Migrations `0001` through `0006` must not be rerun for this patch.

## Automated coverage

`root-stack.test.tsx` verifies:

- auth hydration is resolved before route access is decided;
- all documented authenticated root routes are inside `Stack.Protected`;
- OAuth and password-recovery callbacks remain public;
- authenticated sessions enable protected routes;
- the Record Setup modal presentation is preserved;
- every declared root route appears exactly once.

## Not included

This patch does not begin Connected Accounts, identity linking/unlinking,
reauthentication, Delete Account, MFA, passkeys, or Milestone 2 transcription.
