# C2G.3 - Controlled Production Transcription Rollout Gate Design v1

## Status

```text
C2G3_STATUS=DESIGN_ONLY
SOURCE_BASE_SHA=4549429575c9ee7b449fd531d8c6dd49ccc19945
SOURCE_BASE_TREE=1d5777e76c4fd0bbf72ff731268d234da91cee83
SOURCE_PRODUCTION_MUTATION_APPROVAL=false
PRODUCTION_TRANSCRIPTION_FLAG=DISABLED
PRODUCTION_MUTATION=NONE
READY_TO_ENABLE_TRANSCRIPTION=NO
```

This document defines the gates that must exist before Project Recall can run a
controlled production transcription canary. It does not approve a production
feature enable, deploy an Edge Function, change a secret or Cron job, run a
migration, build or distribute an application, or call the transcription
provider.

Historical milestone documents may state that production was untouched. Those
statements describe the state at the time those milestones closed. The current
operational source of truth is the completed C2G.2A containment and C2G.2B
read-only reconciliation audit.

## Confirmed contained baseline

The C2G.2B audit established all of the following without changing production:

- the client source approval is `false`;
- the server `transcription_enabled` flag is `false`;
- production database semantics align through migration 0016;
- the remote migration ledger is absent and must not be repaired or inferred;
- `delete-account`, `transcription-request`, and `transcription-worker` are
  active with the expected gateway modes;
- downloaded deployed TypeScript matches the repository source exactly;
- downloaded-function APIs do not prove deployed `deno.json` parity;
- the transcription database graph is quiescent;
- provider cleanup and manual-review state are empty;
- database RLS, table privileges, RPC privileges, deletion guards, and existing
  data-integrity checks pass;
- one Vault-backed transcription Cron remains active and targets the worker;
- the required provider and worker-token secret names exist, while no secret
  value or digest was printed;
- functions, Cron, and secret names are safe to retain while the feature is
  disabled.

Production identifiers, row counts, timestamps, transcript content, provider
job identifiers, user identifiers, database credentials, access tokens, and
secret digests are intentionally not committed in this design.

## Current source constraints that shape the rollout

### Two independent admission keys

Production mutation admission currently requires both:

1. `TRANSCRIPTION_PRODUCTION_MUTATIONS_APPROVED=true` in reviewed source; and
2. `public.feature_flags.transcription_enabled=true` in the target database.

The first key is currently false in `frontend/src/config/transcription-release.ts`.
The second key was changed from true to false by C2G.2A. Neither key may be
opened automatically by a build, deploy, login, app start, network event, or
Cron invocation.

### Request UI and worker behavior

`resolveTranscriptionFeatureEnabled()` checks the source release gate before it
reads or trusts the cached/server flag. The request service and request worker
also enforce the source gate. Existing result and current-version convergence
remain available while mutation admission is closed.

### Editor and restore behavior

The session editor/restore handoff is gated by the source approval, not by a
live read of the server feature flag. Once a source-approved production binary
exists, that binary can create local drafts and durable edit intent even while
the server flag is false. The server still rejects the remote edit, but local
intent may remain durable.

Therefore a source-approved canary build must be installed only on an
operator-controlled Android emulator or device with a dedicated canary account.
It must not be distributed to an uncontrolled audience before the server-side
canary gates complete.

### Production-canary build profile does not exist yet

The current `eas.json` has `development`, `preview`, and `production` profiles.
A future source milestone must add an internal Android APK profile that uses the
production EAS environment without auto-submission.

The current EAS pre-install validator treats only the profile named
`production` as production when invoked with `--eas`. A future canary-profile
patch must harden this logic so any build using
`EXPO_PUBLIC_APP_ENV=production` receives all production release checks.

### Dependency-configuration parity gap

The deployed TypeScript source is proven identical to the repository. The
function download API does not return each function's `deno.json`; exact remote
dependency-configuration parity is therefore not proven by C2G.2B.

The repository inputs at the design checkpoint are:

```text
supabase/config.toml blob=7bf9b550fa31f7eddfcfcb4a9b7e8a4fd962c1e8
shared source tree=ff01b167dafcf0a5fcc78feebdd4c19cc9e0aad2
delete-account tree=75e03b3764e8b8aa6d5261c06637c3c8a3315ec5
transcription-request tree=737d03f863a2f56b038b3fd25e7e10cd447a654a
transcription-worker tree=107e632458e00d6fc4bbcfbeb81f1126f56b483b
delete-account deno.json blob=c3fd104f444b377a0d8ca0d80d967dc270d44241
request/worker deno.json blob=58f15b22c061949dcf482bd096479979ab64952e
```

