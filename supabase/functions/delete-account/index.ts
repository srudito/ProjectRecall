import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  assertDeleteAccountConfirmation,
  assertRecentAuthentication,
  createSingleFlight,
  decodeGatewayVerifiedClaims,
  DeleteAccountDomainError,
  executeDeleteAccount,
  resolveAdminApiKey,
  type DeleteAccountExecutionResult,
} from "./core.ts";
import { createDeleteAccountDatabase } from "./database.ts";

const SESSION_ASSETS_BUCKET = "session-assets";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface DeleteAccountRequestBody {
  confirmation?: unknown;
}

interface SafeErrorResponse {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    gateActive: boolean | null;
    blockers?: readonly string[];
    requestId: string;
  };
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

const safeErrorResponse = (
  requestId: string,
  error: DeleteAccountDomainError,
): Response => {
  const body: SafeErrorResponse = {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      gateActive: error.gateActive,
      requestId,
    },
  };
  if (error.blockers.length > 0) {
    body.error.blockers = error.blockers;
  }
  return jsonResponse(body, error.status);
};

const getErrorCode = (error: unknown): string | null => {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
};

const getErrorStatus = (error: unknown): number | null => {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
};

const isNotFoundError = (error: unknown): boolean =>
  getErrorCode(error) === "user_not_found" || getErrorStatus(error) === 404;

const isStorageNotFoundError = (error: unknown): boolean =>
  getErrorCode(error) === "not_found" || getErrorStatus(error) === 404;

const extractBearerToken = (request: Request): string => {
  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match?.[1]) {
    throw new DeleteAccountDomainError(
      "ACCOUNT_DELETION_INVALID_SESSION",
      "Sign in again before deleting this account.",
      { status: 401 },
    );
  }
  return match[1];
};

const readRequestBody = async (
  request: Request,
): Promise<DeleteAccountRequestBody> => {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object") return {};
    return body as DeleteAccountRequestBody;
  } catch {
    return {};
  }
};

const requireEnvironment = (name: string): string => {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new DeleteAccountDomainError(
      "ACCOUNT_DELETION_AUTH_FAILED",
      "Account deletion is temporarily unavailable.",
      { status: 503, retryable: true },
    );
  }
  return value;
};

const getAdminKey = (): string => {
  const key = resolveAdminApiKey({
    secretKeysJson: Deno.env.get("SUPABASE_SECRET_KEYS"),
    legacyServiceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  });
  if (!key) {
    throw new DeleteAccountDomainError(
      "ACCOUNT_DELETION_AUTH_FAILED",
      "Account deletion is temporarily unavailable.",
      { status: 503, retryable: true },
    );
  }
  return key;
};

const createAdminClient = (): SupabaseClient =>
  createClient(requireEnvironment("SUPABASE_URL"), getAdminKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

const removeStoragePaths = async (
  adminClient: SupabaseClient,
  paths: readonly string[],
): Promise<void> => {
  if (paths.length === 0) return;
  const response = await adminClient.storage
    .from(SESSION_ASSETS_BUCKET)
    .remove([...paths]);
  if (response.error && !isStorageNotFoundError(response.error)) {
    throw new DeleteAccountDomainError(
      "ACCOUNT_DELETION_STORAGE_FAILED",
      "Account files could not be removed. Try again later.",
      { status: 502, retryable: true },
    );
  }
};

const deleteAuthUser = async (
  adminClient: SupabaseClient,
  userId: string,
): Promise<"deleted" | "not_found"> => {
  const response = await adminClient.auth.admin.deleteUser(userId, false);
  if (!response.error) return "deleted";
  if (isNotFoundError(response.error)) return "not_found";

  throw new DeleteAccountDomainError(
    "ACCOUNT_DELETION_AUTH_FAILED",
    "The account could not be deleted. Try again later.",
    { status: 502, retryable: true },
  );
};

const singleFlight = createSingleFlight<DeleteAccountExecutionResult>();

Deno.serve(async (request: Request): Promise<Response> => {
  const requestId = crypto.randomUUID();

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse(
      {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Use POST to delete an account.",
          retryable: false,
          gateActive: false,
          requestId,
        },
      },
      405,
    );
  }

  let database: ReturnType<typeof createDeleteAccountDatabase> | null = null;

  try {
    const body = await readRequestBody(request);
    assertDeleteAccountConfirmation(body.confirmation);

    const accessToken = extractBearerToken(request);
    const claims = decodeGatewayVerifiedClaims(accessToken);
    assertRecentAuthentication({ claims, now: new Date() });

    const adminClient = createAdminClient();
    const userResponse = await adminClient.auth.getUser(accessToken);

    if (userResponse.error) {
      if (isNotFoundError(userResponse.error)) {
        return jsonResponse({
          status: "already_deleted",
          deletedWorkspaceCount: 0,
          deletedStorageObjectCount: 0,
          requestId,
        });
      }
      throw new DeleteAccountDomainError(
        "ACCOUNT_DELETION_INVALID_SESSION",
        "Sign in again before deleting this account.",
        { status: 401 },
      );
    }

    const currentUserId = userResponse.data.user?.id;
    if (!currentUserId || currentUserId !== claims.sub) {
      throw new DeleteAccountDomainError(
        "ACCOUNT_DELETION_INVALID_SESSION",
        "Sign in again before deleting this account.",
        { status: 401 },
      );
    }

    database = createDeleteAccountDatabase(
      requireEnvironment("SUPABASE_DB_URL"),
    );
    const dependencies = database.dependencies({
      removeStoragePaths: (paths) => removeStoragePaths(adminClient, paths),
      deleteAuthUser: (userId) => deleteAuthUser(adminClient, userId),
    });

    const result = await singleFlight(currentUserId, () =>
      executeDeleteAccount(
        {
          userId: currentUserId,
          requestId,
          claims,
          confirmation: body.confirmation,
          now: new Date(),
        },
        dependencies,
      ),
    );

    return jsonResponse({ ...result, requestId });
  } catch (error) {
    if (error instanceof DeleteAccountDomainError) {
      return safeErrorResponse(requestId, error);
    }

    // Do not log request bodies, authorization headers, user IDs, or raw
    // provider/database errors. The request ID is enough for correlation.
    console.error("[delete-account] unexpected failure", { requestId });
    return jsonResponse(
      {
        error: {
          code: "ACCOUNT_DELETION_FAILED",
          message: "The account could not be deleted. Try again later.",
          retryable: true,
          gateActive: null,
          requestId,
        },
      },
      500,
    );
  } finally {
    if (database) {
      await database.close().catch(() => {
        // Connection cleanup failure must not replace the operation response.
      });
    }
  }
});
