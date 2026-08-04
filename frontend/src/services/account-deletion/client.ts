import { AppError, ErrorCode, type ErrorCodeKey } from "@/src/domain/errors";
import { getSupabase } from "@/src/services/supabase/client";

export type AccountDeletionBlocker =
  | "OWNED_WORKSPACE_HAS_OTHER_MEMBERS"
  | "NON_OWNED_WORKSPACE_MEMBERSHIP"
  | "CROSS_WORKSPACE_CONTENT"
  | "OWNED_WORKSPACE_CONTENT_BY_OTHER_USERS"
  | "USER_STORAGE_IN_NON_OWNED_WORKSPACES"
  | "USER_STORAGE_OUTSIDE_SUPPORTED_BUCKET"
  | "OTHER_USER_STORAGE_INSIDE_OWNED_WORKSPACES"
  | "UNOWNED_STORAGE_INSIDE_OWNED_WORKSPACES";

export interface DeleteAccountServerResult {
  status: "deleted" | "already_deleted";
  deletedWorkspaceCount: number;
  deletedStorageObjectCount: number;
  requestId: string;
}

const ACCOUNT_DELETION_CODES = new Set<ErrorCodeKey>([
  ErrorCode.ACCOUNT_DELETION_CONFIRMATION_REQUIRED,
  ErrorCode.ACCOUNT_DELETION_REAUTHENTICATION_REQUIRED,
  ErrorCode.ACCOUNT_DELETION_BLOCKED,
  ErrorCode.ACCOUNT_DELETION_TOO_LARGE,
  ErrorCode.ACCOUNT_DELETION_STORAGE_FAILED,
  ErrorCode.ACCOUNT_DELETION_DATABASE_FAILED,
  ErrorCode.ACCOUNT_DELETION_AUTH_FAILED,
  ErrorCode.ACCOUNT_DELETION_INVALID_SESSION,
  ErrorCode.ACCOUNT_DELETION_IN_PROGRESS,
]);

const BLOCKERS = new Set<AccountDeletionBlocker>([
  "OWNED_WORKSPACE_HAS_OTHER_MEMBERS",
  "NON_OWNED_WORKSPACE_MEMBERSHIP",
  "CROSS_WORKSPACE_CONTENT",
  "OWNED_WORKSPACE_CONTENT_BY_OTHER_USERS",
  "USER_STORAGE_IN_NON_OWNED_WORKSPACES",
  "USER_STORAGE_OUTSIDE_SUPPORTED_BUCKET",
  "OTHER_USER_STORAGE_INSIDE_OWNED_WORKSPACES",
  "UNOWNED_STORAGE_INSIDE_OWNED_WORKSPACES",
]);

export class AccountDeletionClientError extends AppError {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly blockers: readonly AccountDeletionBlocker[];
  readonly gateActive: boolean | null;

  constructor(
    code: ErrorCodeKey,
    options: {
      status?: number | null;
      retryable?: boolean;
      blockers?: readonly AccountDeletionBlocker[];
      gateActive?: boolean | null;
    } = {},
  ) {
    super(code, code);
    this.name = "AccountDeletionClientError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.blockers = options.blockers ?? [];
    this.gateActive = options.gateActive ?? null;
  }
}

interface FunctionErrorPayload {
  error?: {
    code?: unknown;
    retryable?: unknown;
    gateActive?: unknown;
    blockers?: unknown;
  };
}

const readFunctionErrorPayload = async (
  error: unknown,
): Promise<{ payload: FunctionErrorPayload | null; status: number | null }> => {
  if (!error || typeof error !== "object") {
    return { payload: null, status: null };
  }

  const context = (error as { context?: unknown }).context;
  if (!context || typeof context !== "object") {
    return { payload: null, status: null };
  }

  const response = context as {
    status?: unknown;
    clone?: () => { json?: () => Promise<unknown> };
    json?: () => Promise<unknown>;
  };
  const status =
    typeof response.status === "number" ? response.status : null;

  try {
    const readable = response.clone?.() ?? response;
    if (typeof readable.json !== "function") {
      return { payload: null, status };
    }
    const value = await readable.json();
    return {
      payload:
        value && typeof value === "object"
          ? (value as FunctionErrorPayload)
          : null,
      status,
    };
  } catch {
    return { payload: null, status };
  }
};

