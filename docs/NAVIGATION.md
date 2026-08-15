# Navigation

Route groups follow `expo-router` file conventions. All routes in `(tabs)`
require an authenticated session.

| Screen                  | Route                          | Parent    | Auth | Feature flag |
| ----------------------- | ------------------------------ | --------- | ---- | ------------ |
| Splash / redirect       | `/`                            | root      | any  | —            |
| Welcome                 | `/(auth)/welcome`              | `(auth)`  | no   | —            |
| Sign In                 | `/(auth)/sign-in`              | `(auth)`  | no   | —            |
| Sign Up                 | `/(auth)/sign-up`              | `(auth)`  | no   | —            |
| Verify Email            | `/(auth)/verify-email`         | `(auth)`  | no   | —            |
| Forgot Password         | `/(auth)/forgot-password`      | `(auth)`  | no   | —            |
| Reset Password          | `/(auth)/reset-password`       | `(auth)`  | no   | —            |
| Onboarding — App lang.  | `/(onboarding)/language`       | `(onb)`   | yes  | —            |
| Onboarding — Spoken     | `/(onboarding)/spoken-language`| `(onb)`   | yes  | —            |
| Onboarding — Consent    | `/(onboarding)/consent`        | `(onb)`   | yes  | —            |
| Onboarding — Privacy    | `/(onboarding)/privacy`        | `(onb)`   | yes  | —            |
| Onboarding — Workspace  | `/(onboarding)/workspace`      | `(onb)`   | yes  | —            |
| Home                    | `/(tabs)/home`                 | `(tabs)`  | yes  | —            |
| Library                 | `/(tabs)/library`              | `(tabs)`  | yes  | —            |
| Record (central action) | `/(tabs)/record`               | `(tabs)`  | yes  | —            |
| Profile                 | `/(tabs)/profile`              | `(tabs)`  | yes  | —            |
| Record — Setup          | `/record/setup`                | root      | yes  | —            |
| Record — Active         | `/record/active`               | root      | yes  | —            |
| Record — Review         | `/record/review`               | root      | yes  | —            |
| Session Detail          | `/session/[id]`                | root      | yes  | —            |
| Project Detail          | `/project/[id]`                | root      | yes  | —            |
| Delete Account          | `/account/delete`              | root      | yes  | —            |

Remote creation/execution controls remain gated by their authoritative feature
flags:

- Ask AI (`ask_ai_enabled`)
- New transcription requests (`transcription_enabled`)
- Live transcription (`live_transcription_enabled`)
- Billing (`billing_enabled`)
- Ads (`ads_enabled`)
- Admin control panel (`admin_enabled`)

The read-only Transcript tab lives inside Session Detail rather than a separate
route. It reads only the private SQLite cache and provides continuous text plus a
timestamped local segment browser, so an already synchronized transcript remains
available offline even if new remote transcription requests are later disabled.
Timestamp rows do not seek audio yet. No non-functional menu is exposed for
future features whose implementation is still absent.

## Project context navigation

Project and session navigation is bidirectional:

```text
Library project card -> Project Detail -> Session Detail
Library session card -> Session Detail -> Project Detail
```

Session cards and Session Overview resolve project names from the stable
`sessions.project_id -> projects.id` relationship. Project names are not copied
into session rows.

## Session deletion

Session Detail requires confirmation before deletion. Native deletion hides the
session immediately and continues cloud/private-Storage cleanup through a
durable queue when offline. Web completes the ordered remote cleanup before
returning to Library.

## Delete Account privacy boundary

`AccountDeletionBoundary` loads the persistent local deletion marker before
mounting the recording/sync coordinators or the root stack. While a marker is
present, private routes are replaced by a dedicated deletion/cleanup status
screen. This prevents Back navigation or cold-start deep links from reopening
private account data after the cloud account has been deleted.