A future contained redeploy must use an exact reviewed checkout containing
those inputs or their separately reviewed successors.

## Non-negotiable rollout invariants

1. The migration ledger remains untouched. Do not run `db push`, migration
   repair, linked reset, or migrations 0013-0016 again.
2. The server feature flag remains false except during an explicitly confirmed,
   time-bounded canary window.
3. Source approval and server admission are changed in separate gates.
4. No gate may print or commit a database password, Supabase access token,
   service-role/secret key, worker token, provider key, JWT, or secret digest.
5. The active Cron remains installed while accepted provider work is processing
   or cleanup is pending.
6. No failed or ambiguous provider submission is retried with a new UUID.
7. No canary proceeds when active work, unresolved cleanup, manual review,
   security drift, function-source drift, or data-integrity drift is present.
8. No global enable proceeds while production-client distribution is unknown or
   uncontrolled.
9. Every production mutation has a read-only preflight, explicit typed
   confirmation, exact mutation scope, and independent post-change verification.
10. Sustained activation is a separate approval after all canaries; it is never
    the automatic final step of a canary runner.

## Distribution safety decision

The server flag is global. It is not a per-user canary flag. Before any
source-approved build or flag-enable window, the operator must choose one of two
paths.

### Path A - closed distribution

Required marker:

```text
DISTRIBUTION_SCOPE=OPERATOR_CONTROLLED
```

All of these must be true:

- the app is not publicly distributed through a store or external test track;
- every production-environment APK/AAB that may still be installed is accounted
  for;
- only a dedicated canary account and operator-controlled Android emulator or
  device can use the source-approved candidate;
- the canary app data is fresh or its local transcription request/edit queues
  are proven empty;
- no other operator will enable or test transcription concurrently.

EAS build inventory is evidence of builds, but it does not prove where an APK
was installed. A manual distribution attestation remains required.

### Path B - open or unknown distribution

Required marker:

```text
DISTRIBUTION_SCOPE=UNKNOWN_OR_UNCONTROLLED
GLOBAL_ENABLE=BLOCKED
```

Do not use a global flag canary. A separate backend milestone must first add a
reviewed server-side canary allowlist or minimum-client-version admission gate.
That work requires its own source, database, RLS, behavior, and rollback review.
C2G.3 does not design or authorize that migration.

## Gate sequence

Each gate below is a separate milestone. Passing one gate does not start the
next gate automatically.

### Gate A - canary build-profile and validator hardening

Source lock remains false.

Add a `production-canary` EAS profile with these properties:

```json
{
  "distribution": "internal",
  "environment": "production",
  "android": { "buildType": "apk" },
  "node": "20.19.4",
  "yarn": "1.22.22",
  "autoIncrement": true
}
```

The profile must not auto-submit. The release validator must treat a build as
production whenever its resolved public app environment is production, even if
the EAS profile is named `production-canary`. Tests must prove missing or unsafe
production variables still fail closed.

Exit state:

```text
SOURCE_PRODUCTION_MUTATION_APPROVAL=false
PRODUCTION_TRANSCRIPTION_FLAG=DISABLED
PRODUCTION_CANARY_PROFILE=VALIDATED_NOT_BUILT
```

### Gate B - contained backend deployment provenance

Keep both admission keys closed. Lock the target project, repository commit,
function source trees, per-function `deno.json` blobs, `config.toml`, CLI
version, pre-deploy function metadata, server flag, Cron, secret-name inventory,
and the quiescent database fingerprint.

Run local/source validation first. Then redeploy one function at a time from the
exact checkout, in this order:

1. `delete-account`;
2. `transcription-request`;
3. `transcription-worker`.

After every deploy:

- verify status, version increment, gateway mode, entrypoint, and bundle digest
  metadata;
- download the deployed function and re-prove exact TypeScript source parity;
- run the unauthenticated fail-closed smoke;
- prove the server flag remains false;
- prove active jobs/runs and unresolved/manual-review provider state remain zero;
- prove no schema, data-integrity, Cron, or secret-name drift.

After the worker deploy, observe a successful Vault-backed Cron invocation and
re-prove the database remains quiescent. Do not rename the existing Cron during
this gate; its historical `dev-v1` name is nomenclature, not target authority.

This gate establishes deployment provenance for the checked-in `deno.json`
inputs. It does not claim that the download API can return those files.

### Gate C - source approval candidate

Only after Gate B passes, prepare a narrow source commit that:

