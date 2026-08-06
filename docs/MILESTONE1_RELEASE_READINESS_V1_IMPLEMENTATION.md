# Milestone 1 Release Readiness v1 — Implementation

## Purpose

This pass closes source-level release configuration gaps without changing
Milestone 1 domain behavior.

## Changes

### Android privacy and permissions

- Sets `expo.android.allowBackup` to `false` so cloud backup cannot restore the
  app's SQLite, recordings, evidence, or deletion state.
- Removes broad storage permissions from the app-level declaration and
  explicitly blocks `READ_MEDIA_AUDIO`, `READ_MEDIA_IMAGES`, and
  `READ_MEDIA_VIDEO`. Library-scoped legacy permissions may remain only with
  Android max-SDK limits for older picker compatibility.
- Uses the Android system image/video picker without requesting media-library
  permission. The existing iOS media-library permission flow remains
  platform-gated.
- Retains microphone, camera, foreground-service, notification, network-state,
  and audio-settings permissions required by current features.

These are native configuration changes and require a new build.

### Reproducible toolchain and build versions

- Pins Node `20.19.4` and Yarn `1.22.22` for all EAS profiles.
- Adds `/app/frontend/.nvmrc` and package `engines`.
- Keeps EAS remote version source and enables production `autoIncrement`.

### Public release configuration

Support email, privacy policy, and terms URLs now come from public EAS/Expo
variables. Placeholder links are not rendered in development builds.

Every EAS build runs `validate-release-readiness.js` before dependency
installation and fails if a supplied Supabase frontend key is secret,
privileged, malformed, or a placeholder. Production additionally requires all
public release values and accepts support/legal URLs only on valid public
multi-label DNS hosts without credentials; support email uses a conservative
URI-safe local part and a valid public DNS domain.

No secret value is introduced. All `EXPO_PUBLIC_*` values are public by
design.

### Version display

Profile reads the user-facing version from Expo app configuration and no longer
shows the internal `Milestone 1` label.

### Documentation

README, roadmap, Android checklist, environment template, and release
instructions are reconciled with the implemented Milestone 1 state.

## Out of scope

- Changing the user-facing semantic version from `1.0.0`.
- Upgrading Expo SDK or React Native.
- Adding transcription or AI functionality.
- Supplying the organization's final support/legal values.
- Reconciling the existing development Supabase migration ledger.
