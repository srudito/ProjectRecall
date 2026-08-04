import AsyncStorage from "@react-native-async-storage/async-storage";

import { AppError, ErrorCode, type ErrorCodeKey } from "@/src/domain/errors";
import { RecordingState, type RecordingState as RecordingStateValue } from "@/src/services/recording/state-machine";

export const ACCOUNT_DELETION_MARKER_KEY =
  "account.deletion.pending.v1";

export type AccountDeletionMarkerStatus =
  | "requested"
  | "in_progress"
  | "retryable_error"
  | "blocked"
  | "reauthentication_required"
  | "server_deleted_local_cleanup_pending"
  | "server_outcome_unverified_local_cleanup_pending"
  | "local_cleanup_complete_server_unverified"
  | "local_cleanup_failed";

export interface AccountDeletionMarker {
  version: 1;
  userId: string;
  workspaceIds: string[];
  status: AccountDeletionMarkerStatus;
  requestedAt: string;
  updatedAt: string;
  serverRequestStartedAt: string | null;
  serverDeletionConfirmedAt: string | null;
  retryCount: number;
  lastErrorCode: string | null;
  blockers: string[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STATUSES = new Set<AccountDeletionMarkerStatus>([
  "requested",
  "in_progress",
  "retryable_error",
  "blocked",
  "reauthentication_required",
  "server_deleted_local_cleanup_pending",
  "server_outcome_unverified_local_cleanup_pending",
  "local_cleanup_complete_server_unverified",
  "local_cleanup_failed",
]);

let currentMarker: AccountDeletionMarker | null = null;

const uniqueUuids = (values: readonly string[]): string[] =>
  [...new Set(values.filter((value) => UUID_PATTERN.test(value)))].sort();

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const parseMarker = (value: unknown): AccountDeletionMarker | null => {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Partial<AccountDeletionMarker>;
  if (
    candidate.version !== 1 ||
    typeof candidate.userId !== "string" ||
    !UUID_PATTERN.test(candidate.userId) ||
    typeof candidate.status !== "string" ||
    !STATUSES.has(candidate.status as AccountDeletionMarkerStatus) ||
    typeof candidate.requestedAt !== "string" ||
    typeof candidate.updatedAt !== "string" ||
    !isStringArray(candidate.workspaceIds) ||
    !isStringArray(candidate.blockers) ||
    typeof candidate.retryCount !== "number" ||
    !Number.isFinite(candidate.retryCount) ||
    candidate.retryCount < 0 ||
    !(
      candidate.serverRequestStartedAt === null ||
      typeof candidate.serverRequestStartedAt === "string"
    ) ||
    !(
      candidate.lastErrorCode === null ||
      typeof candidate.lastErrorCode === "string"
    ) ||
    !(
      candidate.serverDeletionConfirmedAt === undefined ||
      candidate.serverDeletionConfirmedAt === null ||
      typeof candidate.serverDeletionConfirmedAt === "string"
    )
  ) {
    return null;
  }

  return {
    version: 1,
    userId: candidate.userId,
    workspaceIds: uniqueUuids(candidate.workspaceIds),
    status: candidate.status as AccountDeletionMarkerStatus,
    requestedAt: candidate.requestedAt,
    updatedAt: candidate.updatedAt,
    serverRequestStartedAt: candidate.serverRequestStartedAt,
    serverDeletionConfirmedAt:
      candidate.serverDeletionConfirmedAt ?? null,
    retryCount: Math.trunc(candidate.retryCount),
    lastErrorCode: candidate.lastErrorCode,
    blockers: [...new Set(candidate.blockers)].sort(),
  };
};

const markerStorageError = (): AppError =>
  new AppError(
    ErrorCode.ACCOUNT_DELETION_LOCAL_STATE_FAILED,
    "The pending account-deletion state could not be saved locally.",
  );

export const createAccountDeletionMarker = (input: {
  userId: string;
  workspaceIds: readonly string[];
  now?: Date;
}): AccountDeletionMarker => {
  if (!UUID_PATTERN.test(input.userId)) {
    throw markerStorageError();
  }

  const now = (input.now ?? new Date()).toISOString();
  return {
    version: 1,
    userId: input.userId,
    workspaceIds: uniqueUuids(input.workspaceIds),
    status: "requested",
    requestedAt: now,
    updatedAt: now,
    serverRequestStartedAt: null,
    serverDeletionConfirmedAt: null,
    retryCount: 0,
    lastErrorCode: null,
    blockers: [],
  };
};

export const loadAccountDeletionMarker = async (): Promise<
  AccountDeletionMarker | null
> => {
  try {
    const raw = await AsyncStorage.getItem(
      ACCOUNT_DELETION_MARKER_KEY,
    );
    if (raw === null) {
      currentMarker = null;
      return null;
    }

    const parsed = parseMarker(JSON.parse(raw));
    if (!parsed) {
      // Fail closed. A corrupt non-empty marker can represent an interrupted
      // deletion workflow, so never erase it and reveal private routes.
      throw markerStorageError();
    }

    currentMarker = parsed;
    return parsed;
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw markerStorageError();
  }
};

export const saveAccountDeletionMarker = async (
  marker: AccountDeletionMarker,
): Promise<void> => {
  const parsed = parseMarker(marker);
  if (!parsed) throw markerStorageError();

  try {
    await AsyncStorage.setItem(
      ACCOUNT_DELETION_MARKER_KEY,
      JSON.stringify(parsed),
    );
    currentMarker = parsed;
  } catch {
    throw markerStorageError();
  }
};

export const clearAccountDeletionMarker = async (): Promise<void> => {
  try {
    await AsyncStorage.removeItem(ACCOUNT_DELETION_MARKER_KEY);
    currentMarker = null;
  } catch {
    throw markerStorageError();
  }
};

export const getCurrentAccountDeletionMarker = ():
  | AccountDeletionMarker
  | null => currentMarker;

export const isAccountDeletionLocallyPending = (): boolean =>
  currentMarker !== null;

export const updateAccountDeletionMarker = (
  marker: AccountDeletionMarker,
  patch: Partial<
    Pick<
      AccountDeletionMarker,
      | "status"
      | "serverRequestStartedAt"
      | "serverDeletionConfirmedAt"
      | "retryCount"
      | "lastErrorCode"
      | "blockers"
    >
  >,
  now: Date = new Date(),
): AccountDeletionMarker => ({
  ...marker,
  ...patch,
  blockers: patch.blockers
    ? [...new Set(patch.blockers)].sort()
    : marker.blockers,
  updatedAt: now.toISOString(),
});


export const resolveAccountDeletionAuthMismatchStatus = (
  marker: AccountDeletionMarker,
): AccountDeletionMarkerStatus =>
  marker.serverRequestStartedAt
    ? "server_outcome_unverified_local_cleanup_pending"
    : "reauthentication_required";

export const resolveAccountDeletionLocalCleanupErrorCode = (
  marker: AccountDeletionMarker,
  causeCode: ErrorCodeKey | null,
): ErrorCodeKey =>
  marker.serverDeletionConfirmedAt
    ? causeCode ?? ErrorCode.ACCOUNT_DELETION_LOCAL_CLEANUP_FAILED
    : ErrorCode.ACCOUNT_DELETION_LOCAL_CLEANUP_UNVERIFIED_FAILED;


/**
 * Preserve the newest marker that was successfully written before a workflow
 * persistence failure. The React effect closure can still hold the marker from
 * before the server request began, so using it directly could erase
 * `serverRequestStartedAt` on the next retry.
 */
export const resolveAccountDeletionWorkflowFailureMarker = (
  fallbackMarker: AccountDeletionMarker,
): AccountDeletionMarker =>
  updateAccountDeletionMarker(
    getCurrentAccountDeletionMarker() ?? fallbackMarker,
    {
      status: "retryable_error",
      lastErrorCode: ErrorCode.ACCOUNT_DELETION_LOCAL_STATE_FAILED,
    },
  );

export const isRecordingStateSafeForAccountDeletion = (
  state: RecordingStateValue,
): boolean =>
  state === RecordingState.IDLE ||
  state === RecordingState.SAVED ||
  state === RecordingState.FAILED;

export const __resetAccountDeletionStateForTests = (): void => {
  currentMarker = null;
};
