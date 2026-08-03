import postgres from "postgres";

import {
  DeleteAccountDomainError,
  getDeleteAccountBlockers,
  type DeleteAccountDependencies,
  type DeleteAccountPreflight,
} from "./core.ts";

const SESSION_ASSETS_BUCKET = "session-assets";

type SqlClient = ReturnType<typeof postgres>;

interface PreflightRow {
  user_exists: boolean;
  owned_workspace_ids: string[];
  owned_workspace_count: number;
  owned_workspaces_with_other_members: number;
  memberships_in_non_owned_workspaces: number;
  projects_created_in_non_owned_workspaces: number;
  sessions_created_in_non_owned_workspaces: number;
  media_created_in_non_owned_workspaces: number;
  attachment_events_in_non_owned_workspaces: number;
  notes_in_non_owned_workspaces: number;
  bookmarks_in_non_owned_workspaces: number;
  timeline_events_in_non_owned_workspaces: number;
  owned_workspace_content_by_other_users: number;
  user_owned_storage_objects_in_non_owned_workspaces: number;
  user_owned_storage_objects_outside_supported_bucket: number;
  storage_objects_in_owned_workspaces_owned_by_other_users: number;
  storage_objects_in_owned_workspaces_without_owner: number;
  storage_object_count_in_deletion_scope: number;
}

