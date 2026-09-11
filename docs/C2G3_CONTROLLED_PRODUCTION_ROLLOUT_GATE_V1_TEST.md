# C2G.3 - Controlled Production Transcription Rollout Gate Test Plan v1

## Purpose

This plan validates the C2G.3 design artifact only. It does not execute a
production build, deploy an Edge Function, query or mutate production, change a
secret or Cron job, run a migration, call the provider, or enable
transcription.

```text
SOURCE_BASE_SHA=4549429575c9ee7b449fd531d8c6dd49ccc19945
SOURCE_BASE_TREE=1d5777e76c4fd0bbf72ff731268d234da91cee83
C2G3_VALIDATION_SCOPE=DOCUMENTATION_AND_EXISTING_SOURCE_CONTRACTS_ONLY
PRODUCTION_MUTATION=NONE
READY_TO_ENABLE_TRANSCRIPTION=NO
```

## Exact repository scope

```text
docs/C2G3_CONTROLLED_PRODUCTION_ROLLOUT_GATE_V1_DESIGN.md
docs/C2G3_CONTROLLED_PRODUCTION_ROLLOUT_GATE_V1_TEST.md

added=2
modified=0
deleted=0
```

No frontend, Supabase, migration, function, EAS, native, dependency, lockfile,
SQLite, RLS, Storage, Cron, or secret file may change in C2G.3.

## Automated source locks

The apply-and-validate runner must prove the source checkpoint and the current
contained behavior before accepting the documents:

- branch is `milestone1sync`;
- HEAD and tree equal the recorded source checkpoint;
- worktree and real Git index start clean;
- remote branch still equals the source checkpoint;
- both C2G.3 document paths are absent at HEAD;
- `TRANSCRIPTION_PRODUCTION_MUTATIONS_APPROVED` remains false;
- the release validator still enforces the source lock;
- request availability checks the source gate before cached/server state;
- session editor/restore handoff remains source-gated;
- production EAS profile uses the production environment;
- no `production-canary` profile exists yet;
- `supabase/config.toml` retains `true/true/false` JWT gateway modes for
  delete-account/request/worker;
- per-function `deno.json` files retain exact pinned dependencies;
- the patch adds exactly the two approved Markdown files.

## Document contract

The design must include all of these markers and decisions:

```text
C2G3_STATUS=DESIGN_ONLY
SOURCE_PRODUCTION_MUTATION_APPROVAL=false
PRODUCTION_TRANSCRIPTION_FLAG=DISABLED
READY_TO_ENABLE_TRANSCRIPTION=NO
DISTRIBUTION_SCOPE=OPERATOR_CONTROLLED
DISTRIBUTION_SCOPE=UNKNOWN_OR_UNCONTROLLED
GLOBAL_ENABLE=BLOCKED
production-canary
EAS_BUILD_GIT_COMMIT_HASH
MIGRATION_LEDGER=ABSENT_DO_NOT_REPAIR
ENABLE PRODUCTION TRANSCRIPTION CANARY
DISABLE PRODUCTION TRANSCRIPTION
CONTAINED_DRAINING
DO_NOT_RUN_MIGRATIONS
DO_NOT_ENABLE_TRANSCRIPTION
```

The documents must state that:

- source approval and server flag are separate keys;
- server flag windows are explicit and bounded;
- the flag returns to false after provider processing is confirmed;
- existing processing and cleanup may continue while the flag is false;
- Cron remains active while accepted work or cleanup exists;
- old/uncontrolled clients block a global canary;
- backend deployment provenance is closed before source approval;
- the canary build is internal and never auto-submitted;
- build Git commit hash must equal the reviewed activation commit;
- request, normal edit, and restore-save are separate canaries;
- uncertain provider/edit outcomes reuse the same durable UUID;
- sustained activation is a separate decision;
- migration ledger repair and migration replay are forbidden.

## Secret and privacy contract

The patch must not contain:

- the production project ref;
- production row counts or user/session/version identifiers;
- a database password or password assignment;
- a Supabase access token;
- a publishable/anon, secret, or service-role key value;
- a worker-token value;
- an AssemblyAI key value;
- a JWT or Authorization header value;
- a secret digest or signed URL;
- transcript content or private Storage paths.

Secret *names* may appear only as prohibited-output examples. Source-tree,
blob, commit, and non-secret design hashes are allowed.

## Repository validation

Run from `frontend` after the documentation patch is applied:

```bash
yarn tsc --noEmit

yarn jest --runInBand \
  __tests__/release-readiness.test.ts \
  __tests__/transcription-production-release-lock.test.ts \
  __tests__/transcription-request-mobile.test.ts \
  __tests__/transcript-edit-worker.test.ts

yarn eslint --max-warnings 0 \
  src/config/transcription-release.ts \
  src/services/transcription/feature-availability.ts \
  app/session/'[id].tsx' \
  scripts/validate-release-readiness.js \
  __tests__/release-readiness.test.ts \
  __tests__/transcription-production-release-lock.test.ts

yarn jest --runInBand
yarn lint
yarn eslint --max-warnings 0 --no-cache src app
npx expo install --check
npx expo-doctor
```

Run the production release check through the EAS production environment using a
reviewed, pinned EAS CLI version. Do not use `@latest` inside the authoritative
runner.

