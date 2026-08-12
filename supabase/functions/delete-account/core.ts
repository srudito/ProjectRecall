export const DELETE_ACCOUNT_CONFIRMATION = "DELETE";
export const RECENT_AUTH_MAX_AGE_SECONDS = 15 * 60;
export const STORAGE_REMOVE_BATCH_SIZE = 1000;
export const MAX_STORAGE_OBJECTS_PER_DELETE = 10_000;
export const DELETE_ACCOUNT_LEASE_SECONDS = 15 * 60;

export type DeleteAccountErrorCode =
  | "ACCOUNT_DELETION_CONFIRMATION_REQUIRED"
  | "ACCOUNT_DELETION_REAUTHENTICATION_REQUIRED"
  | "ACCOUNT_DELETION_BLOCKED"
  | "ACCOUNT_DELETION_TOO_LARGE"
  | "ACCOUNT_DELETION_STORAGE_FAILED"
  | "ACCOUNT_DELETION_DATABASE_FAILED"
  | "ACCOUNT_DELETION_AUTH_FAILED"
  | "ACCOUNT_DELETION_INVALID_SESSION"
  | "ACCOUNT_DELETION_IN_PROGRESS";

export type DeleteAccountBlocker =
  | "OWNED_WORKSPACE_HAS_OTHER_MEMBERS"
  | "NON_OWNED_WORKSPACE_MEMBERSHIP"
  | "CROSS_WORKSPACE_CONTENT"
  | "OWNED_WORKSPACE_CONTENT_BY_OTHER_USERS"
  | "USER_STORAGE_IN_NON_OWNED_WORKSPACES"
  | "USER_STORAGE_OUTSIDE_SUPPORTED_BUCKET"
  | "OTHER_USER_STORAGE_INSIDE_OWNED_WORKSPACES"
  | "UNOWNED_STORAGE_INSIDE_OWNED_WORKSPACES"
  | "TRANSCRIPTION_PROVIDER_SUBMISSION_IN_FLIGHT"
  | "TRANSCRIPTION_PROVIDER_CLEANUP_REQUIRED";

export class DeleteAccountDomainError extends Error {
  readonly code: DeleteAccountErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly blockers: readonly DeleteAccountBlocker[];
  readonly gateActive: boolean;

  constructor(
    code: DeleteAccountErrorCode,
    message: string,
    options: {
      status: number;
      retryable?: boolean;
      blockers?: readonly DeleteAccountBlocker[];
      gateActive?: boolean;
    },
  ) {
    super(message);
    this.name = "DeleteAccountDomainError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.blockers = options.blockers ?? [];
    this.gateActive = options.gateActive ?? false;
  }

  withGateActive(): DeleteAccountDomainError {
    if (this.gateActive) return this;
    return new DeleteAccountDomainError(this.code, this.message, {
      status: this.status,
      retryable: this.retryable,
      blockers: this.blockers,
      gateActive: true,
    });
  }
}

export interface AuthenticationMethodReference {
  method: string;
  timestamp: number;
}

export interface VerifiedUserClaims {
  sub: string;
  exp: number;
  role: string;
  amr: AuthenticationMethodReference[];
}

export interface DeleteAccountPreflight {
  userExists: boolean;
  ownedWorkspaceIds: string[];
  ownedWorkspaceCount: number;
  ownedWorkspacesWithOtherMembers: number;
  membershipsInNonOwnedWorkspaces: number;
  projectsCreatedInNonOwnedWorkspaces: number;
  sessionsCreatedInNonOwnedWorkspaces: number;
  mediaCreatedInNonOwnedWorkspaces: number;
  attachmentEventsInNonOwnedWorkspaces: number;
  notesInNonOwnedWorkspaces: number;
  bookmarksInNonOwnedWorkspaces: number;
  timelineEventsInNonOwnedWorkspaces: number;
  processingJobsCreatedInNonOwnedWorkspaces: number;
  transcriptionRunsCreatedInNonOwnedWorkspaces: number;
  transcriptVersionsCreatedInNonOwnedWorkspaces: number;
  transcriptionProviderSubmissionInFlight: number;
  transcriptionProviderCleanupRequired: number;
  ownedWorkspaceContentByOtherUsers: number;
  userOwnedStorageObjectsInNonOwnedWorkspaces: number;
  userOwnedStorageObjectsOutsideSupportedBucket: number;
  storageObjectsInOwnedWorkspacesOwnedByOtherUsers: number;
  storageObjectsInOwnedWorkspacesWithoutOwner: number;
  storageObjectCountInDeletionScope: number;
}

