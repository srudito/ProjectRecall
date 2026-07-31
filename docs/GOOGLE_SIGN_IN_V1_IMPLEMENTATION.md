# Google Sign-In + OAuth Deep Link v1

## Scope

This change adds Google OAuth sign-in through Supabase Auth while preserving the existing email/password flows.

Implemented:

- Continue with Google on Welcome, Sign In, and Sign Up.
- PKCE-enabled Supabase client configuration.
- Native callback: `projectrecall://auth/callback`.
- Native password-recovery callback: `projectrecall://auth/reset`.
- Dynamic web callback URLs generated from the current web origin.
- Callback parsing for both PKCE `code` responses and legacy fragment tokens.
- Duplicate callback protection when Expo Router and `WebBrowser` observe the same URL.
- Protected tabs that redirect unauthenticated users to Welcome.
- Automatic immediate navigation when email confirmation is disabled and sign-up returns a session.
- OAuth-aware profile/workspace display-name trigger migration.

Not included:

- Manual account linking/unlinking UI.
- Connected Accounts screen.
- Apple, Microsoft, or Facebook login.
- Account deletion.
- MFA or passkeys.
- Enterprise SAML SSO.

## Required Supabase configuration

1. Enable Google under Authentication > Providers.
2. Enter the Google OAuth Web Client ID and Client Secret.
3. Add these Redirect URLs under Authentication > URL Configuration:

   - `projectrecall://auth/callback`
   - `projectrecall://auth/reset`
   - `projectrecall://**` for development only
   - the active web preview callback, for example `https://YOUR_PREVIEW_HOST/auth/callback`
   - the active web reset callback, for example `https://YOUR_PREVIEW_HOST/auth/reset`

4. Apply `supabase/migrations/0005_auth_provider_metadata.sql` once.

The Google Client Secret must remain in Supabase. It must never be stored in the mobile app, `EXPO_PUBLIC_*`, GitHub, or application logs.

## Google Cloud configuration

Create an OAuth 2.0 Client ID of type Web application and add the Supabase callback URI shown in the Google provider settings. Use only the basic scopes needed for sign-in: `openid`, `email`, and `profile`.

## Account identity behavior

Supabase Auth remains the source of truth for identities. A single user may have email/password and Google identities. Project Recall continues to use:

```text
profiles.id = auth.users.id
```

No provider-specific user table is introduced.

## Database migration

`0005_auth_provider_metadata.sql` updates the existing `handle_new_auth_user()` function so social-auth users can receive a readable display name from, in order:

1. `display_name`
2. `full_name`
3. `name`
4. email local part
5. `Project Recall user`

The migration does not alter tables and is safe to apply after migrations 0001-0004.
