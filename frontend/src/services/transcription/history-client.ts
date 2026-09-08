import type { SupabaseClient } from "@supabase/supabase-js";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import { getSupabase } from "@/src/services/supabase/client";

import {
  assertHistoryCloudUtf8Budget,
  captureHistoryCloudPage,
  captureHistoryCloudRequest,
  captureHistoryCloudVersion,
  HISTORY_CLOUD_DETAIL_COLUMNS,
  HISTORY_CLOUD_SUMMARY_COLUMNS,
  MAX_HISTORY_CLOUD_CONCURRENT_READS,
  MAX_HISTORY_CLOUD_METADATA_BYTES,
  parseHistoryCloudSummary,
  parseHistoryCloudVersion,
  TRANSCRIPT_HISTORY_CLOUD_SOURCE,
  TranscriptHistoryCloudError,
  type TranscriptHistoryCloudDetail,
  type TranscriptHistoryCloudErrorCode,
  type TranscriptHistoryCloudPage,
  type TranscriptHistoryCloudPageRequest,
  type TranscriptHistoryCloudVersionRequest,
} from "./history-cloud-types";

const activeReads = new WeakMap<SupabaseClient, number>();
type CapturedRequest = ReturnType<typeof captureHistoryCloudRequest>;
type QueryResult = { data: unknown; error: unknown; status: number };
const error = (code: TranscriptHistoryCloudErrorCode) => new TranscriptHistoryCloudError(code);

/** Internal diagnostics are classified but never retained or returned verbatim. */
const normalizeFailure = (failure: unknown, status?: number): TranscriptHistoryCloudError => {
  if (failure instanceof TranscriptHistoryCloudError) return failure;
  const row = failure && typeof failure === "object" ? failure as Record<string, unknown> : {};
  const code = typeof row.code === "string" ? row.code : "";
  if (status === 401 || ["PGRST301", "PGRST302", "PGRST303"].includes(code)) return error("HISTORY_CLOUD_AUTH_REQUIRED");
  if (status === 403 || code === "42501") return error("HISTORY_CLOUD_FORBIDDEN");
  if (code === "57014") return error("HISTORY_CLOUD_TIMEOUT");
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) return error("HISTORY_CLOUD_RETRYABLE_QUERY");
  const message = typeof row.message === "string" ? row.message.slice(0, 2048).toLowerCase() : "";
  if (row.name === "AbortError" || message.startsWith("aborterror:")) return error("HISTORY_CLOUD_CANCELLED");
  if (status === 0 || failure instanceof TypeError ||
      /failed to fetch|fetch failed|network request failed|networkerror|network error/.test(message)) {
    return error("HISTORY_CLOUD_NETWORK_UNAVAILABLE");
  }
  return error("HISTORY_CLOUD_QUERY_FAILED");
};

const assertView = (request: CapturedRequest): void => {
  if (request.signal?.aborted) throw error("HISTORY_CLOUD_CANCELLED");
  if (isAccountDeletionLocallyPending()) throw error("HISTORY_CLOUD_DELETION_PENDING");
  if (request.isContextActive) {
    let active = false;
    try { active = request.isContextActive() === true; } catch { /* Fail closed without retaining the callback error. */ }
    if (!active) throw error("HISTORY_CLOUD_CONTEXT_INACTIVE");
  }
};

/**
 * No queue, retry loop, caching or UI activation. The deadline bounds result
 * delivery even if a transport ignores abort; its late rejection is consumed.
 * getSession is SDK-local auth state, not remote authorization: RLS enforces that.
 */