export type DeleteAuthUserResult = "deleted" | "not_found";

export interface DeleteAccountAttempt {
  preflight: DeleteAccountPreflight;
  workspaceIds: string[];
  gateActive: boolean;
}

export interface DeleteAccountDependencies {
  beginDeletionAttempt: (input: {
    userId: string;
    requestId: string;
    maxStorageObjects: number;
    leaseSeconds: number;
  }) => Promise<DeleteAccountAttempt>;
  heartbeatDeletionAttempt: (input: {
    userId: string;
    requestId: string;
    leaseSeconds: number;
  }) => Promise<void>;
  markDeletionAttemptFailed: (input: {
    userId: string;
    requestId: string;
    errorCode: string;
  }) => Promise<void>;
  listDeletionStoragePaths: (
    userId: string,
    workspaceIds: readonly string[],
    maxRows: number,
  ) => Promise<string[]>;
  removeStoragePaths: (paths: readonly string[]) => Promise<void>;
  countDeletionStorageObjects: (
    userId: string,
    workspaceIds: readonly string[],
  ) => Promise<number>;
  deleteOwnedWorkspacesIfStillSafe: (input: {
    userId: string;
    requestId: string;
    expectedWorkspaceIds: readonly string[];
    leaseSeconds: number;
  }) => Promise<string[]>;
  countRemainingBlockingReferences: (userId: string) => Promise<number>;
  deleteAuthUser: (userId: string) => Promise<DeleteAuthUserResult>;
}

export interface DeleteAccountExecutionInput {
  userId: string;
  requestId: string;
  claims: VerifiedUserClaims;
  confirmation: unknown;
  now: Date;
  maxRecentAuthAgeSeconds?: number;
  maxStorageObjects?: number;
}

export interface DeleteAccountExecutionResult {
  status: "deleted" | "already_deleted";
  deletedWorkspaceCount: number;
  deletedStorageObjectCount: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = globalThis.atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const isAuthenticationMethodReference = (
  value: unknown,
): value is AuthenticationMethodReference => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { method?: unknown; timestamp?: unknown };
  return (
    typeof candidate.method === "string" &&
    Number.isFinite(candidate.timestamp) &&
    typeof candidate.timestamp === "number"
  );
};

/**
 * Decode claims only after the Edge gateway has verified the JWT. This helper
 * does not verify signatures by itself and must never be used with
 * `verify_jwt = false`.
 */
export const decodeGatewayVerifiedClaims = (
  accessToken: string,
): VerifiedUserClaims => {
  const segments = accessToken.split(".");
  if (segments.length !== 3) {
    throw new DeleteAccountDomainError(
      "ACCOUNT_DELETION_INVALID_SESSION",
      "Sign in again before deleting this account.",
      { status: 401 },
    );
  }

  try {
    const parsed = JSON.parse(decodeBase64Url(segments[1])) as {
      sub?: unknown;
      exp?: unknown;
      role?: unknown;
      amr?: unknown;
    };

    if (
      typeof parsed.sub !== "string" ||
      !UUID_PATTERN.test(parsed.sub) ||
      typeof parsed.exp !== "number" ||
      !Number.isFinite(parsed.exp) ||
      parsed.role !== "authenticated"
    ) {
      throw new Error("Invalid required claims");
    }

    const amr = Array.isArray(parsed.amr)
      ? parsed.amr.filter(isAuthenticationMethodReference)
      : [];

    return {
      sub: parsed.sub,
      exp: parsed.exp,
      role: parsed.role,
      amr,
    };
  } catch (error) {
    if (error instanceof DeleteAccountDomainError) throw error;
    throw new DeleteAccountDomainError(
      "ACCOUNT_DELETION_INVALID_SESSION",
      "Sign in again before deleting this account.",
      { status: 401 },
    );
  }
};

