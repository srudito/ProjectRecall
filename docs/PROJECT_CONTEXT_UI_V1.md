# Project Context UI v1

This checkpoint makes the existing `sessions.project_id -> projects.id`
relationship visible and navigable without duplicating project names on
session rows.

## Implemented behavior

- Library session cards show their project name.
- Sessions without a project show `No project` / `Tanpa proyek`.
- Sessions referencing a project that is not currently resolvable show
  `Unknown project` / `Proyek tidak dikenal`.
- Archived project references remain recognizable when the project row can be
  retrieved locally or from Supabase.
- Session Overview shows the linked project and opens Project Detail.
- Project cards on Home and Library open Project Detail.
- Project Detail shows project metadata and every session whose `project_id`
  matches the project UUID.
- Project Detail sessions open Session Detail.
- Session search also matches project names.

## Data design

The implementation does not add a `project_name` column to `sessions`.
Project names are resolved through:

```text
sessions.project_id
  -> projects.id
  -> projects.name
```

This avoids stale duplicated names when a project is renamed.

## Manual verification

### Library sessions

1. Create Project A and Project B.
2. Create one recorded session in Project A.
3. Create one recorded session without a project.
4. Open Library -> Sessions.
5. Verify the cards display:
   - `Project: Project A`
   - `Project: No project`
6. Search for `Project A`; the linked session should remain visible.

### Session Overview

1. Open the Project A session.
2. Open Overview.
3. Verify Project A is shown.
4. Tap the project name.
5. Verify Project Detail opens.

### Project Detail

1. Open Project A from Library -> Projects.
2. Verify project name, status, description, and session count.
3. Verify only sessions belonging to Project A are listed.
4. Tap a session and verify Session Detail opens.
5. Press Back and verify navigation returns safely.

### Cross-platform

Repeat the Library, Session Overview, and Project Detail checks in Expo Go and
web preview. Project labels should agree because both are resolved from the
same stable project UUID.

### Security

Sign in as User B and verify that Project Detail and project names from User A
are not visible. RLS remains the authorization boundary; the UI does not use an
admin or service-role client.