const read = async <T>(
  request: CapturedRequest,
  clientOverride: SupabaseClient | undefined,
  query: (client: SupabaseClient, signal: AbortSignal) => PromiseLike<QueryResult>,
  parse: (data: unknown) => T,
): Promise<T> => {
  assertView(request);
  const client = clientOverride ?? getSupabase();
  if (!client) throw error("HISTORY_CLOUD_NOT_CONFIGURED");
  const count = activeReads.get(client) ?? 0;
  if (count >= MAX_HISTORY_CLOUD_CONCURRENT_READS) throw error("HISTORY_CLOUD_BUSY");
  activeReads.set(client, count + 1);

  const controller = new AbortController();
  const deadline = Date.now() + request.timeoutMs;
  let finished = false;
  let stopped: TranscriptHistoryCloudError | null = null;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectInterrupted!: (reason: TranscriptHistoryCloudError) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  // An auth implementation may invoke its listener synchronously on subscription.
  void interrupted.catch(() => undefined);
  const stop = (reason: TranscriptHistoryCloudError): void => {
    if (finished || stopped) return;
    stopped = reason;
    rejectInterrupted(reason);
    controller.abort();
  };
  const cancelled = (): void => stop(error("HISTORY_CLOUD_CANCELLED"));
  const guard = (): void => {
    if (stopped) throw stopped;
    if (finished) throw error("HISTORY_CLOUD_CONTEXT_INACTIVE");
    try {
      assertView(request);
      if (Date.now() >= deadline) throw error("HISTORY_CLOUD_TIMEOUT");
    } catch (failure) {
      const normalized = failure instanceof TranscriptHistoryCloudError ? failure : error("HISTORY_CLOUD_CONTEXT_INACTIVE");
      stop(normalized);
      throw normalized;
    }
  };
  const expectedSession = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    const session = value as { access_token?: unknown; user?: { id?: unknown } | null };
    return typeof session.access_token === "string" && session.access_token.length > 0 &&
      typeof session.user?.id === "string" && session.user.id.toLowerCase() === request.scope.userId;
  };
  const requireAuth = async (): Promise<void> => {
    guard();
    const response = await client.auth.getSession();
    guard();
    if (response.error) throw error("HISTORY_CLOUD_AUTH_REQUIRED");
    const session = response.data.session;
    if (!expectedSession(session)) {
      throw error("HISTORY_CLOUD_AUTH_REQUIRED");
    }
  };

  try {
    request.signal?.addEventListener("abort", cancelled);
    timer = setTimeout(() => stop(error("HISTORY_CLOUD_TIMEOUT")), request.timeoutMs);
    const subscription = client.auth.onAuthStateChange((_event, session) => {
      // Synchronous only: never call Supabase/await inside this auth callback.
      // A -> B -> A cannot revive this request once it has been stopped.
      if (!expectedSession(session)) {
        stop(error("HISTORY_CLOUD_AUTH_REQUIRED"));
      }
    }).data.subscription;
    unsubscribe = () => subscription.unsubscribe();
    guard();
    const operation = (async (): Promise<T> => {
      await requireAuth();
      guard();
      const response = await query(client, controller.signal);
      guard();
      if (!response || !Number.isInteger(response.status)) throw error("HISTORY_CLOUD_INVALID_RESPONSE");
      if (response.error || response.status < 200 || response.status >= 300) {
        throw normalizeFailure(response.error, response.status);
      }
      const result = parse(response.data);
      guard();
      await requireAuth();
      guard();
      return result;
    })();
    const result = await Promise.race([operation, interrupted]);
    guard();
    return result;
  } catch (failure) {
    const normalized = stopped ?? normalizeFailure(failure);
    stop(normalized);
    throw normalized;
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    try { request.signal?.removeEventListener("abort", cancelled); } catch { /* No private cleanup error escapes. */ }
    try { unsubscribe?.(); } catch { /* Cleanup failure cannot expose private errors or revive delivery. */ }
    const remaining = (activeReads.get(client) ?? 1) - 1;
    if (remaining === 0) activeReads.delete(client);
    else activeReads.set(client, remaining);
  }
};

/**
 * Metadata-only keyset page. Every nonempty page has a continuation, including
 * a short page. Empty means no further VISIBLE rows in this window at this read,
 * never permission to delete local rows or claim a transaction-wide snapshot.
 */
