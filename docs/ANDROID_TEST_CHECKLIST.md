# Android physical-device test checklist

Nothing here can be marked "tested" until executed on a real Android device
using a development build. Expo Go is not sufficient for any item.

## Setup

- [ ] Fresh install from EAS development build
- [ ] English is the default language
- [ ] Switch to Bahasa Indonesia in Profile → App language
- [ ] Language persists after app restart
- [ ] Switching app language does NOT alter spoken-language preferences

## Permissions

- [ ] Microphone permission prompt appears on first record
- [ ] Denying microphone shows a friendly error with Open Settings link
- [ ] Camera permission prompt appears when taking a photo
- [ ] Media library permission prompt appears when picking a photo/video
- [ ] Notifications permission prompt appears when starting a foreground recording

## Recording — basic

- [ ] Start recording
- [ ] Timer increments exactly 1s per second
- [ ] Recording status indicator turns red
- [ ] Pause — timer freezes
- [ ] Resume — timer continues; paused seconds excluded
- [ ] Stop — session appears in Review

## Recording — background / lock

- [ ] Home button → recording continues in foreground service
- [ ] Foreground-service notification shows and cannot be dismissed
- [ ] Screen lock → recording continues
- [ ] Return to app — offset is consistent (no double-counted paused time)

## Evidence — mid-recording

- [ ] Take photo → returned to recording, note & bookmark still work
- [ ] Select existing photo
- [ ] Select existing video
- [ ] Select document (PDF)
- [ ] Add text note (multiline, keyboard dismiss doesn't lose draft)
- [ ] Add bookmark (rapid tap → single bookmark, not duplicates)

## Offset correctness

- [ ] Record 60s, pause 30s, resume, record 10s
- [ ] Add a bookmark after resume → offset ≈ 70s (not 100s)
- [ ] Add note during recording → offset matches wall clock elapsed active time

## Interruptions

- [ ] Incoming phone call → recording pauses; app surfaces status; user can resume
- [ ] Bluetooth mic connect/disconnect during recording

## Storage

- [ ] Low storage → warning is shown; recording still works within limits

## Networking

- [ ] Offline while recording → recording continues locally
- [ ] Connectivity restored → upload queue drains
- [ ] Failed upload → manual retry works
- [ ] Wi-Fi only preference respected on cellular

## Restart & durability

- [ ] Force-stop app, relaunch → completed session still shows
- [ ] Recording file still plays after relaunch
- [ ] Upload queue survives relaunch

## Playback & timeline

- [ ] Play recorded audio
- [ ] Tap timeline timestamp → audio seeks

## Deletion

- [ ] Delete confirmation can be cancelled without changing the session
- [ ] Delete a session — recording, evidence, notes, bookmarks, timeline, and cloud objects removed
- [ ] Delete while offline — session hides immediately and cleanup resumes after reconnect
- [ ] Delete while binary upload is in progress — no object or metadata is recreated
- [ ] Orphan object below the session prefix is removed
- [ ] Cloud deletion partial failure surfaces as "cloud cleanup pending"
- [ ] Deleted session does not return after Expo Go reinstall