const loadPreflightWithSql = async (
  sql: SqlClient,
  userId: string,
): Promise<DeleteAccountPreflight> => {
  const [row] = await sql<PreflightRow[]>`
    with
    target as (
      select id
      from auth.users
      where id = ${userId}::uuid
    ),
    owned_workspaces as (
      select workspace.id
      from public.workspaces workspace
      join target
        on workspace.owner_user_id = target.id
    )
    select
      exists(select 1 from target) as user_exists,

      coalesce(
        (
          select array_agg(owned.id::text order by owned.id)
          from owned_workspaces owned
        ),
        array[]::text[]
      ) as owned_workspace_ids,

      (select count(*)::int from owned_workspaces)
        as owned_workspace_count,

      (
        select count(distinct member.workspace_id)::int
        from public.workspace_members member
        join target
          on member.user_id <> target.id
        where member.workspace_id in (
          select id from owned_workspaces
        )
          and member.membership_status <> 'removed'
      ) as owned_workspaces_with_other_members,

      (
        select count(*)::int
        from public.workspace_members member
        join target
          on member.user_id = target.id
        where member.membership_status <> 'removed'
          and member.workspace_id not in (
            select id from owned_workspaces
          )
      ) as memberships_in_non_owned_workspaces,

      (
        select count(*)::int
        from public.projects project
        join target
          on project.created_by = target.id
        where project.workspace_id not in (
          select id from owned_workspaces
        )
      ) as projects_created_in_non_owned_workspaces,

      (
        select count(*)::int
        from public.sessions session_record
        join target
          on session_record.created_by = target.id
        where session_record.workspace_id not in (
          select id from owned_workspaces
        )
      ) as sessions_created_in_non_owned_workspaces,

      (
        select count(*)::int
        from public.media_assets media
        join target
          on media.added_by = target.id
        where media.workspace_id not in (
          select id from owned_workspaces
        )
      ) as media_created_in_non_owned_workspaces,

      (
        select count(*)::int
        from public.attachment_events attachment
        join target
          on attachment.created_by = target.id
        where attachment.workspace_id not in (
          select id from owned_workspaces
        )
      ) as attachment_events_in_non_owned_workspaces,

      (
        select count(*)::int
        from public.user_notes note
        join target
          on note.created_by = target.id
        where note.workspace_id not in (
          select id from owned_workspaces
        )
      ) as notes_in_non_owned_workspaces,

      (
        select count(*)::int
        from public.bookmarks bookmark
        join target
          on bookmark.created_by = target.id
        where bookmark.workspace_id not in (
          select id from owned_workspaces
        )
      ) as bookmarks_in_non_owned_workspaces,

      (
        select count(*)::int
        from public.timeline_events event_record
        join target
          on event_record.created_by = target.id
        where event_record.workspace_id not in (
          select id from owned_workspaces
        )
      ) as timeline_events_in_non_owned_workspaces,

      (
        (
          select count(*)::int
          from public.projects project
          join target on true
          where project.workspace_id in (select id from owned_workspaces)
            and project.created_by <> target.id
        ) +
        (
          select count(*)::int
          from public.sessions session_record
          join target on true
          where session_record.workspace_id in (select id from owned_workspaces)
            and session_record.created_by <> target.id
        ) +
        (
          select count(*)::int
          from public.media_assets media
          join target on true
          where media.workspace_id in (select id from owned_workspaces)
            and media.added_by <> target.id
        ) +
        (
          select count(*)::int
          from public.attachment_events attachment
          join target on true
          where attachment.workspace_id in (select id from owned_workspaces)
            and attachment.created_by <> target.id
        ) +
        (
          select count(*)::int
          from public.user_notes note
          join target on true
          where note.workspace_id in (select id from owned_workspaces)
            and note.created_by <> target.id
        ) +
        (
          select count(*)::int
          from public.bookmarks bookmark
          join target on true
          where bookmark.workspace_id in (select id from owned_workspaces)
            and bookmark.created_by <> target.id
        ) +
        (
          select count(*)::int
          from public.timeline_events event_record
          join target on true
          where event_record.workspace_id in (select id from owned_workspaces)
            and event_record.created_by <> target.id
        )
      ) as owned_workspace_content_by_other_users,

      (
        select count(*)::int
        from storage.objects storage_object
        join target
          on storage_object.owner_id::text = target.id::text
        where storage_object.bucket_id = ${SESSION_ASSETS_BUCKET}
          and exists (
            select 1
            from public.workspaces existing_workspace
            where existing_workspace.id::text =
                  split_part(storage_object.name, '/', 1)
              and existing_workspace.owner_user_id <> target.id
          )
      ) as user_owned_storage_objects_in_non_owned_workspaces,

      (
        select count(*)::int
        from storage.objects storage_object
        join target
          on storage_object.owner_id::text = target.id::text
        where storage_object.bucket_id <> ${SESSION_ASSETS_BUCKET}
      ) as user_owned_storage_objects_outside_supported_bucket,

      (
        select count(*)::int
        from storage.objects storage_object
        join target on true
        where storage_object.bucket_id = ${SESSION_ASSETS_BUCKET}
          and split_part(storage_object.name, '/', 1) in (
            select id::text from owned_workspaces
          )
          and storage_object.owner_id is not null
          and storage_object.owner_id::text <> target.id::text
      ) as storage_objects_in_owned_workspaces_owned_by_other_users,

      (
        select count(*)::int
        from storage.objects storage_object
        where storage_object.bucket_id = ${SESSION_ASSETS_BUCKET}
          and split_part(storage_object.name, '/', 1) in (
            select id::text from owned_workspaces
          )
          and storage_object.owner_id is null
      ) as storage_objects_in_owned_workspaces_without_owner,

      (
        select count(*)::int
        from storage.objects storage_object
        join target
          on storage_object.owner_id::text = target.id::text
        where storage_object.bucket_id = ${SESSION_ASSETS_BUCKET}
          and (
            split_part(storage_object.name, '/', 1) in (
              select id::text from owned_workspaces
            )
            or not exists (
              select 1
              from public.workspaces existing_workspace
              where existing_workspace.id::text =
                    split_part(storage_object.name, '/', 1)
            )
          )
      ) as storage_object_count_in_deletion_scope
  `;

  if (!row) {
    throw new DeleteAccountDomainError(
      "ACCOUNT_DELETION_DATABASE_FAILED",
      "Account deletion could not be prepared. Try again later.",
      { status: 500, retryable: true },
    );
  }

  return {
    userExists: row.user_exists,
    ownedWorkspaceIds: row.owned_workspace_ids ?? [],
    ownedWorkspaceCount: row.owned_workspace_count,
    ownedWorkspacesWithOtherMembers:
      row.owned_workspaces_with_other_members,
    membershipsInNonOwnedWorkspaces:
      row.memberships_in_non_owned_workspaces,
    projectsCreatedInNonOwnedWorkspaces:
      row.projects_created_in_non_owned_workspaces,
    sessionsCreatedInNonOwnedWorkspaces:
      row.sessions_created_in_non_owned_workspaces,
    mediaCreatedInNonOwnedWorkspaces:
      row.media_created_in_non_owned_workspaces,
    attachmentEventsInNonOwnedWorkspaces:
      row.attachment_events_in_non_owned_workspaces,
    notesInNonOwnedWorkspaces:
      row.notes_in_non_owned_workspaces,
    bookmarksInNonOwnedWorkspaces:
      row.bookmarks_in_non_owned_workspaces,
    timelineEventsInNonOwnedWorkspaces:
      row.timeline_events_in_non_owned_workspaces,
    ownedWorkspaceContentByOtherUsers:
      row.owned_workspace_content_by_other_users,
    userOwnedStorageObjectsInNonOwnedWorkspaces:
      row.user_owned_storage_objects_in_non_owned_workspaces,
    userOwnedStorageObjectsOutsideSupportedBucket:
      row.user_owned_storage_objects_outside_supported_bucket,
    storageObjectsInOwnedWorkspacesOwnedByOtherUsers:
      row.storage_objects_in_owned_workspaces_owned_by_other_users,
    storageObjectsInOwnedWorkspacesWithoutOwner:
      row.storage_objects_in_owned_workspaces_without_owner,
    storageObjectCountInDeletionScope:
      row.storage_object_count_in_deletion_scope,
  };
};

const sameStringSet = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  const leftSorted = [...new Set(left)].sort();
  const rightSorted = [...new Set(right)].sort();
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
};

