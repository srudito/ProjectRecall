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

Screens gated by feature flags (currently ALL false, therefore hidden):

- Ask AI (`ask_ai_enabled`)
- Transcription views (`transcription_enabled`)
- Live transcription (`live_transcription_enabled`)
- Billing (`billing_enabled`)
- Ads (`ads_enabled`)
- Admin control panel (`admin_enabled`)

No non-functional menu is exposed for any of the above. When a flag becomes
true, the corresponding route file will be added and the tab bar / menus
adjusted accordingly.

## Project context navigation

Project and session navigation is bidirectional:

```text
Library project card -> Project Detail -> Session Detail
Library session card -> Session Detail -> Project Detail
```

Session cards and Session Overview resolve project names from the stable
`sessions.project_id -> projects.id` relationship. Project names are not copied
into session rows.