const parseBlockers = (value: unknown): AccountDeletionBlocker[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is AccountDeletionBlocker =>
      typeof item === "string" &&
      BLOCKERS.has(item as AccountDeletionBlocker),
  );
};

const parseGateActive = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

export const isSafeAccountDeletionPreflightBlock = (
  error: AccountDeletionClientError,
): boolean =>
  error.gateActive === false &&
  (error.blockers.length > 0 ||
    error.code === ErrorCode.ACCOUNT_DELETION_TOO_LARGE ||
    error.code === ErrorCode.ACCOUNT_DELETION_CONFIRMATION_REQUIRED);

const parseAccountDeletionCode = (value: unknown): ErrorCodeKey | null => {
  if (typeof value !== "string") return null;
  return ACCOUNT_DELETION_CODES.has(value as ErrorCodeKey)
    ? (value as ErrorCodeKey)
    : null;
};

const isDeleteAccountServerResult = (
  value: unknown,
): value is DeleteAccountServerResult => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DeleteAccountServerResult>;
  return (
    (candidate.status === "deleted" ||
      candidate.status === "already_deleted") &&
    typeof candidate.deletedWorkspaceCount === "number" &&
    Number.isInteger(candidate.deletedWorkspaceCount) &&
    candidate.deletedWorkspaceCount >= 0 &&
    typeof candidate.deletedStorageObjectCount === "number" &&
    Number.isInteger(candidate.deletedStorageObjectCount) &&
    candidate.deletedStorageObjectCount >= 0 &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0
  );
};

export const invokeDeleteAccount = async (
  expectedUserId: string,
): Promise<DeleteAccountServerResult> => {
  const supabase = getSupabase();
  if (!supabase) {
    throw new AccountDeletionClientError(
      ErrorCode.ACCOUNT_DELETION_NETWORK_FAILED,
    );
  }

  const sessionResponse = await supabase.auth.getSession();
  const session = sessionResponse.data.session;
  if (
    sessionResponse.error ||
    !session?.access_token ||
    session.user.id !== expectedUserId
  ) {
    throw new AccountDeletionClientError(
      ErrorCode.ACCOUNT_DELETION_INVALID_SESSION,
      { status: 401 },
    );
  }

  const { data, error } = await supabase.functions.invoke(
    "delete-account",
    {
      body: { confirmation: "DELETE" },
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    },
  );

  if (error) {
    const { payload, status } = await readFunctionErrorPayload(error);
    const code = parseAccountDeletionCode(payload?.error?.code);
    if (code) {
      throw new AccountDeletionClientError(code, {
        status,
        retryable: payload?.error?.retryable === true,
        gateActive: parseGateActive(payload?.error?.gateActive),
        blockers: parseBlockers(payload?.error?.blockers),
      });
    }

    throw new AccountDeletionClientError(
      ErrorCode.ACCOUNT_DELETION_NETWORK_FAILED,
      { status, retryable: true },
    );
  }

  if (!isDeleteAccountServerResult(data)) {
    throw new AccountDeletionClientError(
      ErrorCode.ACCOUNT_DELETION_INVALID_RESPONSE,
      { retryable: true },
    );
  }

  return {
    status: data.status,
    deletedWorkspaceCount: data.deletedWorkspaceCount,
    deletedStorageObjectCount: data.deletedStorageObjectCount,
    requestId: data.requestId,
  };
};

export type CurrentAccountExistence =
  | "exists"
  | "missing"
  | "session_changed"
  | "unknown";

const normalizedAuthErrorCode = (error: unknown): string => {
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.toLowerCase() : "";
};

const normalizedAuthErrorMessage = (error: unknown): string => {
  if (!error || typeof error !== "object") return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message.toLowerCase() : "";
};

export const getCurrentAccountExistence = async (
  expectedUserId: string,
): Promise<CurrentAccountExistence> => {
  const supabase = getSupabase();
  if (!supabase) return "unknown";

  try {
    const { data, error } = await supabase.auth.getUser();
    if (data.user) {
      return data.user.id === expectedUserId
        ? "exists"
        : "session_changed";
    }

    const code = normalizedAuthErrorCode(error);
    const message = normalizedAuthErrorMessage(error);
    if (
      code === "user_not_found" ||
      message.includes("user from sub claim in jwt does not exist") ||
      message.includes("user not found")
    ) {
      return "missing";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
};