- changes `TRANSCRIPTION_PRODUCTION_MUTATIONS_APPROVED` to true;
- adds a non-secret rollout approval identifier;
- records the approved backend metadata fingerprint and deployment gate ID;
- updates the release validator to require the exact approval shape rather than
  deleting the validator check;
- updates tests for production true, development/preview/test true, and unknown
  environments false;
- preserves every existing mutation entry-point guard;
- contains no backend, migration, secret, Cron, provider, or unrelated UI
  change.

The server feature flag stays false. The commit must pass TypeScript, targeted
and full Jest, targeted and full zero-warning ESLint, production release check,
Expo dependency check, and Expo Doctor.

### Gate D - production-canary build provenance and installation

Build an internal Android APK from the exact Gate C commit using the
`production-canary` profile and production EAS environment. Do not auto-submit
or publish it.

The build evidence must record, without secrets:

```text
EAS_BUILD_PROFILE=production-canary
EAS_BUILD_GIT_COMMIT_HASH=<exact Gate C commit>
EAS_BUILD_PLATFORM=android
DISTRIBUTION=internal
APP_IDENTIFIER=com.srudito.projectrecall
BUILD_STATUS=finished
SERVER_FEATURE_FLAG=DISABLED
```

The EAS build's Git commit hash must equal the reviewed source commit. Record the
build ID, app version, Android build version, and fingerprint in the private
operator evidence bundle, not in public repository docs.

Install the APK only on a dedicated Android emulator or operator-controlled
device. Use a dedicated canary account. Before opening any editor or restore
flow, prove the local transcription-request and edit-outbox queues are empty.

### Gate E - final pre-enable audit

Immediately before the canary window, re-run the contained baseline audit and
require:

```text
SOURCE_APPROVAL=true
SERVER_FEATURE_FLAG=false
DISTRIBUTION_SCOPE=OPERATOR_CONTROLLED
CANARY_BUILD_COMMIT_MATCH=true
FUNCTION_SOURCE_AND_DEPLOYMENT_PROVENANCE=PASSED
ACTIVE_PROCESSING_JOBS=0
ACTIVE_TRANSCRIPTION_RUNS=0
UNRESOLVED_PROVIDER_STATE=0
MANUAL_REVIEW_PROVIDER_STATE=0
CANARY_LOCAL_MUTATION_QUEUES=EMPTY
```

Prepare one fresh synchronized recording. Do not create a local transcription
request yet.

### Gate F - one bounded transcription-request canary

Use exactly one fresh 15-25 second recording with the reviewed manual EN-ID
language pair and no diarization. This single canary covers the basic provider
path and the nullable-primary EN-ID compatibility boundary while limiting
provider spend.

The future runner must:

1. revalidate Gate E;
2. require the phrase `ENABLE PRODUCTION TRANSCRIPTION CANARY`;
3. set only `transcription_enabled` from false to true;
4. admit exactly one local request from the canary build;
5. observe exactly one durable job and one run for that recording;
6. wait until the run is `processing` with a provider identity recorded;
7. immediately set the flag back to false;
8. independently confirm the flag is false before waiting for completion.

The true window is bounded to three minutes. If the run does not reach the
provider-processing boundary, disable the flag and stop. Do not request again.
A provider-free queued row, ambiguous submission, or unexpected count requires
a separate reconciliation/cleanup gate.

### Gate G - contained completion, local convergence, and provider cleanup

The server flag remains false. The active Cron remains installed so already
accepted processing and cleanup can finish.

Required acceptance:

- the original durable job and run reach one terminal success;
- exactly one provider transcript version is created for the canary request;
- transcript segments are contiguous and non-empty;
- Full Text checksum and language-summary validation pass;
- the EN-ID detected pair is preserved and a nullable primary is accepted only
  in the reviewed shape;
- exactly one current final version exists for the session;
- the mobile result receipt and local current-version cache converge;
- Full Text, timestamps, history, and offline read work in the canary build;
- provider cleanup reaches `succeeded`;
- active jobs/runs, unresolved cleanup, and manual review return to zero;
- no duplicate provider submission or duplicate local request appears.

If the canary fails, keep the flag false, do not retry, retain Cron while cleanup
is safe and pending, and inspect only bounded safe diagnostics.

### Gate H - edit and restore canaries

Do not combine this with Gate F. Use the already completed canary transcript.
Each remote mutation gets its own short server-flag window and immediate
containment afterward.

#### H1 - one normal edit

- prove no pending local edit outbox;
- enable the flag;
- submit exactly one reviewed text edit;
- require one immutable `user_edit` version with the stable client UUID and
  correct parent/current transition;
