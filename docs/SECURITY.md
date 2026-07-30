# Security

## Authentication

- Supabase email/password with mandatory email verification.
- Sessions persist via `expo-secure-store` (Keychain on iOS,
  EncryptedSharedPreferences on Android).
- `autoRefreshToken` keeps sessions alive; the FastAPI backend re-verifies
  every request that hits protected routes.

## Row Level Security

RLS is enabled on every user-owned table in `public`. Access is granted only
to authenticated users whose `auth.uid()` maps to an active membership in the
row's workspace. See `supabase/migrations/0002_rls_policies.sql`.

### RLS test matrix

Perform each of these with two accounts (A and B) after applying migrations:

| # | Action                                                          | Expected |
| - | --------------------------------------------------------------- | -------- |
| 1 | User A reads own profile                                        | ✅       |
| 2 | User A reads own workspace                                      | ✅       |
| 3 | User A creates a project in own workspace                       | ✅       |
| 4 | User A creates a session in own workspace                       | ✅       |
| 5 | User B reads User A's workspace                                 | ❌       |
| 6 | User B reads User A's projects                                  | ❌       |
| 7 | User B reads User A's sessions                                  | ❌       |
| 8 | User B reads User A's recordings                                | ❌       |
| 9 | User B reads User A's media assets                              | ❌       |
| 10 | User B modifies User A's notes / bookmarks                     | ❌       |
| 11 | User B deletes User A's data                                   | ❌       |

## Storage privacy

- `session-assets` is a private bucket. No public URLs.
- Storage RLS policies validate workspace membership from the first path
  segment.
- Client downloads via `supabase.storage.from('session-assets').download(path)`
  with the authenticated JWT.

## Token handling

- Only anon key + Supabase URL live in the mobile bundle (`EXPO_PUBLIC_*`).
- The service-role key is confined to `backend/.env` and never returned in
  any API response.
- Logs never include tokens, signed URLs, note content, or file content in
  routine operation.

## File validation

Every accepted upload passes `services/files/validation.ts`:

- MIME must be in the allow-list (image/JPEG-PNG-WEBP; video/MP4-MOV; PDF/DOCX/TXT/MD; audio/*).
- Executable extensions are rejected outright.
- Size limits are per-type and centralised (`src/config/limits.ts`).
- File names are sanitised (no path separators, no shell-active chars,
  max 200 chars, fallback to `file`).

## Logging restrictions

- The backend structured-logger only records `path`, `method`, `status`,
  `duration_ms`.
- The mobile app suppresses tokens via console safety (LogBox suppressed in
  preview, sensitive data never `console.log`ged).
- No note, document, image, video, or audio content is ever logged.

## Deletion security

- Session deletion uses the signed-in user's normal JWT; the mobile bundle does
  not use a service-role key.
- Private Storage objects are removed before the session database row so the
  existing workspace-membership policy can still authorize cleanup.
- The deletion worker is scoped by `user_id` and refuses a claimed job owned by
  another signed-in user.
- Upload workers re-check the parent session after binary upload and remove a
  just-uploaded object if deletion started during the upload.
- User-isolation testing must verify that User B cannot delete User A's session
  row, list its Storage prefix, or remove its objects.
