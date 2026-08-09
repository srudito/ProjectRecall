import postgres from "postgres";

import {
  DeleteAccountDomainError,
  getDeleteAccountBlockers,
  MAX_STORAGE_OBJECTS_PER_DELETE,
  type DeleteAccountAttempt,
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
  processing_jobs_created_in_non_owned_workspaces: number;
  transcription_runs_created_in_non_owned_workspaces: number;
  transcript_versions_created_in_non_owned_workspaces: number;
  owned_workspace_content_by_other_users: number;
  user_owned_storage_objects_in_non_owned_workspaces: number;
  user_owned_storage_objects_outside_supported_bucket: number;
  storage_objects_in_owned_workspaces_owned_by_other_users: number;
  storage_objects_in_owned_workspaces_without_owner: number;
  storage_object_count_in_deletion_scope: number;
}

interface DeletionRequestRow {
  request_id: string;
  status: "processing" | "retryable_failed";
  expected_workspace_ids: string[];
  lease_active: boolean;
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
        select count(*)::int
        from public.processing_jobs processing_job
        join target
          on processing_job.created_by = target.id
        where processing_job.workspace_id not in (
          select id from owned_workspaces
        )
      ) as processing_jobs_created_in_non_owned_workspaces,

      (
        select count(*)::int
        from public.transcription_runs transcription_run
        join target
          on transcription_run.created_by = target.id
        where transcription_run.workspace_id not in (
          select id from owned_workspaces
        )
      ) as transcription_runs_created_in_non_owned_workspaces,

      (
        select count(*)::int
        from public.transcript_versions transcript_version
        join target
          on transcript_version.created_by = target.id
        where transcript_version.workspace_id not in (
          select id from owned_workspaces
        )
      ) as transcript_versions_created_in_non_owned_workspaces,

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
        ) +
        (
          select count(*)::int
          from public.processing_jobs processing_job
          join target on true
          where processing_job.workspace_id in (select id from owned_workspaces)
            and processing_job.created_by <> target.id
        ) +
        (
          select count(*)::int
          from public.transcription_runs transcription_run
          join target on true
          where transcription_run.workspace_id in (select id from owned_workspaces)
            and transcription_run.created_by <> target.id
        ) +
        (
          select count(*)::int
          from public.transcript_versions transcript_version
          join target on true
          where transcript_version.workspace_id in (select id from owned_workspaces)
            and transcript_version.created_by <> target.id
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
    processingJobsCreatedInNonOwnedWorkspaces:
      row.processing_jobs_created_in_non_owned_workspaces,
    transcriptionRunsCreatedInNonOwnedWorkspaces:
      row.transcription_runs_created_in_non_owned_workspaces,
    transcriptVersionsCreatedInNonOwnedWorkspaces:
      row.transcript_versions_created_in_non_owned_workspaces,
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

const containsOnlyExpectedWorkspaces = (
  current: readonly string[],
  expected: readonly string[],
): boolean => {
  const expectedSet = new Set(expected);
  return current.every((workspaceId) => expectedSet.has(workspaceId));
};

const accountDeletionInProgressError = (): DeleteAccountDomainError =>
  new DeleteAccountDomainError(
    "ACCOUNT_DELETION_IN_PROGRESS",
    "Account deletion is already in progress. Try again shortly.",
    { status: 409, retryable: true, gateActive: true },
  );

const acquireExclusiveAccountLock = async (
  sql: SqlClient,
  userId: string,
): Promise<void> => {
  await sql`
    select pg_advisory_xact_lock(
      public.account_deletion_lock_key(${userId}::uuid)
    )
  `;
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
    beginDeletionAttempt: async ({
      userId,
      requestId,
      maxStorageObjects,
      leaseSeconds,
    }): Promise<DeleteAccountAttempt> =>
      sql.begin(async (transaction: unknown) => {
        const transactionSql = transaction as unknown as SqlClient;
        await acquireExclusiveAccountLock(transactionSql, userId);

        const [existingRequest] = await transactionSql<DeletionRequestRow[]>`
          select
            request.request_id::text as request_id,
            request.status,
            request.expected_workspace_ids::text[]
              as expected_workspace_ids,
            coalesce(request.lease_expires_at > now(), false)
              as lease_active
          from public.account_deletion_requests request
          where request.user_id = ${userId}::uuid
          for update
        `;

        if (
          existingRequest?.status === "processing" &&
          existingRequest.lease_active &&
          existingRequest.request_id !== requestId
        ) {
          throw accountDeletionInProgressError();
        }

        const currentPreflight = await loadPreflightWithSql(
          transactionSql,
          userId,
        );

        if (!currentPreflight.userExists) {
          return {
            preflight: currentPreflight,
            workspaceIds: [],
            gateActive: false,
          };
        }

        const blockers = getDeleteAccountBlockers(currentPreflight);
        if (blockers.length > 0) {
          throw new DeleteAccountDomainError(
            "ACCOUNT_DELETION_BLOCKED",
            "This account cannot be deleted automatically while shared workspace data exists.",
            {
              status: 409,
              blockers,
              gateActive: existingRequest !== undefined,
            },
          );
        }

        if (
          currentPreflight.storageObjectCountInDeletionScope >
          (maxStorageObjects ?? MAX_STORAGE_OBJECTS_PER_DELETE)
        ) {
          throw new DeleteAccountDomainError(
            "ACCOUNT_DELETION_TOO_LARGE",
            "This account contains too many files for automatic deletion.",
            {
              status: 409,
              gateActive: existingRequest !== undefined,
            },
          );
        }

        const expectedWorkspaceIds = existingRequest
          ? existingRequest.expected_workspace_ids ?? []
          : currentPreflight.ownedWorkspaceIds;

        if (
          existingRequest &&
          !containsOnlyExpectedWorkspaces(
            currentPreflight.ownedWorkspaceIds,
            expectedWorkspaceIds,
          )
        ) {
          throw new DeleteAccountDomainError(
            "ACCOUNT_DELETION_BLOCKED",
            "Account ownership changed while deletion was being retried.",
            { status: 409, gateActive: true },
          );
        }

        const [requestRow] = await transactionSql<
          { expected_workspace_ids: string[] }[]
        >`
          insert into public.account_deletion_requests (
            user_id,
            request_id,
            status,
            expected_workspace_ids,
            attempt_count,
            started_at,
            last_attempt_at,
            lease_expires_at,
            last_error_code
          ) values (
            ${userId}::uuid,
            ${requestId}::uuid,
            'processing',
            ${expectedWorkspaceIds}::uuid[],
            1,
            now(),
            now(),
            now() + (${leaseSeconds} * interval '1 second'),
            null
          )
          on conflict (user_id) do update set
            request_id = excluded.request_id,
            status = 'processing',
            expected_workspace_ids =
              public.account_deletion_requests.expected_workspace_ids,
            attempt_count =
              public.account_deletion_requests.attempt_count + 1,
            last_attempt_at = now(),
            lease_expires_at =
              now() + (${leaseSeconds} * interval '1 second'),
            last_error_code = null,
            updated_at = now()
          returning expected_workspace_ids::text[]
            as expected_workspace_ids
        `;

        return {
          preflight: currentPreflight,
          workspaceIds:
            requestRow?.expected_workspace_ids ?? expectedWorkspaceIds,
          gateActive: true,
        };
      }),

    heartbeatDeletionAttempt: async ({
      userId,
      requestId,
      leaseSeconds,
    }) => {
      const rows = await sql<{ user_id: string }[]>`
        update public.account_deletion_requests request
        set
          lease_expires_at =
            now() + (${leaseSeconds} * interval '1 second'),
          updated_at = now()
        where request.user_id = ${userId}::uuid
          and request.request_id = ${requestId}::uuid
          and request.status = 'processing'
          and request.lease_expires_at > now()
        returning request.user_id::text as user_id
      `;

      if (rows.length !== 1) {
        throw accountDeletionInProgressError();
      }
    },

    markDeletionAttemptFailed: async ({
      userId,
      requestId,
      errorCode,
    }) => {
      await sql`
        update public.account_deletion_requests request
        set
          status = 'retryable_failed',
          lease_expires_at = null,
          last_error_code = left(${errorCode}, 120),
          updated_at = now()
        where request.user_id = ${userId}::uuid
          and request.request_id = ${requestId}::uuid
      `;
    },

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
      requestId,
      expectedWorkspaceIds,
      leaseSeconds,
    }) =>
      sql.begin(async (transaction: unknown) => {
        const transactionSql = transaction as unknown as SqlClient;
        await acquireExclusiveAccountLock(transactionSql, userId);

        const [requestRow] = await transactionSql<DeletionRequestRow[]>`
          select
            request.request_id::text as request_id,
            request.status,
            request.expected_workspace_ids::text[]
              as expected_workspace_ids,
            coalesce(request.lease_expires_at > now(), false)
              as lease_active
          from public.account_deletion_requests request
          where request.user_id = ${userId}::uuid
          for update
        `;

        if (
          !requestRow ||
          requestRow.status !== "processing" ||
          requestRow.request_id !== requestId ||
          !requestRow.lease_active ||
          !sameStringSet(
            requestRow.expected_workspace_ids ?? [],
            expectedWorkspaceIds,
          )
        ) {
          throw accountDeletionInProgressError();
        }

        const currentPreflight = await loadPreflightWithSql(
          transactionSql,
          userId,
        );
        const blockers = getDeleteAccountBlockers(currentPreflight);

        if (
          blockers.length > 0 ||
          !containsOnlyExpectedWorkspaces(
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

        if (expectedWorkspaceIds.length > 0) {
          // Transcript versions intentionally survive ordinary provider-run or
          // job deletion through ON DELETE SET NULL. During Delete Account the
          // durable gate is active, so that referential UPDATE would be
          // rejected by guard_account_deletion_write if job/session cascades
          // happen before the session cascade deletes the version. Delete the
          // owned-workspace versions explicitly first; segment rows cascade,
          // and the later workspace delete can then remove jobs/runs without
          // relying on foreign-key trigger ordering.
          await transactionSql`
            delete from public.transcript_versions transcript_version
            where transcript_version.workspace_id in ${transactionSql([
              ...expectedWorkspaceIds,
            ])}
          `;
        }

        const rows = expectedWorkspaceIds.length > 0
          ? await transactionSql<{ id: string }[]>`
              delete from public.workspaces workspace
              where workspace.owner_user_id = ${userId}::uuid
                and workspace.id in ${transactionSql([
                  ...expectedWorkspaceIds,
                ])}
              returning workspace.id::text as id
            `
          : [];

        await transactionSql`
          update public.account_deletion_requests request
          set
            lease_expires_at =
              now() + (${leaseSeconds} * interval '1 second'),
            updated_at = now()
          where request.user_id = ${userId}::uuid
            and request.request_id = ${requestId}::uuid
            and request.status = 'processing'
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
          (select count(*) from public.timeline_events where created_by = ${userId}::uuid) +
          (select count(*) from public.processing_jobs where created_by = ${userId}::uuid) +
          (select count(*) from public.transcription_runs where created_by = ${userId}::uuid) +
          (select count(*) from public.transcript_versions where created_by = ${userId}::uuid)
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
