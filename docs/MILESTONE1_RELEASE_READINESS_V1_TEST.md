# Milestone 1 Release Readiness v1 — Verification

## Automated checks

```bash
cd /app/frontend
npx tsc --noEmit
npx jest __tests__/release-readiness.test.ts __tests__/localization.test.ts --runInBand
npx jest --runInBand
npx eslint \
  "./app.config.js" \
  "./app/(tabs)/profile.tsx" \
  "./app/record/active.tsx" \
  "./src/config/branding.ts" \
  "./src/config/env.ts" \
  "./src/config/public-release-values.ts" \
  "./src/config/release.ts" \
  "./__tests__/release-readiness.test.ts" \
  "./scripts/validate-release-readiness.js" \
  --max-warnings=0
npx expo-doctor
```

Static configuration check without production values:

```bash
node ./scripts/validate-release-readiness.js
```

Production check after real public values are configured in the local/EAS
environment:

```bash
node ./scripts/validate-release-readiness.js --production
```

`EXPO_PUBLIC_SUPABASE_ANON_KEY` must contain a Supabase publishable key or a
legacy JWT whose payload role is `anon`. Secret/service-role, privileged,
malformed, and placeholder values fail closed in development, preview, and
production EAS profiles. The key is optional outside production only when it is
absent; any supplied value must be frontend-safe. Never paste real keys into
shell history or chat. Prefer EAS environment variables for actual builds.

The release-readiness Jest suite also verifies runtime/build parity for public
multi-label DNS URLs, internal/special-use/IP hosts, URI-unsafe support email
values, and non-production EAS key rejection.

## Native configuration verification

Create a fresh preview build because `app.json` changed:

```bash
cd /app/frontend
npx eas-cli@latest build --platform android --profile preview
```

The preview APK must run without Metro.

Inspect the generated/merged Android manifest and verify:

```text
android:allowBackup="false"
READ_MEDIA_AUDIO absent
READ_MEDIA_IMAGES absent
READ_MEDIA_VIDEO absent
READ_EXTERNAL_STORAGE absent or maxSdkVersion=32
WRITE_EXTERNAL_STORAGE absent
RECORD_AUDIO present
CAMERA present
```

## Production binary verification

Generate an APK set from the production AAB with `bundletool`, inspect the base
manifest, and verify:

```text
SYSTEM_ALERT_WINDOW absent
```

The overlay permission may be present in React Native debug/preview binaries,
but it must be removed by the production-only app-config rule.

## UI verification

- Profile version equals the app config version and has no `(Milestone 1)` text.
- Privacy, terms, and support actions appear only when their public values are
  configured.
- Credential-bearing, reserved, loopback, and malformed destinations remain
  hidden and fail the production validator.
- Each configured action opens the correct destination.
- Existing Profile account/security/preferences behavior is unchanged.

## Backup/reinstall verification

1. Install the new preview APK.
2. Create private local data with a disposable account.
3. Delete the disposable account and verify local cleanup.
4. Uninstall and reinstall the same package.
5. Confirm deleted private data is not restored by Android backup.
6. Confirm Welcome appears and the deleted account cannot sign in.

Do not confuse reinstall testing with crash recovery: crash recovery must be
tested without uninstalling or clearing app data.

## Release gates that remain manual

- Configure real production support/legal values.
- Preview APK full regression without Metro, including Android image/video
  selection with no broad media-library permission prompt.
- Production AAB build and version-code inspection.
- Fresh migrations `0001–0012` on an isolated Supabase/Postgres environment.
- Store listing/privacy-policy review.