export const resolveAdminApiKey = (input: {
  secretKeysJson?: string;
  legacyServiceRoleKey?: string;
}): string | null => {
  if (input.secretKeysJson) {
    try {
      const parsed = JSON.parse(input.secretKeysJson) as { default?: unknown };
      if (typeof parsed.default === "string" && parsed.default.trim()) {
        return parsed.default.trim();
      }
    } catch {
      // Fall back to the legacy key below.
    }
  }

  const legacy = input.legacyServiceRoleKey?.trim();
  return legacy ? legacy : null;
};

export const assertDeleteAccountConfirmation = (confirmation: unknown): void => {
  if (confirmation !== DELETE_ACCOUNT_CONFIRMATION) {
    throw new DeleteAccountDomainError(
      "ACCOUNT_DELETION_CONFIRMATION_REQUIRED",
      "Type DELETE to confirm permanent account deletion.",
      { status: 400 },
    );
  }
};

export const latestInteractiveAuthenticationTimestamp = (
  claims: VerifiedUserClaims,
): number | null => {
  const timestamps = claims.amr
    .filter((entry) => entry.method !== "token_refresh")
    .map((entry) => entry.timestamp)
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0);

  return timestamps.length > 0 ? Math.max(...timestamps) : null;
};

export const assertRecentAuthentication = (input: {
  claims: VerifiedUserClaims;
  now: Date;
  maxAgeSeconds?: number;
}): void => {
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (input.claims.exp <= nowSeconds) {
    throw new DeleteAccountDomainError(
      "ACCOUNT_DELETION_INVALID_SESSION",
      "Sign in again before deleting this account.",
      { status: 401 },
    );
  }

  const authenticatedAt = latestInteractiveAuthenticationTimestamp(input.claims);
  const maxAge = input.maxAgeSeconds ?? RECENT_AUTH_MAX_AGE_SECONDS;

  if (
    authenticatedAt == null ||
    authenticatedAt > nowSeconds + 60 ||
    nowSeconds - authenticatedAt > maxAge
  ) {
    throw new DeleteAccountDomainError(
      "ACCOUNT_DELETION_REAUTHENTICATION_REQUIRED",
      "Sign out and sign in again before deleting this account.",
      { status: 403 },
    );
  }
};

const hasCrossWorkspaceContent = (preflight: DeleteAccountPreflight): boolean =>
  preflight.projectsCreatedInNonOwnedWorkspaces > 0 ||
  preflight.sessionsCreatedInNonOwnedWorkspaces > 0 ||
  preflight.mediaCreatedInNonOwnedWorkspaces > 0 ||
  preflight.attachmentEventsInNonOwnedWorkspaces > 0 ||
  preflight.notesInNonOwnedWorkspaces > 0 ||
  preflight.bookmarksInNonOwnedWorkspaces > 0 ||
  preflight.timelineEventsInNonOwnedWorkspaces > 0 ||
  preflight.processingJobsCreatedInNonOwnedWorkspaces > 0 ||
  preflight.transcriptionRunsCreatedInNonOwnedWorkspaces > 0 ||
  preflight.transcriptVersionsCreatedInNonOwnedWorkspaces > 0;

export const getDeleteAccountBlockers = (
  preflight: DeleteAccountPreflight,
): DeleteAccountBlocker[] => {
  const blockers: DeleteAccountBlocker[] = [];

  if (preflight.ownedWorkspacesWithOtherMembers > 0) {
    blockers.push("OWNED_WORKSPACE_HAS_OTHER_MEMBERS");
  }
  if (preflight.membershipsInNonOwnedWorkspaces > 0) {
    blockers.push("NON_OWNED_WORKSPACE_MEMBERSHIP");
  }
  if (hasCrossWorkspaceContent(preflight)) {
    blockers.push("CROSS_WORKSPACE_CONTENT");
  }
  if (preflight.ownedWorkspaceContentByOtherUsers > 0) {
    blockers.push("OWNED_WORKSPACE_CONTENT_BY_OTHER_USERS");
  }
  if (preflight.userOwnedStorageObjectsInNonOwnedWorkspaces > 0) {
    blockers.push("USER_STORAGE_IN_NON_OWNED_WORKSPACES");
  }
  if (preflight.userOwnedStorageObjectsOutsideSupportedBucket > 0) {
    blockers.push("USER_STORAGE_OUTSIDE_SUPPORTED_BUCKET");
  }
  if (preflight.storageObjectsInOwnedWorkspacesOwnedByOtherUsers > 0) {
    blockers.push("OTHER_USER_STORAGE_INSIDE_OWNED_WORKSPACES");
  }
  if (preflight.storageObjectsInOwnedWorkspacesWithoutOwner > 0) {
    blockers.push("UNOWNED_STORAGE_INSIDE_OWNED_WORKSPACES");
  }
  if (preflight.transcriptionProviderSubmissionInFlight > 0) {
    blockers.push("TRANSCRIPTION_PROVIDER_SUBMISSION_IN_FLIGHT");
  }
  if (preflight.transcriptionProviderCleanupRequired > 0) {
    blockers.push("TRANSCRIPTION_PROVIDER_CLEANUP_REQUIRED");
  }

  return blockers;
};