Then from the repository root:

```bash
git diff --check
git status --short --untracked-files=all
```

Required result:

```text
TypeScript=PASSED
targeted Jest=PASSED
targeted ESLint zero warnings=PASSED
full Jest=PASSED
full lint=PASSED
full src/app ESLint zero warnings=PASSED
production release check=PASSED
Expo dependency check=PASSED
Expo Doctor=PASSED
real Git index=clean
exact file scope=2 added / 0 modified / 0 deleted
```

## Future Gate A acceptance - canary profile and validator

C2G.3 does not execute this gate. The future patch must prove:

```text
PRODUCTION_CANARY_PROFILE=internal_android_apk
PRODUCTION_CANARY_ENVIRONMENT=production
PRODUCTION_CANARY_AUTO_SUBMIT=disabled
PRODUCTION_CANARY_NODE=20.19.4
PRODUCTION_CANARY_YARN=1.22.22
PRODUCTION_VALIDATION_BY_RESOLVED_ENVIRONMENT=PASSED
SOURCE_PRODUCTION_MUTATION_APPROVAL=false
SERVER_FEATURE_FLAG=false
```

A canary profile that bypasses production release validation is a hard failure.

## Future Gate B acceptance - backend deployment provenance

Before any deploy:

```text
server flag=false
source approval=false
active jobs=0
active runs=0
unresolved provider state=0
manual-review provider state=0
database integrity=PASSED
function source/input blobs=locked
```

After each contained function deploy:

```text
expected function version increment=PASSED
expected gateway mode=PASSED
downloaded TypeScript parity=PASSED
unauthenticated fail-closed smoke=PASSED
server flag remains false=PASSED
database quiescence remains true=PASSED
Cron/secret-name inventory unchanged=PASSED
```

After the worker deploy, a Vault-backed Cron response and a second database
reconciliation must pass. No migration, secret, or Cron mutation is permitted.

## Future Gate C/D acceptance - source approval and canary build

The source approval patch must be narrow and separately reviewed. The build must
prove:

```text
BUILD_PROFILE=production-canary
BUILD_DISTRIBUTION=internal
BUILD_PLATFORM=android
BUILD_GIT_COMMIT_HASH=<exact reviewed activation commit>
BUILD_STATUS=finished
SERVER_FEATURE_FLAG=disabled
DISTRIBUTION_SCOPE=OPERATOR_CONTROLLED
LOCAL_CANARY_MUTATION_QUEUES=empty
```

If distribution is unknown or uncontrolled, stop and require a server allowlist
or minimum-client-version gate.

## Future Gate F/G acceptance - one provider canary

Pre-enable markers:

```text
SOURCE_APPROVAL=true
SERVER_FLAG=false
ACTIVE_JOBS=0
ACTIVE_RUNS=0
UNRESOLVED_PROVIDER=0
MANUAL_REVIEW=0
```

The operator must type:

```text
ENABLE PRODUCTION TRANSCRIPTION CANARY
```

The flag may remain true only until the single run reaches provider processing,
with a maximum window of three minutes. Then the operator must execute the
independently verified containment path equivalent to:

```text
DISABLE PRODUCTION TRANSCRIPTION
```

Success requires one durable request, one provider submission, one completed
provider version, valid segments/checksum/language evidence, local result and
history convergence, provider cleanup success, and final zero active/unresolved
state. Failure must not create a second request or provider UUID.

## Future Gate H acceptance - edit and restore

Normal edit and restore-save are separate windows. Each requires:

```text
flag false before window
no pending local edit outbox
one explicit user action
one stable client UUID
one immutable user_edit version
correct parent/current transition
flag false after outcome
zero active/unresolved backend state
```

The restore operation must first create only a local draft. Saving that draft is
the separately confirmed remote mutation. Historical versions remain immutable.

## Hard stop conditions

Stop without attempting the next gate when any of these occurs:

```text
remote/source drift
uncontrolled production distribution
feature flag unexpectedly true
active or duplicate jobs/runs
unresolved cleanup or manual review
function metadata/source/gateway drift
Deno deployment provenance not established
schema/security/data-integrity drift
Cron duplicate, wrong target, or non-Vault token path
missing required secret name
ambiguous provider submission
ambiguous edit outcome
canary build commit mismatch
local durable queue not empty
```

## C2G.3 completion markers

```text
C2G3_CONTROLLED_ROLLOUT_GATE_DESIGN=PASSED
C2G3_REPOSITORY_CHANGE=DOCUMENTATION_ONLY
PRODUCTION_MUTATION=NONE
PRODUCTION_TRANSCRIPTION_FLAG=DISABLED
SOURCE_PRODUCTION_MUTATION_APPROVAL=false
READY_FOR_NEXT_SOURCE_GATE=YES
READY_TO_ENABLE_TRANSCRIPTION=NO
DO_NOT_RUN_MIGRATIONS
DO_NOT_DEPLOY_FUNCTIONS
DO_NOT_SET_OR_UNSET_SECRETS
DO_NOT_CHANGE_CRON
DO_NOT_BUILD_OR_DISTRIBUTE_CANARY_YET
DO_NOT_ENABLE_TRANSCRIPTION
```