export const createDeleteAccountDatabase = (databaseUrl: string) => {
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 10,
    max_lifetime: 60,
  });

  const dependencies = (
    input: Pick<
      DeleteAccountDependencies,
      "removeStoragePaths" | "deleteAuthUser"
    >,
  ): DeleteAccountDependencies => ({
    loadPreflight: (userId) => loadPreflightWithSql(sql, userId),

    listDeletionStoragePaths: async (userId, workspaceIds, maxRows) => {
      const rows = workspaceIds.length > 0
        ? await sql<{ name: string }[]>`
            select storage_object.name
            from storage.objects storage_object
            where storage_object.bucket_id = ${SESSION_ASSETS_BUCKET}
              and storage_object.owner_id::text = ${userId}
              and (
                split_part(storage_object.name, '/', 1)
                  in ${sql([...workspaceIds])}
                or not exists (
                  select 1
                  from public.workspaces existing_workspace
                  where existing_workspace.id::text =
                        split_part(storage_object.name, '/', 1)
                )
              )
            order by storage_object.name asc
            limit ${maxRows}
          `
        : await sql<{ name: string }[]>`
            select storage_object.name
            from storage.objects storage_object
            where storage_object.bucket_id = ${SESSION_ASSETS_BUCKET}
              and storage_object.owner_id::text = ${userId}
              and not exists (
                select 1
                from public.workspaces existing_workspace
                where existing_workspace.id::text =
                      split_part(storage_object.name, '/', 1)
              )
            order by storage_object.name asc
            limit ${maxRows}
          `;
      return rows.map((row: { name: string }) => row.name);
    },

    removeStoragePaths: input.removeStoragePaths,

    countDeletionStorageObjects: async (userId, workspaceIds) => {
      const rows = workspaceIds.length > 0
        ? await sql<{ row_count: number }[]>`
            select count(*)::int as row_count
            from storage.objects storage_object
            where storage_object.bucket_id = ${SESSION_ASSETS_BUCKET}
              and storage_object.owner_id::text = ${userId}
              and (
                split_part(storage_object.name, '/', 1)
                  in ${sql([...workspaceIds])}
                or not exists (
                  select 1
                  from public.workspaces existing_workspace
                  where existing_workspace.id::text =
                        split_part(storage_object.name, '/', 1)
                )
              )
          `
        : await sql<{ row_count: number }[]>`
            select count(*)::int as row_count
            from storage.objects storage_object
            where storage_object.bucket_id = ${SESSION_ASSETS_BUCKET}
              and storage_object.owner_id::text = ${userId}
              and not exists (
                select 1
                from public.workspaces existing_workspace
                where existing_workspace.id::text =
                      split_part(storage_object.name, '/', 1)
              )
          `;
      return rows[0]?.row_count ?? 0;
    },

    deleteOwnedWorkspacesIfStillSafe: async ({
      userId,
      expectedWorkspaceIds,
    }) =>
      sql.begin(async (transaction: unknown) => {
        const transactionSql = transaction as unknown as SqlClient;

        // Prevent new child rows from being attached to an owned workspace
        // between the final preflight and the cascading workspace delete.
        // Foreign-key inserts require a key-share lock on the parent row,
        // which conflicts with this row-level FOR UPDATE lock.
        await transactionSql`
          select workspace.id
          from public.workspaces workspace
          where workspace.owner_user_id = ${userId}::uuid
          order by workspace.id
          for update
        `;

        const currentPreflight = await loadPreflightWithSql(
          transactionSql,
          userId,
        );
        const blockers = getDeleteAccountBlockers(currentPreflight);

        if (
          blockers.length > 0 ||
          !sameStringSet(
            currentPreflight.ownedWorkspaceIds,
            expectedWorkspaceIds,
          )
        ) {
          throw new DeleteAccountDomainError(
            "ACCOUNT_DELETION_BLOCKED",
            "Account ownership changed while deletion was being prepared.",
            { status: 409, blockers },
          );
        }

        const rows = await transactionSql<{ id: string }[]>`
          delete from public.workspaces workspace
          where workspace.owner_user_id = ${userId}::uuid
          returning workspace.id::text as id
        `;
        return rows.map((row: { id: string }) => row.id);
      }),

    countRemainingBlockingReferences: async (userId) => {
      const [row] = await sql<{ row_count: number }[]>`
        select (
          (select count(*) from public.projects where created_by = ${userId}::uuid) +
          (select count(*) from public.sessions where created_by = ${userId}::uuid) +
          (select count(*) from public.media_assets where added_by = ${userId}::uuid) +
          (select count(*) from public.attachment_events where created_by = ${userId}::uuid) +
          (select count(*) from public.user_notes where created_by = ${userId}::uuid) +
          (select count(*) from public.bookmarks where created_by = ${userId}::uuid) +
          (select count(*) from public.timeline_events where created_by = ${userId}::uuid)
        )::int as row_count
      `;
      return row?.row_count ?? 0;
    },

    deleteAuthUser: input.deleteAuthUser,
  });

  return {
    dependencies,
    close: () => sql.end({ timeout: 5 }),
  };
};
