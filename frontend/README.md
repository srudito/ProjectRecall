# Project Recall mobile app

Expo Router / React Native / TypeScript client for Project Recall.

## Requirements

```text
Node 20.19.4
Yarn 1.22.22
Expo SDK 54
```

From the repository root:

```bash
cd frontend
nvm use
yarn install --frozen-lockfile
cp .env.example .env
```

Only public Expo configuration belongs in `.env`. The Supabase value must be a
publishable key or legacy `anon` key. Never place secret/service-role keys, OAuth
client secrets, JWT secrets, database passwords, or user tokens there.

## Development build

```bash
npx expo start --dev-client --clear
```

The installed development build is required for real microphone recording,
background audio, native pickers, secure storage, and deep links.

## Verification

```bash
npx tsc --noEmit
npx jest --runInBand
npx expo-doctor
```

Run targeted ESLint for changed files. For release configuration:

```bash
node ./scripts/validate-release-readiness.js --production
```

This command expects real production public environment values.

## EAS builds

```bash
npx eas-cli@latest build --platform android --profile development
npx eas-cli@latest build --platform android --profile preview
npx eas-cli@latest build --platform android --profile production
```

`preview` produces an internally distributed APK that runs without Metro.
