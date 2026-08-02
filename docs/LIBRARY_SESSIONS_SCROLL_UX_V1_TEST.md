# Library Sessions Scroll UX v1 Test Plan

## Automated checks

From `frontend/`:

```bash
npx tsc --noEmit

npx jest \
  __tests__/library-organization.test.ts \
  __tests__/localization.test.ts \
  --runInBand

npx jest --runInBand

npx eslint \
  "./app/(tabs)/library.tsx" \
  "./src/services/library/library-organization.ts" \
  "./__tests__/library-organization.test.ts"

npx expo-doctor
```

## Manual Android test

1. Open Library and select Sessions.
2. Confirm Search, filters, and sort/view controls are visible initially.
3. Scroll down through a sufficiently long session list.
4. Confirm Search, filters, and sort/view controls scroll off-screen while the
   Library title and Projects/Sessions tabs remain visible.
5. Confirm the result area is taller than before.
6. Confirm Back to top is hidden near the top and appears only after a
   meaningful scroll.
7. Tap Back to top and confirm the list returns to the true top, revealing
   Search and filters.
8. Confirm the action does not cover the final session row.
9. Repeat in card and compact view.
10. Verify All, Starred, Local, Pending, Syncing, Synced, and Failed filters.
11. Verify search by session title and project name.
12. Verify sort changes, star toggles, and opening a session still work.
13. Switch to Projects and confirm its existing behavior is unchanged.
14. Switch language to Indonesian and confirm the Back to top accessibility
    label is localized.

## Acceptance criteria

- Sessions controls scroll with the list.
- Projects remains unchanged.
- Back to top appears after 600 px and returns to offset zero.
- No regression in search, filters, sorting, view mode, starring, navigation,
  or synchronization display.