export const fetchTranscriptHistoryPage = async (
  input: TranscriptHistoryCloudPageRequest,
  clientOverride?: SupabaseClient,
): Promise<TranscriptHistoryCloudPage> => {
  const request = captureHistoryCloudPage(input);
  const { scope, cursor, pageSize } = request;
  return read(request, clientOverride, (client, signal) => {
    let query = client.from("transcript_versions")
      .select(HISTORY_CLOUD_SUMMARY_COLUMNS.join(","))
      .eq("workspace_id", scope.workspaceId).eq("session_id", scope.sessionId)
      .eq("version_status", "final").order("version", { ascending: false }).limit(pageSize);
    if (cursor) query = query.lte("version", cursor.upperVersion).lt("version", cursor.beforeVersion);
    return query.abortSignal(signal);
  }, (data) => {
    if (!Array.isArray(data)) throw error("HISTORY_CLOUD_INVALID_RESPONSE");
    if (data.length > pageSize) throw error("HISTORY_CLOUD_LIMIT_EXCEEDED");
    // Supabase has already decoded JSON. This is an acceptance budget, not a
    // streaming HTTP byte cap (which would require a separate transport design).
    let encoded: string;
    try { encoded = JSON.stringify(data); } catch { throw error("HISTORY_CLOUD_INVALID_RESPONSE"); }
    assertHistoryCloudUtf8Budget(encoded, MAX_HISTORY_CLOUD_METADATA_BYTES);
    const versions = data.map((row: unknown) => parseHistoryCloudSummary(row, scope));
    const ids = new Set<string>();
    let previous = Number.POSITIVE_INFINITY;
    let currentCount = 0;
    for (const version of versions) {
      if (ids.has(version.id) || version.version >= previous ||
          (cursor && (version.version > cursor.upperVersion || version.version >= cursor.beforeVersion))) {
        throw error("HISTORY_CLOUD_INVALID_RESPONSE");
      }
      ids.add(version.id);
      previous = version.version;
      if (version.is_current) currentCount += 1;
    }
    if (currentCount > 1) throw error("HISTORY_CLOUD_INVALID_RESPONSE");
    const windowUpperVersion = cursor?.upperVersion ?? versions[0]?.version ?? null;
    const last = versions.at(-1);
    return {
      source: TRANSCRIPT_HISTORY_CLOUD_SOURCE, scope: { ...scope }, versions, windowUpperVersion,
      visibleWindowExhausted: versions.length === 0,
      nextCursor: last && windowUpperVersion !== null
        ? { source: TRANSCRIPT_HISTORY_CLOUD_SOURCE, scope: { ...scope },
            upperVersion: windowUpperVersion, beforeVersion: last.version } : null,
    };
  });
};

/** Full record only: no segment read, cleanup proof, cache write, or restore. */
export const fetchTranscriptHistoryVersion = async (
  input: TranscriptHistoryCloudVersionRequest,
  clientOverride?: SupabaseClient,
): Promise<TranscriptHistoryCloudDetail> => {
  const request = captureHistoryCloudVersion(input);
  const { scope, versionId, expectedVersion } = request;
  return read(request, clientOverride, (client, signal) => client.from("transcript_versions")
    .select(HISTORY_CLOUD_DETAIL_COLUMNS.join(","))
    .eq("workspace_id", scope.workspaceId).eq("session_id", scope.sessionId)
    .eq("version_status", "final").eq("id", versionId).limit(2).abortSignal(signal), (data) => {
    if (!Array.isArray(data) || data.length > 1) throw error("HISTORY_CLOUD_INVALID_RESPONSE");
    if (data.length === 0) return {
      kind: "not_visible", source: TRANSCRIPT_HISTORY_CLOUD_SOURCE, scope: { ...scope }, versionId,
    };
    const version = parseHistoryCloudVersion(data[0], scope);
    if (version.id !== versionId || (expectedVersion !== undefined && version.version !== expectedVersion)) {
      throw error("HISTORY_CLOUD_INVALID_RESPONSE");
    }
    return {
      kind: "ready", source: TRANSCRIPT_HISTORY_CLOUD_SOURCE, scope: { ...scope },
      completeness: "version_record_only", version,
    };
  });
};
