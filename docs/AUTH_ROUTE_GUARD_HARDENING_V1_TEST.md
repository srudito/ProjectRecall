# Authentication Route Guard Hardening v1 Test

## Automated validation

From `frontend`:

```bash
yarn install --frozen-lockfile
yarn tsc --noEmit
yarn jest --runInBand
yarn eslint \
  app/_layout.tsx \
  src/navigation/RootStack.tsx \
  src/services/auth/route-access.ts \
  __tests__/root-stack.test.tsx
yarn expo-doctor
```

All commands must pass before the patch is merged.

## Expo Go smoke test

1. Start the app with Expo Go:

```bash
yarn expo start --go --clear
```

2. Verify Welcome, email sign-in, Home, Library, Profile, and normal in-app
   navigation still render.
3. Sign out from Profile and verify the tabs cannot be reopened through in-app
   navigation.

Use the Android development build for custom-scheme deep-link, Google OAuth,
and password-recovery verification.

## Signed-out deep links

1. Sign out normally.
2. Keep existing local sessions and projects on the device.
3. From a connected development machine, open each protected route:

```bash
adb shell am start -W \
  -a android.intent.action.VIEW \
  -d "projectrecall://record/setup" \
  com.srudito.projectrecall

adb shell am start -W \
  -a android.intent.action.VIEW \
  -d "projectrecall://session/<SESSION_UUID>" \
  com.srudito.projectrecall

adb shell am start -W \
  -a android.intent.action.VIEW \
  -d "projectrecall://project/<PROJECT_UUID>" \
  com.srudito.projectrecall
```

Expected:

```text
The app routes to Welcome.
No session title, project title, timeline, audio, or evidence flashes first.
Back navigation cannot reopen the protected screen.
```

Repeat for `record/active` and `record/review` using safe test data. Do not
start a real recording merely to test a malformed deep link.

## Persisted authenticated session

1. Sign in and open a known synchronized session.
2. Force-stop the app.
3. Disable Wi-Fi and mobile data.
4. Open the session deep link again.
5. Reopen Home, Library, Session Detail, and Project Detail.

Expected:

```text
The persisted Supabase session is restored from device storage.
The authenticated deep link is not redirected prematurely.
Locally available data remains usable offline.
No cloud request is required merely to pass the route guard.
```

## Sign-out history cleanup

1. Sign in.
2. Open Session Detail or Project Detail.
3. Return to Profile and sign out.
4. Press Android Back repeatedly.

Expected:

```text
Welcome remains visible.
Protected history entries do not reopen.
Local SQLite data is retained for the normal non-destructive sign-out flow.
```

## OAuth callback regression

1. Start Google sign-in from Welcome.
2. Complete provider authentication.
3. Verify the app returns through `auth/callback`.
4. Verify Home opens and protected routes are available.
5. Cancel a second Google sign-in and verify the existing safe error behavior.

Expected:

```text
The callback remains reachable before a session exists.
Only the callback establishes the new authenticated session.
No callback code or token is logged.
```

## Password recovery regression

1. Request a password-reset email.
2. Open the recovery link on the Android development build.
3. Verify `auth/reset` opens.
4. Set a new password.
5. Verify the app reaches Home.

Expected:

```text
The recovery callback and Reset Password screen remain public.
Protected application routes become available only after session recovery.
```

## Visual and navigation regression

Verify:

- Record Setup still opens as a modal;
- Home, Library, Record, and Profile tabs are unchanged;
- existing Card and Compact Library layouts are unchanged;
- recording, timeline, audio, evidence, starring, and deletion behavior is
  unchanged;
- the auth-loading state uses the current theme and does not display user data.

## Supabase verification

No migration or Edge Function deployment is required.

Confirm the existing environment still has migrations `0001` through `0006`
applied exactly once. Re-run the existing RLS and private Storage checks; this
patch must not change their results.
