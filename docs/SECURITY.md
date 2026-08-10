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
| 12 | Workspace member reads scoped transcription status/transcript rows | ✅       |
| 13 | Authenticated mobile client directly inserts transcript results     | ❌       |
| 14 | User B reads User A's processing jobs or transcripts                | ❌       |

## Storage privacy

- `session-assets` is a private bucket. No public URLs.
- Storage RLS policies validate workspace membership from the first path
  segment.
- Client downloads via `supabase.storage.from('session-assets').download(path)`
  with the authenticated JWT.

## Token handling

- Only public runtime configuration may be embedded through `EXPO_PUBLIC_*`.
  The Supabase frontend credential must be a publishable key or legacy
  `anon`-role key.
- Supabase secret/service-role keys and all privileged credentials are
  forbidden in every mobile build profile, remain confined to trusted backend
  or Edge Function environments, and are never returned in an API response.
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

## Release privacy controls

- Android application backup is disabled so private SQLite, recordings,
  evidence, Auth/deletion state, and caches are not restored by cloud backup.
- Broad Android media-library access and legacy external-storage write access
  are explicitly blocked. The Android system picker supplies only user-selected
  image/video items; legacy read access may remain only with
  `maxSdkVersion=32` in the merged manifest.
- `SYSTEM_ALERT_WINDOW` is blocked only in resolved production app config.
  Non-production configs remain unchanged while the production AAB is required
  not to request overlay capability.
- Support, privacy-policy, and terms destinations are public release
  configuration; production builds fail when they are missing or are not
  credential-free HTTPS destinations on valid public multi-label DNS hosts.
- Public Expo variables are not secrets, but only a Supabase publishable key or
  legacy `anon` JWT may be placed in the frontend key variable. Every EAS build
  profile rejects Supabase secret/service-role, privileged, malformed, and
  placeholder frontend keys. OAuth client secrets, JWT secrets, database
  passwords, and signing credentials remain server-side only.

## Batch transcription foundation security

- `transcription_enabled` remains false throughout Milestone 2A.
- Mobile request preparation accepts only synchronized recordings whose private
  Storage path matches the canonical workspace/session/recording scope.
- Stable idempotency keys are derived from non-secret identifiers and normalized
  language settings; local file URIs and provider credentials are excluded.
- Authenticated clients have read-only access to workspace-visible processing
  jobs, provider runs, transcript versions, and transcript segments. Migration
  `0013` explicitly removes anonymous access, grants authenticated SELECT only,
  and grants server-side DML to the PostgreSQL `service_role`; the role name in
  SQL is not a credential, and its secret key remains backend-only. A reviewed
  server worker will write results in Phase 2B.
- Provider API keys, webhook secrets, privileged Supabase keys, and signed input
  URLs must remain server-side and must never be written to job payloads,
  provider metadata, safe error fields, mobile logs, or `EXPO_PUBLIC_*`.
- Durable jobs use bounded retries and active leases. Each provider attempt is
  stored separately so retry history is not overwritten.
- Recording, job, run, version, and segment rows are bound through composite
  scope constraints to prevent cross-workspace identifier substitution. The
  legacy single-column run/version FK is removed so one deterministic composite
  FK clears only the nullable run reference when a run/job is removed, while
  session/workspace cascades still delete versions and segments.
- Delete Account preflight and final-reference checks include transcription
  creator relationships. Rows created by the deleting user in non-owned
  workspaces, or by other users in an owned workspace, block before destructive
  Storage/workspace/Auth cleanup begins.
- New local transcription tables participate in session deletion and scoped
  Delete Account cleanup before parent session/profile rows are removed. Local
  request uniqueness is user-scoped on shared devices; cloud job idempotency
  remains workspace-scoped.
- Transcription request preparation rejects prefix-only and non-canonical
  private Storage keys, including empty, dot, dot-dot, backslash, NUL, and
  edge-whitespace object-path segments.

## AssemblyAI adapter security

- Milestone 2B.1A adds only a pure server-side adapter. It does not read an
  AssemblyAI secret, deploy a worker, create a Cron schedule, or call the live
  provider.
- The default provider endpoint is the AssemblyAI EU asynchronous transcription
  endpoint. An arbitrary base URL cannot be supplied to the adapter.
- Provider input URLs must use HTTPS and cannot contain URL credentials,
  fragments, edge whitespace, raw controls, or malformed Unicode. Provider fetches
  reject redirects so EU routing cannot silently cross an origin or region.
- A future worker may generate a short-lived Supabase private Storage signed URL
  only after acquiring a durable job lease. The adapter sends the URL to the
  provider but never returns it in submission, polling, transcript, metadata,
  error, or cleanup results.
- Provider Authorization values and raw provider error bodies are never logged
  or included in safe errors. Fixed error codes/messages are stored instead.
- Ambiguous submission transport/server outcomes are not marked automatically
  retryable, because a lost response can occur after AssemblyAI accepted and
  billed the transcript. A future worker must reconcile or require manual review
  rather than creating a duplicate provider job. If the response contains a valid
  provider job ID, the safe failure preserves it for polling or cleanup.
- AssemblyAI job results are validated before ingestion. Malformed IDs, states,
  unsafe timestamps, malformed Unicode, inconsistent language metadata, unverified
  model provenance, confidence values, or word payloads fail closed rather than
  creating partial canonical transcripts.
- Explicit language hints and manual selections are deliberately limited to
  reviewed English variants, Bahasa Indonesia, and exactly English/Indonesian
  code switching. `AUTO_DETECT` without hints intentionally allows the
  provider's supported-language detection and records the provider-reported
  language; unsupported explicit configurations fail before any provider
  request.
- Provider retry hints are treated as untrusted scheduling metadata. Only RFC
  decimal seconds or IMF-fixdate values yielding at most 24 hours are accepted;
  malformed or larger values are ignored in favor of bounded local backoff.
- Parsed but incomplete polling envelopes are retryable because polling is
  idempotent, while mismatched provider IDs and unknown statuses fail closed.
  Known provider job IDs are normalized and preserved on polling/cleanup
  failures for durable reconciliation.
- Provider-side transcript deletion is idempotent. HTTP `404` is treated as an
  already-absent cleanup result; a `2xx` response must still confirm the exact
  requested transcript ID. Malformed or mismatched confirmations remain retryable
  and preserve the provider job ID for a future cleanup queue.
- The AssemblyAI API key must later be stored only as a Supabase Edge Function
  project secret. It must never use an `EXPO_PUBLIC_*` name or appear in Git,
  migrations, job payloads, provider metadata, logs, or client responses.
