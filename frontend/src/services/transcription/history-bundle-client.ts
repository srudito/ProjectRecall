import type { SupabaseClient } from "@supabase/supabase-js";

import { isAccountDeletionLocallyPending } from "@/src/services/account-deletion/state";
import { getSupabase } from "@/src/services/supabase/client";

import {
  captureHistoryCloudVersion,
  HISTORY_CLOUD_DETAIL_COLUMNS,
  parseHistoryCloudVersion,
  TranscriptHistoryCloudError,
  type TranscriptHistoryCloudErrorCode,
  type TranscriptHistoryCloudVersion,
  type TranscriptHistoryCloudVersionRequest,
} from "./history-cloud-types";
import {
  assertHistoryBundleParent,
  assessHistoryBundleProof,
  HISTORY_BUNDLE_JOB_COLUMNS,
  HISTORY_BUNDLE_RUN_COLUMNS,
  HISTORY_BUNDLE_SEGMENT_COLUMNS,
  HISTORY_BUNDLE_SEGMENT_PAGE_SIZE,
  HISTORY_BUNDLE_SOURCE,
  HISTORY_BUNDLE_TIMEOUT_MS,
  historyBundleByteSize,
  MAX_HISTORY_BUNDLE_BYTES,
  MAX_HISTORY_BUNDLE_CONCURRENT,
  MAX_HISTORY_BUNDLE_REQUESTS,
  normalizeHistoryBundleError,
  parseHistoryBundleJob,
  parseHistoryBundleRun,
  parseHistoryBundleSegment,
  reconcileHistoryBundleVersion,
  TranscriptHistoryBundleError,
  validateTranscriptHistoryBundle,
  type HistoryBundleEligibility,
  type HistoryBundleUnavailableReason,
  type TranscriptHistoryBundleResult,
} from "./history-bundle-types";
import { MAX_TRANSCRIPT_LINEAGE_DEPTH, type SyncedTranscriptSegment } from "./result-types";

const collectors = new WeakMap<SupabaseClient, number>();
type QueryReply = { data: unknown; error: unknown; status: number };
const cloudError = (code: TranscriptHistoryCloudErrorCode) => new TranscriptHistoryCloudError(code);
const invalid = (): never => { throw new TranscriptHistoryBundleError("HISTORY_BUNDLE_INVALID"); };
const failureError = (failure: unknown, status?: number): Error => {
  if (failure instanceof TranscriptHistoryBundleError || failure instanceof TranscriptHistoryCloudError) return failure;
  const row = failure && typeof failure === "object" ? failure as Record<string, unknown> : {};
  const code = typeof row.code === "string" ? row.code : "";
  if (status === 401 || ["PGRST301", "PGRST302", "PGRST303"].includes(code)) return cloudError("HISTORY_CLOUD_AUTH_REQUIRED");
  if (status === 403 || code === "42501") return cloudError("HISTORY_CLOUD_FORBIDDEN");
  if (code === "57014") return cloudError("HISTORY_CLOUD_TIMEOUT");
  if (status === 429 || (status !== undefined && status >= 500 && status < 600)) return cloudError("HISTORY_CLOUD_RETRYABLE_QUERY");
  const message = typeof row.message === "string" ? row.message.slice(0, 2048).toLowerCase() : "";
  if (row.name === "AbortError" || message.startsWith("aborterror:")) return cloudError("HISTORY_CLOUD_CANCELLED");
  if (status === 0 || failure instanceof TypeError || /failed to fetch|fetch failed|network request failed|networkerror|network error/.test(message)) {
    return cloudError("HISTORY_CLOUD_NETWORK_UNAVAILABLE");
  }
  return normalizeHistoryBundleError(failure);
};

/**
 * On-demand SELECT collector; NEVER persists or activates a worker. One lifetime
 * covers all version/proof/page/digest reads, including gaps between SDK calls.
 * A ready result is a validated set of observations, not a server transaction
 * snapshot or permanent authorization to cache. Future persistence must recheck.
 */
