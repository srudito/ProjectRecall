# Recording

## State machine

```
idle
 └─(request permission)→ requesting_permission
       ├─(granted)→ preparing
       │              ├─(prepare success)→ recording ⇄ paused → stopping ─→ saved | failed
       │              └─(prepare failed)→ failed
       └─(denied)→ failed
```

See `src/services/recording/state-machine.ts`. All transitions are covered by
unit tests. Invalid transitions (double Start, double Stop, resuming when not
paused, pausing when idle) are rejected without side-effect.

## Duration & offset tracking

`src/services/recording/offset-tracker.ts` maintains an accumulator of active
recording segments:

```
active segment sum + (now - segment_start if currently recording)
```

Paused time is never counted. `reconcileDuration` prefers whichever of the
tracker value and recorder-reported duration is larger, so a brief lifecycle
interruption still yields a monotonic offset.

## Background recording

- iOS: `UIBackgroundModes: ["audio"]` in `app.json`.
- Android: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`,
  `POST_NOTIFICATIONS`.

Real background behaviour, foreground-service notification, and screen-lock
resumption **require a development build**. Expo Go does not host a foreground
service, so verification must happen on a physical device.

## Interruption handling

- Incoming call: expo-audio surfaces an interruption event. On resume the app
  transitions from `paused → recording` if the user tapped Resume, otherwise
  the state machine remains `paused`.
- Bluetooth microphone switch: expo-audio picks the new route on the next
  segment. We surface a status message and continue.
- Low storage: `RECORDING_LIMITS.minFreeBytesWarning` triggers a warning.

## Physical-device verification

See `ANDROID_TEST_CHECKLIST.md` for the required scenarios. Nothing here is
marked "tested" until executed on a real Android device.

## Future streaming checksum

Milestone 1 stores `checksum_sha256 = NULL` on both recordings and media assets
because computing a checksum by loading a large file entirely into JS memory is
unsafe. A follow-up milestone will stream the file through a native hash while
uploading.

## Durable recording file and cloud playback

After Stop, native builds copy the recorder output into the app document
folder before the original cache URI can be purged. One local recording row and
one upload operation are committed atomically. The audio remains playable from
the local URI while upload is pending.

The synchronized object is stored in private bucket `session-assets` under:

```text
{workspace_id}/{session_id}/{recording_id}/{file_name}
```

The cloud `recordings.local_file_uri` value is always `NULL`. Session Detail
uses a native local file when present and otherwise requests a short-lived
signed URL. This permits playback after reinstall without making recordings
public.

Upload progress is currently represented by honest state labels rather than a
fabricated percentage. See `RECORDING_STORAGE_SYNC_V1_TEST.md` for online,
offline, reinstall, retry, and RLS checks.