- wait for local current-version convergence;
- disable the flag and re-prove quiescence.

#### H2 - one restore-as-new-version

- prepare one historical restore draft through the existing guarded local path;
- prove no save was submitted automatically;
- enable the flag only for the explicit Save action;
- require one new immutable `user_edit` version whose parent is the then-current
  version and whose text matches the selected historical source;
- prove the historical source remains immutable and current promotion is exact;
- disable the flag and re-prove quiescence.

Any uncertain edit outcome reuses the original durable UUID. Do not create a new
operation as a retry.

### Gate I - sustained activation decision

Passing the canaries does not enable sustained production automatically. A
separate approval must decide whether to keep the global flag disabled, open it
for a limited operator cohort, or implement a server allowlist before wider
distribution.

Sustained activation requires:

- all prior gates passed and their private evidence retained;
- no uncontrolled pre-lock production clients;
- a reviewed monitoring period and provider-spend ceiling;
- a named operator who can execute containment immediately;
- a tested one-row flag-disable runner;
- no active or unresolved provider state at the activation boundary;
- a separate exact confirmation phrase.

## Canary state machine

```text
CONTAINED
  -> BACKEND_PROVENANCE_LOCKED
  -> SOURCE_APPROVED_SERVER_DISABLED
  -> CANARY_BUILD_INSTALLED_SERVER_DISABLED
  -> REQUEST_WINDOW_OPEN
  -> PROVIDER_PROCESSING_CONFIRMED
  -> CONTAINED_DRAINING
  -> TRANSCRIPT_AND_CLEANUP_COMPLETE
  -> EDIT_WINDOW_OPEN
  -> CONTAINED_EDIT_VERIFIED
  -> RESTORE_SAVE_WINDOW_OPEN
  -> CONTAINED_ALL_CANARIES_COMPLETE
  -> AWAITING_SUSTAINED_ACTIVATION_DECISION
```

No transition is automatic. Every transition that opens the server flag has an
explicit operator confirmation and a mandatory transition back to `CONTAINED`.

## Containment and rollback matrix

| Observed state | Immediate action | Required follow-up |
| --- | --- | --- |
| Flag unexpectedly true before a gate | Set only the flag false | Re-run read-only reconciliation; do not continue |
| Request not accepted | Set flag false | Inspect local intent; do not retry automatically |
| Provider-free queued job remains | Keep flag false | Separate provider-free cleanup/reconciliation gate |
| Run is processing | Set flag false; keep Cron active | Let polling and cleanup continue; do not resubmit |
| Provider outcome ambiguous | Keep flag false | Reconcile the same durable job; never create a new UUID |
| Cleanup pending | Keep flag false and Cron active | Wait for succeeded or stop at manual review |
| Manual review appears | Keep flag false | Operator reconciliation; no further canary |
| Edit result uncertain | Set flag false | Reuse the same durable edit UUID after reconciliation |
| Function deploy fails | Keep flag false | Restore/redeploy only from a reviewed exact source checkpoint |
| Database/security drift | Keep both keys closed | Stop rollout and define a separate repair milestone |
| Distribution scope becomes unknown | Keep flag false | Add server allowlist/minimum-version admission before retry |

Disabling Cron is not the default containment action because it can strand
accepted processing or provider cleanup. Cron changes require a separate gate.

## Evidence and output hygiene

Private operator evidence may retain:

- source commit/tree;
- function versions, non-secret bundle metadata, and source manifests;
- EAS build ID, Git commit hash, profile, fingerprint, app version, and build
  version;
- sanitized database counts and boolean integrity markers;
- safe error codes and request IDs;
- feature-flag transition timestamps;
- canary job/run/version identifiers in a private evidence file.

Do not commit or paste into chat:

- database passwords;
- Supabase personal access tokens;
- publishable/anon keys or privileged keys;
- worker token or provider key;
- JWTs, Authorization headers, Vault values, or secret digests;
- signed Storage URLs;
- transcript text, provider metadata payloads, user IDs, or private Storage
  paths.

## C2G.3 exit criteria

C2G.3 is complete only when this design and its test plan are committed without
runtime/source behavior changes and all repository validation gates pass.

```text
C2G3_CONTROLLED_ROLLOUT_GATE_DESIGN=COMPLETE
PRODUCTION_TRANSCRIPTION_FLAG=DISABLED
SOURCE_PRODUCTION_MUTATION_APPROVAL=false
PRODUCTION_MUTATION=NONE
READY_TO_PLAN_GATE_A=YES
READY_TO_ENABLE_TRANSCRIPTION=NO
```

C2G.3 does not start Gate A automatically.