export const fetchTranscriptHistoryBundle = async (
  input: TranscriptHistoryCloudVersionRequest,
  clientOverride?: SupabaseClient,
): Promise<TranscriptHistoryBundleResult> => {
  const request = captureHistoryCloudVersion({ ...input,
    timeoutMs: input?.timeoutMs === undefined ? HISTORY_BUNDLE_TIMEOUT_MS : input.timeoutMs });
  const { scope, versionId } = request;
  const base = { source: HISTORY_BUNDLE_SOURCE, scope: Object.freeze({ ...scope }), selectedVersionId: versionId } as const;
  const unavailable = (reason: HistoryBundleUnavailableReason): TranscriptHistoryBundleResult => ({ ...base, kind: "unavailable", reason });
  const notEligible = (result: Exclude<HistoryBundleEligibility, { kind: "eligible" }>): TranscriptHistoryBundleResult => ({ ...base, ...result });
  const assertContext = (): void => {
    if (request.signal?.aborted) throw cloudError("HISTORY_CLOUD_CANCELLED");
    if (isAccountDeletionLocallyPending()) throw cloudError("HISTORY_CLOUD_DELETION_PENDING");
    if (request.isContextActive) {
      let active = false;
      try { active = request.isContextActive() === true; } catch { /* Never expose the caller's exception. */ }
      if (!active) throw cloudError("HISTORY_CLOUD_CONTEXT_INACTIVE");
    }
  };
  assertContext();
  let client: SupabaseClient | null;
  try { client = clientOverride ?? getSupabase(); } catch { throw cloudError("HISTORY_CLOUD_NOT_CONFIGURED"); }
  if (!client) throw cloudError("HISTORY_CLOUD_NOT_CONFIGURED");
  const sdk = client;
  const controller = new AbortController();
  const active = collectors.get(sdk) ?? 0;
  if (active >= MAX_HISTORY_BUNDLE_CONCURRENT) throw cloudError("HISTORY_CLOUD_BUSY");
  collectors.set(sdk, active + 1);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const remaining = (collectors.get(sdk) ?? 1) - 1;
    if (remaining === 0) collectors.delete(sdk);
    else collectors.set(sdk, remaining);
  };
  let finished = false;
  let stopped: Error | null = null;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let operation: Promise<TranscriptHistoryBundleResult> | undefined;
  let rejectInterrupted!: (reason: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  void interrupted.catch(() => undefined);
  const deadline = Date.now() + request.timeoutMs;
  let requestCount = 0;
  let bytesLeft = MAX_HISTORY_BUNDLE_BYTES;
  const stop = (reason: Error): void => {
    if (finished || stopped) return;
    stopped = reason;
    rejectInterrupted(reason);
    controller.abort();
  };
  const cancel = (): void => stop(cloudError("HISTORY_CLOUD_CANCELLED"));
  const guard = (): void => {
    if (stopped) throw stopped;
    if (finished) throw cloudError("HISTORY_CLOUD_CONTEXT_INACTIVE");
    try {
      assertContext();
      if (Date.now() >= deadline) throw cloudError("HISTORY_CLOUD_TIMEOUT");
    } catch (failure) { const safe = failureError(failure); stop(safe); throw safe; }
  };
  const matchesSession = (value: unknown): boolean => {
    const session = value as { access_token?: unknown; user?: { id?: unknown } } | null;
    return !!session && typeof session.access_token === "string" && session.access_token.length > 0 &&
      typeof session.user?.id === "string" && session.user.id.toLowerCase() === scope.userId;
  };
  const requireAuth = async (): Promise<void> => {
    guard();
    const reply = await sdk.auth.getSession();
    guard();
    if (reply.error || !matchesSession(reply.data.session)) throw cloudError("HISTORY_CLOUD_AUTH_REQUIRED");
  };
  const admitRead = (): void => {
    guard();
    if (++requestCount > MAX_HISTORY_BUNDLE_REQUESTS) throw new TranscriptHistoryBundleError("HISTORY_BUNDLE_LIMIT_EXCEEDED");
  };
  const consume = (value: unknown): void => { bytesLeft -= historyBundleByteSize(value, bytesLeft); guard(); };
  const queryRows = async (query: () => PromiseLike<QueryReply>, maximum: number): Promise<unknown[]> => {
    admitRead(); await requireAuth(); guard();
    const reply = await query();
    guard();
    if (!reply || !Number.isInteger(reply.status)) return invalid();
    if (reply.error || reply.status < 200 || reply.status >= 300) throw failureError(reply.error, reply.status);
    if (!Array.isArray(reply.data) || reply.data.length > maximum) return invalid();
    consume(reply.data); await requireAuth(); guard();
    return reply.data;
  };
  const readVersion = async (id: string, expectedVersion?: number): Promise<TranscriptHistoryCloudVersion | null> => {
    const rows = await queryRows(() => sdk.from("transcript_versions").select(HISTORY_CLOUD_DETAIL_COLUMNS.join(","))
      .eq("workspace_id", scope.workspaceId).eq("session_id", scope.sessionId).eq("version_status", "final")
      .eq("id", id).limit(2).abortSignal(controller.signal), 1);
    if (!rows.length) return null;
    const version = parseHistoryCloudVersion(rows[0], scope);
    if (version.id !== id || (expectedVersion !== undefined && version.version !== expectedVersion)) return invalid();
    return version;
  };
  const readRun = async (id: string) => {
    const rows = await queryRows(() => sdk.from("transcription_runs").select(HISTORY_BUNDLE_RUN_COLUMNS.join(","))
      .eq("id", id).eq("workspace_id", scope.workspaceId).eq("session_id", scope.sessionId).limit(2).abortSignal(controller.signal), 1);
    if (!rows.length) return null;
    const run = parseHistoryBundleRun(rows[0]);
    if (run.id !== id || run.workspace_id !== scope.workspaceId || run.session_id !== scope.sessionId) return invalid();
    return run;
  };
  const readJob = async (id: string) => {
    const rows = await queryRows(() => sdk.from("processing_jobs").select(HISTORY_BUNDLE_JOB_COLUMNS.join(","))
      .eq("id", id).eq("workspace_id", scope.workspaceId).eq("session_id", scope.sessionId).limit(2).abortSignal(controller.signal), 1);
    if (!rows.length) return null;
    const job = parseHistoryBundleJob(rows[0]);
    if (job.id !== id || job.workspace_id !== scope.workspaceId || job.session_id !== scope.sessionId) return invalid();
    return job;
  };

  try {
    request.signal?.addEventListener("abort", cancel);
    timer = setTimeout(() => stop(cloudError("HISTORY_CLOUD_TIMEOUT")), request.timeoutMs);
    const subscription = sdk.auth.onAuthStateChange((_event, session) => {
      // Synchronous, no SDK calls here: no auth callback deadlock.
      if (!matchesSession(session)) stop(cloudError("HISTORY_CLOUD_AUTH_REQUIRED"));
    }).data.subscription;
    unsubscribe = () => subscription.unsubscribe();
    guard();
    operation = (async (): Promise<TranscriptHistoryBundleResult> => {
      await requireAuth();
      const selected = await readVersion(versionId, request.expectedVersion);
      if (!selected) return unavailable("version_not_visible");
      const versions = [selected];
      const seen = new Set<string>([selected.id]);
      while (versions[versions.length - 1].version_origin === "user_edit") {
        guard();
        if (versions.length > MAX_TRANSCRIPT_LINEAGE_DEPTH) throw new TranscriptHistoryBundleError("HISTORY_BUNDLE_LIMIT_EXCEEDED");
        const child = versions[versions.length - 1];
        if (child.parent_version_id === null || seen.has(child.parent_version_id)) return invalid();
        const parent = await readVersion(child.parent_version_id);
        if (!parent) return unavailable("parent_not_visible");
        assertHistoryBundleParent(child, parent);
        seen.add(parent.id); versions.push(parent);
      }
      let provider = versions[versions.length - 1];
      if (provider.version_origin !== "provider") return unavailable("unsupported_origin");
      if (provider.parent_version_id !== null) return unavailable("unsupported_provider_lineage");
      if (provider.transcription_run_id === null) return unavailable("nullable_run_provenance");
      const run = await readRun(provider.transcription_run_id);
      if (!run) return unavailable("run_not_visible");
      if (run.id !== provider.transcription_run_id) return invalid();
      const job = await readJob(run.processing_job_id);
      if (!job) return unavailable("job_not_visible");
      const proof = assessHistoryBundleProof(provider, run, job);
      if (proof.kind !== "eligible") return notEligible(proof);
      const segments: SyncedTranscriptSegment[] = [];
      const ids = new Set<string>();
      let previousStart = -1;
      // Empty terminal page AND exact trusted count; short pages never imply completion.
      while (true) {
        guard();
        const pageSize = Math.min(HISTORY_BUNDLE_SEGMENT_PAGE_SIZE, proof.expectedSegmentCount - segments.length + 1);
        const rows = await queryRows(() => sdk.from("transcript_segments").select(HISTORY_BUNDLE_SEGMENT_COLUMNS.join(","))
          .eq("workspace_id", scope.workspaceId).eq("session_id", scope.sessionId).eq("transcript_version_id", provider.id)
          .gt("segment_index", segments.length - 1).order("segment_index", { ascending: true }).limit(pageSize)
          .abortSignal(controller.signal), pageSize);
        if (rows.length === 0) {
          if (segments.length !== proof.expectedSegmentCount) return invalid();
          break;
        }
        for (const row of rows) {
          const segment = parseHistoryBundleSegment(row, provider, run);
          if (segments.length >= proof.expectedSegmentCount || segment.segment_index !== segments.length ||
              ids.has(segment.id) || segment.start_ms < previousStart) return invalid();
          ids.add(segment.id); previousStart = segment.start_ms; segments.push(segment);
        }
      }
      // Detect visibility loss, reference cleanup or immutable-content changes during traversal.
      for (let index = 0; index < versions.length; index += 1) {
        const old = versions[index];
        const latest = await readVersion(old.id, old.version);
        if (!latest) return unavailable(index === 0 ? "version_not_visible" : "parent_not_visible");
        versions[index] = reconcileHistoryBundleVersion(old, latest);
      }
      provider = versions[versions.length - 1];
      if (provider.transcription_run_id === null) return unavailable("nullable_run_provenance");
      const finalRun = await readRun(run.id);
      if (!finalRun) return unavailable("run_not_visible");
      const finalJob = await readJob(job.id);
      if (!finalJob) return unavailable("job_not_visible");
      const finalProof = assessHistoryBundleProof(provider, finalRun, finalJob);
      if (finalProof.kind !== "eligible") return notEligible(finalProof);
      if (finalRun.word_count !== run.word_count || finalRun.provider_job_id !== run.provider_job_id ||
          finalRun.recording_id !== run.recording_id || finalJob.id !== job.id) {
        throw new TranscriptHistoryBundleError("HISTORY_BUNDLE_PROOF_CHANGED");
      }
      // User edits have Full Text only. Probe for forbidden segment rows rather
      // than silently omitting them from a bundle described as complete.
      for (const version of versions) {
        if (version.version_origin !== "user_edit") continue;
        const unexpected = await queryRows(() => sdk.from("transcript_segments").select("id")
          .eq("workspace_id", scope.workspaceId).eq("session_id", scope.sessionId).eq("transcript_version_id", version.id)
          .limit(1).abortSignal(controller.signal), 1);
        if (unexpected.length !== 0) return invalid();
      }
      const bundle = await validateTranscriptHistoryBundle({ scope, selectedVersionId: versionId, versions, run: finalRun, job: finalJob, segments }, guard);
      guard(); await requireAuth(); guard();
      return Object.freeze({ ...base, kind: "ready", bundle });
    })();
    // A cancelled, abort-ignoring operation keeps its slot until its continuation settles.
    // That continuation is guarded and cannot issue another SELECT or deliver a bundle.
    void operation.then(release, release);
    const result = await Promise.race([operation, interrupted]);
    guard();
    return result;
  } catch (failure) {
    const safe = stopped ?? failureError(failure);
    stop(safe);
    throw safe;
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    try { request.signal?.removeEventListener("abort", cancel); } catch { /* No raw cleanup exceptions. */ }
    try { unsubscribe?.(); } catch { /* Invalidation remains effective even if cleanup throws. */ }
    if (!operation) release();
  }
};
