# Library Sessions Scroll UX v1

## Scope

This milestone improves only the Library `Sessions` tab. It does not change
project/session persistence, synchronization, filtering semantics, starring,
or the Projects tab.

## Changes

- Moves the Sessions search field, filter chips, preference error, and
  sort/view toolbar into the `SectionList` header so they scroll away with the
  results.
- Keeps the Library title and Projects/Sessions tab switcher fixed.
- Adds a conditional floating Back to top action after 600 px of vertical
  scroll.
- Returns to the true list origin so the search and filters are visible again.
- Adds English and Indonesian accessibility text for the action.
- Adds a focused unit test for the visibility threshold.

## Preserved behavior

- Session filters and search values remain unchanged while scrolling.
- Card/compact view, session sorting, starring, project navigation, and sync
  status rendering are unchanged.
- Section headers remain non-sticky.
- Projects retains its existing `FlatList` layout.

## Files

- `frontend/app/(tabs)/library.tsx`
- `frontend/src/services/library/library-organization.ts`
- `frontend/__tests__/library-organization.test.ts`
- `frontend/src/i18n/en/library.json`
- `frontend/src/i18n/id/library.json`
