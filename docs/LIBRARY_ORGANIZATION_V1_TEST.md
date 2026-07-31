# Library Organization v1 Manual Test

## Sessions timestamp

1. Create a recorded session today.
2. Create or locate an older recorded session.
3. Open Library -> Sessions.
4. Verify every result shows a localized time or date/time.
5. Verify recorded sessions use the recording start time rather than a later
   synchronization update time.

## Date grouping

With `Newest first` selected, verify chronological sections appear in this
order when data exists:

```text
Today
Yesterday
This week
Earlier
```

Select `Oldest first` and verify the section order reverses.

Select `Longest recording` or `Shortest recording` and verify the list is
sorted globally without date section headers.

## Session view modes

1. Select Card view.
2. Verify title, project, timestamp, duration, and synchronization status are
   visible.
3. Select Compact view.
4. Verify the same information is available in a denser two-line layout.
5. Close and reopen Project Recall.
6. Verify the selected session view mode remains active.

## Project organization

1. Open Library -> Projects.
2. Verify every project shows session count and last activity.
3. Test Recent activity, Newest project, and Project name sorts.
4. Test Card and Compact views.
5. Close and reopen the application and verify the project preferences persist
   independently of the Sessions preferences.

## Search and filters

1. Search using a session title.
2. Search using a project name.
3. Apply Local, Pending, Syncing, Synced, and Failed filters.
4. Verify sorting and view mode continue to work with filtered results.
5. Verify `No matches` appears for an empty filtered/search result.

## Cross-platform

Repeat the main checks in:

- Android development build;
- standalone web preview.

Date/time output may differ in punctuation or 12/24-hour display according to
locale and device settings, but the underlying moment must be the same.

## Regression

Verify:

- Projects and Sessions both scroll through the full result list;
- no large blank area appears in Sessions;
- Create Project and Retry synchronization still work;
- opening a Project or Session still navigates correctly;
- offline local Projects and Sessions remain visible;
- switching sort or view mode does not create, update, or duplicate cloud rows.
