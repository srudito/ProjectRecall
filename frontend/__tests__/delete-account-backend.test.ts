import {
  createSingleFlight,
  DeleteAccountDomainError,
  decodeGatewayVerifiedClaims,
  executeDeleteAccount,
  getDeleteAccountBlockers,
  resolveAdminApiKey,
  type DeleteAccountDependencies,
  type DeleteAccountPreflight,
  type VerifiedUserClaims,
} from "../../supabase/functions/delete-account/core";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-02T08:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const claims = (
  overrides: Partial<VerifiedUserClaims> = {},
): VerifiedUserClaims => ({
  sub: USER_ID,
  exp: NOW_SECONDS + 3600,
  role: "authenticated",
  amr: [{ method: "password", timestamp: NOW_SECONDS - 30 }],
  ...overrides,
});

const preflight = (
  overrides: Partial<DeleteAccountPreflight> = {},
): DeleteAccountPreflight => ({
  userExists: true,
  ownedWorkspaceIds: [WORKSPACE_ID],
  ownedWorkspaceCount: 1,
  ownedWorkspacesWithOtherMembers: 0,
  membershipsInNonOwnedWorkspaces: 0,
  projectsCreatedInNonOwnedWorkspaces: 0,
  sessionsCreatedInNonOwnedWorkspaces: 0,
  mediaCreatedInNonOwnedWorkspaces: 0,
  attachmentEventsInNonOwnedWorkspaces: 0,
  notesInNonOwnedWorkspaces: 0,
  bookmarksInNonOwnedWorkspaces: 0,
  timelineEventsInNonOwnedWorkspaces: 0,
  ownedWorkspaceContentByOtherUsers: 0,
  userOwnedStorageObjectsInNonOwnedWorkspaces: 0,
  userOwnedStorageObjectsOutsideSupportedBucket: 0,
  storageObjectsInOwnedWorkspacesOwnedByOtherUsers: 0,
  storageObjectsInOwnedWorkspacesWithoutOwner: 0,
  storageObjectCountInDeletionScope: 2,
  ...overrides,
});

const attempt = (
  preflightOverrides: Partial<DeleteAccountPreflight> = {},
  workspaceIds?: string[],
) => {
  const value = preflight(preflightOverrides);
  return {
    preflight: value,
    workspaceIds: workspaceIds ?? value.ownedWorkspaceIds,
  };
};

const dependencies = (
  overrides: Partial<DeleteAccountDependencies> = {},
): DeleteAccountDependencies => ({
  beginDeletionAttempt: jest.fn(async () => attempt()),
  heartbeatDeletionAttempt: jest.fn(async () => undefined),
  markDeletionAttemptFailed: jest.fn(async () => undefined),
  listDeletionStoragePaths: jest.fn(async () => [
    `${WORKSPACE_ID}/session-a/asset-a/file-a.m4a`,
    `${WORKSPACE_ID}/session-a/asset-b/file-b.jpg`,
  ]),
  removeStoragePaths: jest.fn(async () => undefined),
  countDeletionStorageObjects: jest
    .fn()
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0),
  deleteOwnedWorkspacesIfStillSafe: jest.fn(async () => [WORKSPACE_ID]),
  countRemainingBlockingReferences: jest.fn(async () => 0),
  deleteAuthUser: jest.fn(async () => "deleted"),
  ...overrides,
});