export const uniqueTrimmedStrings = (
  values: readonly string[],
): string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))];

export const uniqueExactStrings = (values: readonly string[]): string[] =>
  [...new Set(values.filter((value) => value.length > 0))];

export const assertSafeStoragePaths = (paths: readonly string[]): void => {
  for (const path of paths) {
    const segments = path.split("/");
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("\0") ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.includes("\\"),
      )
    ) {
      throw new DeleteAccountDomainError(
        "ACCOUNT_DELETION_STORAGE_FAILED",
        "Account files could not be safely prepared for deletion.",
        { status: 502, retryable: true },
      );
    }
  }
};

export const chunkValues = <T>(
  values: readonly T[],
  batchSize: number,
): T[][] => {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("batchSize must be a positive integer");
  }

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    chunks.push(values.slice(index, index + batchSize));
  }
  return chunks;
};

export const executeDeleteAccount = async (
  input: DeleteAccountExecutionInput,
  dependencies: DeleteAccountDependencies,
): Promise<DeleteAccountExecutionResult> => {
  assertDeleteAccountConfirmation(input.confirmation);
  assertRecentAuthentication({
    claims: input.claims,
    now: input.now,
    maxAgeSeconds: input.maxRecentAuthAgeSeconds,
  });

  if (input.claims.sub !== input.userId) {
    throw new DeleteAccountDomainError(
      "ACCOUNT_DELETION_INVALID_SESSION",
      "Sign in again before deleting this account.",
      { status: 401 },
    );
  }

  const maxStorageObjects =
    input.maxStorageObjects ?? MAX_STORAGE_OBJECTS_PER_DELETE;
  const leaseSeconds = DELETE_ACCOUNT_LEASE_SECONDS;
  let attemptStarted = false;

  const heartbeat = (): Promise<void> =>
    dependencies.heartbeatDeletionAttempt({
      userId: input.userId,
      requestId: input.requestId,
      leaseSeconds,
    });

  try {
    const attempt = await dependencies.beginDeletionAttempt({
      userId: input.userId,
      requestId: input.requestId,
      maxStorageObjects,
      leaseSeconds,
    });
    const preflight = attempt.preflight;
    attemptStarted = attempt.gateActive;

    if (!preflight.userExists) {
      return {
        status: "already_deleted",
        deletedWorkspaceCount: 0,
        deletedStorageObjectCount: 0,
      };
    }

    const blockers = getDeleteAccountBlockers(preflight);
    if (blockers.length > 0) {
      throw new DeleteAccountDomainError(
        "ACCOUNT_DELETION_BLOCKED",
        "This account cannot be deleted automatically while shared workspace data exists.",
        { status: 409, blockers },
      );
    }

    if (preflight.storageObjectCountInDeletionScope > maxStorageObjects) {
      throw new DeleteAccountDomainError(
        "ACCOUNT_DELETION_TOO_LARGE",
        "This account contains too many files for automatic deletion.",
        { status: 409 },
      );
    }

    const workspaceIds = uniqueTrimmedStrings(attempt.workspaceIds);
    await heartbeat();

    const initialPaths = uniqueExactStrings(
      await dependencies.listDeletionStoragePaths(
        input.userId,
        workspaceIds,
        maxStorageObjects + 1,
      ),
    );

    if (initialPaths.length > maxStorageObjects) {
      throw new DeleteAccountDomainError(
        "ACCOUNT_DELETION_TOO_LARGE",
        "This account contains too many files for automatic deletion.",
        { status: 409 },
      );
    }

    assertSafeStoragePaths(initialPaths);
    const deletedStoragePaths = new Set<string>();
    for (const batch of chunkValues(
      initialPaths,
      STORAGE_REMOVE_BATCH_SIZE,
    )) {
      await heartbeat();
      await dependencies.removeStoragePaths(batch);
      batch.forEach((path) => deletedStoragePaths.add(path));
    }

    await heartbeat();
    const storageRemainingBeforeWorkspaceDelete =
      await dependencies.countDeletionStorageObjects(
        input.userId,
        workspaceIds,
      );
    if (storageRemainingBeforeWorkspaceDelete !== 0) {
      throw new DeleteAccountDomainError(
        "ACCOUNT_DELETION_STORAGE_FAILED",
        "Account files could not be removed. Try again later.",
        { status: 502, retryable: true },
      );
    }

    await heartbeat();
    const deletedWorkspaceIds =
      await dependencies.deleteOwnedWorkspacesIfStillSafe({
        userId: input.userId,
        requestId: input.requestId,
        expectedWorkspaceIds: workspaceIds,
        leaseSeconds,
      });

    // Close the in-flight upload race after workspace deletion. The durable
    // account gate blocks authenticated writes while residual objects are
    // discovered and removed.
    await heartbeat();
    const residualPaths = uniqueExactStrings(
      await dependencies.listDeletionStoragePaths(
        input.userId,
        workspaceIds,
        maxStorageObjects + 1,
      ),
    );
    if (residualPaths.length > maxStorageObjects) {
      throw new DeleteAccountDomainError(
        "ACCOUNT_DELETION_TOO_LARGE",
        "This account contains too many residual files for automatic deletion.",
        { status: 409 },
      );
    }
    assertSafeStoragePaths(residualPaths);
    for (const batch of chunkValues(
      residualPaths,
      STORAGE_REMOVE_BATCH_SIZE,
    )) {
      await heartbeat();
      await dependencies.removeStoragePaths(batch);
      batch.forEach((path) => deletedStoragePaths.add(path));
    }

    await heartbeat();
    const storageRemainingAfterWorkspaceDelete =
      await dependencies.countDeletionStorageObjects(
        input.userId,
        workspaceIds,
      );
    if (storageRemainingAfterWorkspaceDelete !== 0) {
      throw new DeleteAccountDomainError(
        "ACCOUNT_DELETION_STORAGE_FAILED",
        "Account files could not be removed. Try again later.",
        { status: 502, retryable: true },
      );
    }

    await heartbeat();
    const remainingReferences =
      await dependencies.countRemainingBlockingReferences(input.userId);
    if (remainingReferences !== 0) {
      throw new DeleteAccountDomainError(
        "ACCOUNT_DELETION_BLOCKED",
        "This account still owns shared data and cannot be deleted automatically.",
        { status: 409 },
      );
    }

    await heartbeat();
    const authDeleteResult = await dependencies.deleteAuthUser(input.userId);

    return {
      status:
        authDeleteResult === "not_found" ? "already_deleted" : "deleted",
      deletedWorkspaceCount: deletedWorkspaceIds.length,
      deletedStorageObjectCount: deletedStoragePaths.size,
    };
  } catch (error) {
    if (!attemptStarted) throw error;

    const errorCode =
      error instanceof DeleteAccountDomainError
        ? error.code
        : "ACCOUNT_DELETION_FAILED";
    await dependencies
      .markDeletionAttemptFailed({
        userId: input.userId,
        requestId: input.requestId,
        errorCode,
      })
      .catch(() => {
        // Preserve the original failure; the durable gate remains active.
      });

    if (error instanceof DeleteAccountDomainError) {
      throw error.withGateActive();
    }

    throw new DeleteAccountDomainError(
      "ACCOUNT_DELETION_DATABASE_FAILED",
      "Account deletion could not be completed. Try again later.",
      { status: 500, retryable: true, gateActive: true },
    );
  }
};

export const createSingleFlight = <T>() => {
  const inFlight = new Map<string, Promise<T>>();

  return (key: string, operation: () => Promise<T>): Promise<T> => {
    const existing = inFlight.get(key);
    if (existing) return existing;

    const running = operation().finally(() => {
      if (inFlight.get(key) === running) {
        inFlight.delete(key);
      }
    });
    inFlight.set(key, running);
    return running;
  };
};
