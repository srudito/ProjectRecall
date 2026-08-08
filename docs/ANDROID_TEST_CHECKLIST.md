# Android Milestone 1 release checklist

Run this checklist on the same installed development/preview build unless a
step explicitly says fresh install. Expo Go is not sufficient.

## Build and configuration

- [ ] New binary built after `android.allowBackup=false` and permission changes
- [ ] Preview APK installs and runs without Metro
- [ ] App version in Profile matches `app.json`
- [ ] Merged manifest has `android:allowBackup="false"`
- [ ] Merged manifest does not request `READ_MEDIA_AUDIO`, `READ_MEDIA_IMAGES`,
      or `READ_MEDIA_VIDEO`
- [ ] `WRITE_EXTERNAL_STORAGE` is absent
- [ ] `READ_EXTERNAL_STORAGE` is absent or constrained to `maxSdkVersion=32`
- [ ] Production AAB base manifest does not request `SYSTEM_ALERT_WINDOW`
- [ ] Microphone and camera permissions remain available
- [ ] Production EAS release check passes with real legal/support values

## Setup and localization

- [ ] Fresh install opens Welcome
- [ ] English is the default language
- [ ] Switch to Bahasa Indonesia in Profile
- [ ] Language persists after app restart
- [ ] App language does not alter spoken-language preferences

## Authentication and account security

- [ ] Email sign-up/verification/sign-in
- [ ] Normal Google sign-in
- [ ] Connect Google identity and refresh Connected Accounts
- [ ] Safely disconnect Google while another identity remains
- [ ] Password reset link opens the dedicated recovery flow
- [ ] Replayed/direct reset route cannot change a password
- [ ] Protected deep links do not flash private UI while signed out

## Permissions and recording

- [ ] Microphone prompt appears on first recording
- [ ] Denial shows a friendly error and Open Settings action
- [ ] Camera prompt appears when taking a photo
- [ ] Image/video system picker works on Android without a broad media-library
      permission prompt
- [ ] Foreground recording notification appears when required
- [ ] Start, pause, resume, and stop recording
- [ ] Timer excludes paused duration
- [ ] Background/screen-lock recording remains consistent
- [ ] Long recording playback is not truncated

## Evidence and timeline

- [ ] Take/select photo
- [ ] Select video
- [ ] Select PDF/DOCX/TXT document
- [ ] Add note and timestamped bookmark
- [ ] Evidence opens after cloud restoration
- [ ] Timeline sorting and seek behavior remain correct

## Offline, retry, and synchronization

- [ ] Cold start offline preserves local projects/sessions
- [ ] Recording/evidence queues survive restart
- [ ] Wi-Fi-only behavior is respected
- [ ] Reconnect drains queues without duplicates
- [ ] Reinstall restoration downloads private cloud metadata/files correctly
- [ ] User A cannot read or mutate User B data

## Library and navigation

- [ ] Projects and Sessions filters/sorts work
- [ ] Card/Compact layouts persist
- [ ] Starred filter and sort work
- [ ] Sessions controls scroll away and Back to top works
- [ ] Android Back does not reveal protected content after sign-out/deletion

## Session deletion

- [ ] Cancel confirmation leaves session unchanged
- [ ] Online deletion removes database rows, private Storage, and local files
- [ ] Offline deletion hides session and resumes cleanup on reconnect
- [ ] Deletion during upload does not recreate metadata or objects
- [ ] Partial cloud cleanup remains visible and retryable

## Delete Account

Use disposable accounts only.

- [ ] Exact `DELETE` confirmation is required
- [ ] Active recording blocks account deletion
- [ ] Missing/old authentication requests safe reauthentication
- [ ] Server blocker does not erase local data
- [ ] Active durable lease returns safe retry state
- [ ] Successful deletion removes Auth user, workspaces, Storage, SQLite rows,
      and app-owned files
- [ ] Force-close without uninstall resumes cleanup and never shows private UI
- [ ] Deleted account cannot sign in again
- [ ] Shared-device data for another user remains intact

## Backup and reinstall semantics

- [ ] Uninstall/reinstall does not restore a deleted user's private app data
- [ ] Fresh install begins at Welcome
- [ ] A cloud account that still exists can restore only through authenticated
      sync, not Android backup

## Final release result

- [ ] TypeScript passes
- [ ] Full Jest passes
- [ ] Targeted ESLint passes with zero warnings
- [ ] Expo Doctor passes
- [ ] Preview APK regression passes without Metro
- [ ] Fresh migration smoke test passes in an isolated environment