const encodeJwt = (payload: Record<string, unknown>): string => {
  const encode = (value: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(value), "utf8")
      .toString("base64url")
      .replace(/=/g, "");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.signature`;
};

describe("delete-account backend core", () => {
  it("decodes gateway-verified claims without exposing unrelated JWT fields", () => {
    const decoded = decodeGatewayVerifiedClaims(
      encodeJwt({
        sub: USER_ID,
        exp: NOW_SECONDS + 3600,
        role: "authenticated",
        amr: [
          { method: "password", timestamp: NOW_SECONDS - 10 },
          { method: "token_refresh", timestamp: NOW_SECONDS },
        ],
        access_token: "must-not-cross",
        user_metadata: { display_name: "Pengguna Uji" },
      }),
    );

    expect(decoded).toEqual({
      sub: USER_ID,
      exp: NOW_SECONDS + 3600,
      role: "authenticated",
      amr: [
        { method: "password", timestamp: NOW_SECONDS - 10 },
        { method: "token_refresh", timestamp: NOW_SECONDS },
      ],
    });
    expect(Object.keys(decoded).sort()).toEqual(["amr", "exp", "role", "sub"]);
  });

  it("selects only the named server-side secret key and safely falls back", () => {
    expect(
      resolveAdminApiKey({
        secretKeysJson: JSON.stringify({
          default: "  sb_secret_server_only  ",
          unrelated: "must-not-be-selected",
        }),
        legacyServiceRoleKey: "legacy-key",
      }),
    ).toBe("sb_secret_server_only");

    expect(
      resolveAdminApiKey({
        secretKeysJson: "not-json",
        legacyServiceRoleKey: "  legacy-key  ",
      }),
    ).toBe("legacy-key");

    expect(resolveAdminApiKey({})).toBeNull();
  });

  it("requires the exact destructive confirmation phrase", async () => {
    await expect(
      executeDeleteAccount(
        {
          userId: USER_ID,
          requestId: REQUEST_ID,
          claims: claims(),
          confirmation: "delete",
          now: NOW,
        },
        dependencies(),
      ),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_CONFIRMATION_REQUIRED",
      status: 400,
    });
  });

  it("requires a recent interactive authentication instead of token refresh time", async () => {
    await expect(
      executeDeleteAccount(
        {
          userId: USER_ID,
          requestId: REQUEST_ID,
          claims: claims({
            amr: [
              { method: "password", timestamp: NOW_SECONDS - 3600 },
              { method: "token_refresh", timestamp: NOW_SECONDS - 5 },
            ],
          }),
          confirmation: "DELETE",
          now: NOW,
        },
        dependencies(),
      ),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_REAUTHENTICATION_REQUIRED",
      status: 403,
    });
  });

  it("blocks collaboration, cross-workspace, and unsafe Storage ownership", () => {
    expect(
      getDeleteAccountBlockers(
        preflight({
          ownedWorkspacesWithOtherMembers: 1,
          membershipsInNonOwnedWorkspaces: 1,
          notesInNonOwnedWorkspaces: 1,
          ownedWorkspaceContentByOtherUsers: 1,
          userOwnedStorageObjectsInNonOwnedWorkspaces: 1,
          userOwnedStorageObjectsOutsideSupportedBucket: 1,
          storageObjectsInOwnedWorkspacesOwnedByOtherUsers: 1,
          storageObjectsInOwnedWorkspacesWithoutOwner: 1,
        }),
      ),
    ).toEqual([
      "OWNED_WORKSPACE_HAS_OTHER_MEMBERS",
      "NON_OWNED_WORKSPACE_MEMBERSHIP",
      "CROSS_WORKSPACE_CONTENT",
      "OWNED_WORKSPACE_CONTENT_BY_OTHER_USERS",
      "USER_STORAGE_IN_NON_OWNED_WORKSPACES",
      "USER_STORAGE_OUTSIDE_SUPPORTED_BUCKET",
      "OTHER_USER_STORAGE_INSIDE_OWNED_WORKSPACES",
      "UNOWNED_STORAGE_INSIDE_OWNED_WORKSPACES",
    ]);
  });

  it("blocks user-owned files in unsupported Storage buckets before deletion", async () => {
    const removeStoragePaths = jest.fn<
      Promise<void>,
      [readonly string[]]
    >(async (_paths) => undefined);
    const deps = dependencies({
      beginDeletionAttempt: jest.fn(async () =>
        attempt({ userOwnedStorageObjectsOutsideSupportedBucket: 1 }),
      ),
      removeStoragePaths,
    });

    await expect(
      executeDeleteAccount(
        {
          userId: USER_ID,
          requestId: REQUEST_ID,
          claims: claims(),
          confirmation: "DELETE",
          now: NOW,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_BLOCKED",
      blockers: ["USER_STORAGE_OUTSIDE_SUPPORTED_BUCKET"],
    });
    expect(removeStoragePaths).not.toHaveBeenCalled();
  });

  it("does not touch Storage when preflight blockers exist", async () => {
    const removeStoragePaths = jest.fn<
      Promise<void>,
      [readonly string[]]
    >(async (_paths) => undefined);
    const deps = dependencies({
      beginDeletionAttempt: jest.fn(async () =>
        attempt({ membershipsInNonOwnedWorkspaces: 1 }),
      ),
      removeStoragePaths,
    });

    await expect(
      executeDeleteAccount(
        {
          userId: USER_ID,
          requestId: REQUEST_ID,
          claims: claims(),
          confirmation: "DELETE",
          now: NOW,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_BLOCKED",
      status: 409,
    });
    expect(removeStoragePaths).not.toHaveBeenCalled();
  });

  it("rejects unsafe Storage paths before calling the Storage API", async () => {
    const removeStoragePaths = jest.fn<
      Promise<void>,
      [readonly string[]]
    >(async (_paths) => undefined);
    const deps = dependencies({
      listDeletionStoragePaths: jest.fn(async () => ["../outside.txt"]),
      removeStoragePaths,
    });

    await expect(
      executeDeleteAccount(
        {
          userId: USER_ID,
          requestId: REQUEST_ID,
          claims: claims(),
          confirmation: "DELETE",
          now: NOW,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_STORAGE_FAILED",
      status: 502,
    });
    expect(removeStoragePaths).not.toHaveBeenCalled();
  });

  it("blocks automatic deletion when the Storage scope exceeds the safety limit", async () => {
    const removeStoragePaths = jest.fn<
      Promise<void>,
      [readonly string[]]
    >(async (_paths) => undefined);
    const deps = dependencies({
      beginDeletionAttempt: jest.fn(async () =>
        attempt({ storageObjectCountInDeletionScope: 11 }),
      ),
      removeStoragePaths,
    });

    await expect(
      executeDeleteAccount(
        {
          userId: USER_ID,
          requestId: REQUEST_ID,
          claims: claims(),
          confirmation: "DELETE",
          now: NOW,
          maxStorageObjects: 10,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_TOO_LARGE",
      status: 409,
    });
    expect(removeStoragePaths).not.toHaveBeenCalled();
  });

  it("deletes Storage before workspaces, closes the upload race, then deletes Auth", async () => {
    const calls: string[] = [];
    const deps = dependencies({
      listDeletionStoragePaths: jest
        .fn()
        .mockImplementationOnce(async () => {
          calls.push("list-initial");
          return [`${WORKSPACE_ID}/session/asset/original.m4a`];
        })
        .mockImplementationOnce(async () => {
          calls.push("list-residual");
          return [`${WORKSPACE_ID}/session/asset/late.jpg`];
        }),
      removeStoragePaths: jest.fn(async (paths: readonly string[]) => {
        calls.push(`remove:${paths[0].split("/").at(-1)}`);
      }),
      countDeletionStorageObjects: jest
        .fn()
        .mockImplementationOnce(async () => {
          calls.push("count-before-workspace");
          return 0;
        })
        .mockImplementationOnce(async () => {
          calls.push("count-after-workspace");
          return 0;
        }),
      deleteOwnedWorkspacesIfStillSafe: jest.fn(async () => {
        calls.push("delete-workspace");
        return [WORKSPACE_ID];
      }),
      countRemainingBlockingReferences: jest.fn(async () => {
        calls.push("count-references");
        return 0;
      }),
      deleteAuthUser: jest.fn(async () => {
        calls.push("delete-auth");
        return "deleted";
      }),
    });

    const result = await executeDeleteAccount(
      {
        userId: USER_ID,
        requestId: REQUEST_ID,
        claims: claims(),
        confirmation: "DELETE",
        now: NOW,
      },
      deps,
    );

    expect(result).toEqual({
      status: "deleted",
      deletedWorkspaceCount: 1,
      deletedStorageObjectCount: 2,
    });
    expect(calls).toEqual([
      "list-initial",
      "remove:original.m4a",
      "count-before-workspace",
      "delete-workspace",
      "list-residual",
      "remove:late.jpg",
      "count-after-workspace",
      "count-references",
      "delete-auth",
    ]);
  });

  it("removes Storage through API-safe batches of 1000", async () => {
    const paths = Array.from(
      { length: 1001 },
      (_, index) => `${WORKSPACE_ID}/session/asset/file-${index}.txt`,
    );
    const removeStoragePaths = jest.fn<
      Promise<void>,
      [readonly string[]]
    >(async (_paths) => undefined);
    const deps = dependencies({
      beginDeletionAttempt: jest.fn(async () =>
        attempt({ storageObjectCountInDeletionScope: paths.length }),
      ),
      listDeletionStoragePaths: jest
        .fn()
        .mockResolvedValueOnce(paths)
        .mockResolvedValueOnce([]),
      removeStoragePaths,
    });

    await executeDeleteAccount(
      {
        userId: USER_ID,
        requestId: REQUEST_ID,
        claims: claims(),
        confirmation: "DELETE",
        now: NOW,
      },
      deps,
    );

    expect(removeStoragePaths).toHaveBeenCalledTimes(2);
    expect(removeStoragePaths.mock.calls[0][0]).toHaveLength(1000);
    expect(removeStoragePaths.mock.calls[1][0]).toHaveLength(1);
  });

  it("does not delete the Auth user when references remain after workspace cleanup", async () => {
    const deleteAuthUser = jest.fn(async () => "deleted" as const);
    const deps = dependencies({
      countRemainingBlockingReferences: jest.fn(async () => 1),
      deleteAuthUser,
    });

    await expect(
      executeDeleteAccount(
        {
          userId: USER_ID,
          requestId: REQUEST_ID,
          claims: claims(),
          confirmation: "DELETE",
          now: NOW,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_BLOCKED",
      status: 409,
    });
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });

  it("retries residual user-owned orphan Storage after workspace deletion", async () => {
    const orphanPath = `${WORKSPACE_ID}/session/asset/residual.m4a`;
    const removeStoragePaths = jest.fn<
      Promise<void>,
      [readonly string[]]
    >(async (_paths) => undefined);
    const deps = dependencies({
      beginDeletionAttempt: jest.fn(async () =>
        attempt(
          {
            ownedWorkspaceIds: [],
            ownedWorkspaceCount: 0,
            storageObjectCountInDeletionScope: 1,
          },
          [WORKSPACE_ID],
        ),
      ),
      listDeletionStoragePaths: jest
        .fn()
        .mockResolvedValueOnce([orphanPath])
        .mockResolvedValueOnce([]),
      removeStoragePaths,
      countDeletionStorageObjects: jest.fn(async () => 0),
      deleteOwnedWorkspacesIfStillSafe: jest.fn(async () => []),
      deleteAuthUser: jest.fn(async () => "deleted"),
    });

    await expect(
      executeDeleteAccount(
        {
          userId: USER_ID,
          requestId: REQUEST_ID,
          claims: claims(),
          confirmation: "DELETE",
          now: NOW,
        },
        deps,
      ),
    ).resolves.toEqual({
      status: "deleted",
      deletedWorkspaceCount: 0,
      deletedStorageObjectCount: 1,
    });
    expect(removeStoragePaths).toHaveBeenCalledWith([orphanPath]);
  });

  it("counts a path only once when it is observed before and after workspace deletion", async () => {
    const path = `${WORKSPACE_ID}/session/asset/repeated.m4a`;
    const deps = dependencies({
      listDeletionStoragePaths: jest
        .fn()
        .mockResolvedValueOnce([path])
        .mockResolvedValueOnce([path]),
      countDeletionStorageObjects: jest.fn(async () => 0),
    });

    await expect(
      executeDeleteAccount(
        {
          userId: USER_ID,
          requestId: REQUEST_ID,
          claims: claims(),
          confirmation: "DELETE",
          now: NOW,
        },
        deps,
      ),
    ).resolves.toMatchObject({ deletedStorageObjectCount: 1 });
  });

  it("supports retry after workspace cleanup and treats missing Auth user as deleted", async () => {
    const deps = dependencies({
      beginDeletionAttempt: jest.fn(async () =>
        attempt(
          {
            ownedWorkspaceIds: [],
            ownedWorkspaceCount: 0,
            storageObjectCountInDeletionScope: 0,
          },
          [WORKSPACE_ID],
        ),
      ),
      listDeletionStoragePaths: jest.fn(async () => []),
      countDeletionStorageObjects: jest.fn(async () => 0),
      deleteOwnedWorkspacesIfStillSafe: jest.fn(async () => []),
      deleteAuthUser: jest.fn(async () => "not_found"),
    });

    await expect(
      executeDeleteAccount(
        {
          userId: USER_ID,
          requestId: REQUEST_ID,
          claims: claims(),
          confirmation: "DELETE",
          now: NOW,
        },
        deps,
      ),
    ).resolves.toEqual({
      status: "already_deleted",
      deletedWorkspaceCount: 0,
      deletedStorageObjectCount: 0,
    });
  });

  it("returns already_deleted before destructive dependencies when the Auth row is absent", async () => {
    const removeStoragePaths = jest.fn<
      Promise<void>,
      [readonly string[]]
    >(async (_paths) => undefined);
    const deleteAuthUser = jest.fn(async () => "deleted" as const);
    const deps = dependencies({
      beginDeletionAttempt: jest.fn(async () =>
        attempt({ userExists: false, ownedWorkspaceIds: [] }, []),
      ),
      removeStoragePaths,
      deleteAuthUser,
    });

    await expect(
      executeDeleteAccount(
        {
          userId: USER_ID,
          requestId: REQUEST_ID,
          claims: claims(),
          confirmation: "DELETE",
          now: NOW,
        },
        deps,
      ),
    ).resolves.toEqual({
      status: "already_deleted",
      deletedWorkspaceCount: 0,
      deletedStorageObjectCount: 0,
    });
    expect(removeStoragePaths).not.toHaveBeenCalled();
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });


  it("keeps a durable gate active when a destructive step fails", async () => {
    const markDeletionAttemptFailed = jest.fn(async () => undefined);
    const deps = dependencies({
      removeStoragePaths: jest.fn(async () => {
        throw new DeleteAccountDomainError(
          "ACCOUNT_DELETION_STORAGE_FAILED",
          "safe failure",
          { status: 502, retryable: true },
        );
      }),
      markDeletionAttemptFailed,
    });

    await expect(
      executeDeleteAccount(
        {
          userId: USER_ID,
          requestId: REQUEST_ID,
          claims: claims(),
          confirmation: "DELETE",
          now: NOW,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_STORAGE_FAILED",
      retryable: true,
    });

    expect(markDeletionAttemptFailed).toHaveBeenCalledWith({
      userId: USER_ID,
      requestId: REQUEST_ID,
      errorCode: "ACCOUNT_DELETION_STORAGE_FAILED",
    });
  });

  it("does not start Storage cleanup when another distributed lease is active", async () => {
    const removeStoragePaths = jest.fn(async () => undefined);
    const markDeletionAttemptFailed = jest.fn(async () => undefined);
    const deps = dependencies({
      beginDeletionAttempt: jest.fn(async () => {
        throw new DeleteAccountDomainError(
          "ACCOUNT_DELETION_IN_PROGRESS",
          "safe in-progress response",
          { status: 409, retryable: true },
        );
      }),
      removeStoragePaths,
      markDeletionAttemptFailed,
    });

    await expect(
      executeDeleteAccount(
        {
          userId: USER_ID,
          requestId: REQUEST_ID,
          claims: claims(),
          confirmation: "DELETE",
          now: NOW,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_IN_PROGRESS",
      status: 409,
      retryable: true,
    });

    expect(removeStoragePaths).not.toHaveBeenCalled();
    expect(markDeletionAttemptFailed).not.toHaveBeenCalled();
  });

  it("renews the durable lease before destructive phases", async () => {
    const heartbeatDeletionAttempt = jest.fn(async () => undefined);
    const deleteOwnedWorkspacesIfStillSafe = jest.fn(async () => [
      WORKSPACE_ID,
    ]);
    const deps = dependencies({
      heartbeatDeletionAttempt,
      deleteOwnedWorkspacesIfStillSafe,
    });

    await executeDeleteAccount(
      {
        userId: USER_ID,
        requestId: REQUEST_ID,
        claims: claims(),
        confirmation: "DELETE",
        now: NOW,
      },
      deps,
    );

    expect(heartbeatDeletionAttempt).toHaveBeenCalled();
    expect(heartbeatDeletionAttempt).toHaveBeenCalledWith({
      userId: USER_ID,
      requestId: REQUEST_ID,
      leaseSeconds: 15 * 60,
    });
    expect(deleteOwnedWorkspacesIfStillSafe).toHaveBeenCalledWith({
      userId: USER_ID,
      requestId: REQUEST_ID,
      expectedWorkspaceIds: [WORKSPACE_ID],
      leaseSeconds: 15 * 60,
    });
  });

  it("coalesces concurrent destructive operations by user ID", async () => {
    const runSingleFlight = createSingleFlight<number>();
    let executions = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const operation = async (): Promise<number> => {
      executions += 1;
      await gate;
      return 7;
    };

    const first = runSingleFlight(USER_ID, operation);
    const second = runSingleFlight(USER_ID, operation);
    expect(first).toBe(second);
    expect(executions).toBe(1);

    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);
  });
});
