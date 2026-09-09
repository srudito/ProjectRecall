import type { SQLiteBindValue } from "expo-sqlite";

import {
  assertCachedHistorySegment,
  consumeHistoryCacheCommand,
  HISTORY_CACHE_SEGMENT_COLUMNS,
  HISTORY_CACHE_VERSION_COLUMNS,
  historyCacheError,
  historyCacheResult,
  MAX_HISTORY_CACHE_SEGMENTS,
  normalizeHistoryCacheError,
  reconcileCachedHistoryVersion,
  type HistoryCacheResult,
  type PreparedHistoryCacheCommand,
  type PreparedHistoryCacheData,
} from "@/src/services/transcription/history-cache-types";
import type { TranscriptHistoryCloudVersion } from "@/src/services/transcription/history-cloud-types";
import type { SyncedTranscriptSegment } from "@/src/services/transcription/result-types";

import { openLocalHistoryWriteDb } from "./schema";
import { LocalWriteRecoveryError, retainLocalWriteRecovery, withLocalTransactionTurn } from "./transaction";

export interface HistoryCacheStatement {
  executeAsync(params: SQLiteBindValue[]): Promise<{ changes: number }>;
  finalizeAsync(): Promise<void>;
}
export interface HistoryCacheDatabase {
  getFirstAsync<T>(sql: string, params: SQLiteBindValue[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params: SQLiteBindValue[]): Promise<T[]>;
  execAsync(sql: string): Promise<void>;
  prepareAsync(sql: string): Promise<HistoryCacheStatement>;
  closeAsync(): Promise<void>;
  isInTransactionAsync?(): Promise<boolean>;
}
export interface HistoryCacheWriterDependencies {
  open: () => Promise<HistoryCacheDatabase | null>;
  withTurn: <T>(task: () => Promise<T>) => Promise<T>;
}
interface OwnedWrite {
  db: HistoryCacheDatabase;
  sessionId: string;
  transactionOpen: boolean;
  dischargeRecovery?: () => void;
  statements: Set<HistoryCacheStatement>;
}
interface WritePlan {
  versions: Readonly<TranscriptHistoryCloudVersion>[];
  segments: Readonly<SyncedTranscriptSegment>[];
  provenance: { id: string; createdBy: string | null; runId: string | null; updatedAt: string }[];
}
const versionColumns = HISTORY_CACHE_VERSION_COLUMNS.join(", ");
const segmentColumns = HISTORY_CACHE_SEGMENT_COLUMNS.join(", ");
const conflict = (): never => { throw historyCacheError("HISTORY_CACHE_CONFLICT"); };
const isBusy = (failure: unknown): boolean => {
  if (!failure || typeof failure !== "object") return false;
  const row = failure as { code?: unknown; message?: unknown };
  return row.code === 5 || row.code === 6 || row.code === "SQLITE_BUSY" || row.code === "SQLITE_LOCKED" ||
    (typeof row.message === "string" && /database is (locked|busy)|SQLITE_(BUSY|LOCKED)/i.test(row.message.slice(0, 2048)));
};

/** Read and plan under the write lock; never rely on a preflight read snapshot. */
const planWrites = async (db: HistoryCacheDatabase, data: PreparedHistoryCacheData): Promise<WritePlan | null> => {
  const guard = data.assertActive;
  const all = async <T>(sql: string, values: SQLiteBindValue[]): Promise<T[]> => {
    guard(); const rows = await db.getAllAsync<T>(sql, values); guard();
    if (!Array.isArray(rows)) return conflict();
    return rows;
  };
  const first = async <T>(sql: string, values: SQLiteBindValue[]): Promise<T | null> => {
    guard(); const row = await db.getFirstAsync<T>(sql, values); guard(); return row;
  };
  const { scope, provider } = data;
  const session = await first<{ id: string; workspace_id: string; status: string; deleted_at: string | null }>(
    `SELECT id, workspace_id, status, deleted_at FROM local_sessions
      WHERE id = ? AND workspace_id = ? LIMIT 1`, [scope.sessionId, scope.workspaceId]);
  const deletion = await first<{ id: string }>(
    "SELECT id FROM local_session_deletion_queue WHERE session_id = ? LIMIT 1", [scope.sessionId]);
  if (!session || session.id !== scope.sessionId || session.workspace_id !== scope.workspaceId ||
      typeof session.status !== "string" || session.deleted_at !== null ||
      session.status === "deleting" || session.status === "deleted" || deletion) {
    throw historyCacheError("HISTORY_CACHE_SESSION_UNAVAILABLE");
  }
  // Optional local rows must correlate if present. Never fabricate absent rows.
  for (const [table, id] of [
    ["local_recordings", provider.recordingId], ["local_processing_jobs", provider.jobId],
    ["local_transcription_runs", provider.runId],
  ] as const) {
    const extra = table === "local_recordings" ? "" : ", recording_id";
    const parent = table === "local_transcription_runs" ? ", processing_job_id" : "";
    const row = await first<Record<string, unknown>>(
      `SELECT id, workspace_id, session_id${extra}${parent} FROM ${table} WHERE id = ? LIMIT 1`, [id]);
    if (row && (row.id !== id || row.workspace_id !== scope.workspaceId || row.session_id !== scope.sessionId ||
        (table !== "local_recordings" && row.recording_id !== provider.recordingId) ||
        (table === "local_transcription_runs" && row.processing_job_id !== provider.jobId))) return conflict();
  }
  const plan: WritePlan = { versions: [], segments: [], provenance: [] };
  for (const version of [...data.versions].reverse()) {
    const rows = await all<Record<string, unknown>>(
      `SELECT ${versionColumns} FROM local_transcript_versions
        WHERE id = ? OR (session_id = ? AND version = ?)`, [version.id, scope.sessionId, version.version]);
    if (rows.length > 1 || (rows.length === 1 && rows[0].id !== version.id)) return conflict();
    if (rows.length === 0) plan.versions.push(version);
    else {
      const merge = reconcileCachedHistoryVersion(rows[0], version, scope);
      if (merge.changed) plan.provenance.push({ id: version.id, ...merge });
    }
    const localSegments = await all<Record<string, unknown>>(
      `SELECT ${segmentColumns} FROM local_transcript_segments
        WHERE transcript_version_id = ? ORDER BY segment_index LIMIT ?`, [version.id, MAX_HISTORY_CACHE_SEGMENTS + 1]);
    if (version.id !== provider.versionId) {
      if (localSegments.length !== 0) return conflict();
      continue;
    }
    if (localSegments.length > data.segments.length) return conflict();
    const seen = new Set<number>();
    for (const row of localSegments) {
      const index = row.segment_index;
      if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= data.segments.length ||
          seen.has(index as number)) return conflict();
      assertCachedHistorySegment(row, data.segments[index as number]);
      seen.add(index as number);
    }
    plan.segments = data.segments.filter((segment) => !seen.has(segment.segment_index));
  }
  // Check global segment IDs in bounded batches, including orphan/cross-version collisions.
  for (let offset = 0; offset < plan.segments.length; offset += 200) {
    const batch = plan.segments.slice(offset, offset + 200);
    const rows = await all<{ id: string }>(
      `SELECT id FROM local_transcript_segments WHERE id IN (${batch.map(() => "?").join(",")})`, batch.map((s) => s.id));
    if (rows.length !== 0) return conflict();
  }
  if (plan.versions.some((v) => v.id === provider.versionId)) {
    // Do not satisfy the result worker's marker while leaving its diagnostics
    // unfinished. Defer even if local job/run are not succeeded YET: an older
    // in-flight progress response could otherwise complete this join later.
    const owned = await first<{ id: string }>(
      `SELECT request_row.id FROM local_transcription_request_queue request_row
        WHERE request_row.queue_status = 'submitted' AND request_row.server_job_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM local_processing_jobs result_job
            JOIN local_transcription_runs result_run ON result_run.processing_job_id = result_job.id
            JOIN local_transcript_versions result_version ON result_version.transcription_run_id = result_run.id
              AND result_version.version_origin = 'provider' AND result_version.version_status = 'final'
            WHERE result_job.id = request_row.server_job_id
              AND result_job.status = 'succeeded' AND result_run.status = 'succeeded'
          ) LIMIT 1`, [provider.jobId]);
    if (owned) return null;
  }
  guard();
  return plan;
};

/**
 * Dedicated connection + shared write lane. Repository mutations join the
 * lane; native contention/immutable-provenance acceptance still gates activation.
 * No RPC, queue mutation, current promotion, notification, or automatic retry.
 */
export const createHistoryCacheWriter = (overrides: Partial<HistoryCacheWriterDependencies> = {}) => {
  const dependencies: HistoryCacheWriterDependencies = {
    open: openLocalHistoryWriteDb, withTurn: withLocalTransactionTurn, ...overrides,
  };
  const active = new Map<Promise<HistoryCacheResult>, string>();
  const retained = new Set<OwnedWrite>();
  let closing: Promise<void> | null = null;

  const finalize = async (owner: OwnedWrite): Promise<void> => {
    for (const statement of [...owner.statements]) {
      await statement.finalizeAsync();
      owner.statements.delete(statement);
    }
  };
  const release = async (owner: OwnedWrite): Promise<boolean> => {
    try { await finalize(owner); } catch { /* Native close is still required. */ }
    if (owner.transactionOpen) {
      try { await owner.db.execAsync("ROLLBACK;"); owner.transactionOpen = false; }
      catch { /* Close rolls back an uncommitted connection; never claim an ambiguous COMMIT failed. */ }
    }
    try {
      await owner.db.closeAsync();
      owner.transactionOpen = false;
      owner.dischargeRecovery?.(); owner.dischargeRecovery = undefined;
      retained.delete(owner);
      return true;
    } catch {
      // Only an unresolved transaction is a database-wide write barrier. A
      // confirmed COMMIT/ROLLBACK plus failed close still blocks this owner's
      // drain, but does not needlessly block unrelated main-connection writes.
      if (owner.transactionOpen && owner.db.isInTransactionAsync) {
        try { if (await owner.db.isInTransactionAsync() === false) owner.transactionOpen = false; }
        catch { /* Unknown native state must remain gated. */ }
      }
      retained.add(owner);
      if (owner.transactionOpen && !owner.dischargeRecovery) {
        owner.dischargeRecovery = retainLocalWriteRecovery(async () => {
          await release(owner);
          if (owner.transactionOpen) throw new LocalWriteRecoveryError();
        });
      } else if (!owner.transactionOpen) {
        owner.dischargeRecovery?.(); owner.dischargeRecovery = undefined;
      }
      return false;
    }
  };
  const execute = async (data: PreparedHistoryCacheData): Promise<HistoryCacheResult> => {
    let result = historyCacheResult("rejected", "HISTORY_CACHE_WRITE_FAILED");
    let owner: OwnedWrite | null = null;
    let commitIssued = false;
    try {
      data.assertActive();
      if (retained.size > 0) return { ...historyCacheResult("retryable", "HISTORY_CACHE_RESOURCES_PENDING"),
        resources: "pending", resourceError: "HISTORY_CACHE_RESOURCES_PENDING" };
      let db: HistoryCacheDatabase | null;
      try { db = await dependencies.open(); }
      catch { throw historyCacheError("HISTORY_CACHE_STORAGE_UNAVAILABLE"); }
      if (!db) throw historyCacheError("HISTORY_CACHE_STORAGE_UNAVAILABLE");
      owner = { db, sessionId: data.scope.sessionId, transactionOpen: false, statements: new Set() };
      data.assertActive();
      await db.execAsync("PRAGMA query_only = OFF; PRAGMA read_uncommitted = OFF; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 250;");
      data.assertActive();
      // An unacknowledged BEGIN can still have opened the native transaction.
      owner.transactionOpen = true;
      await db.execAsync("BEGIN IMMEDIATE;");
      data.assertActive();
      const plan = await planWrites(db, data);
      if (plan === null) result = historyCacheResult("deferred_to_result_sync", "HISTORY_CACHE_RESULT_SYNC_OWNED");
      else if (plan.versions.length + plan.segments.length + plan.provenance.length === 0) result = historyCacheResult("unchanged");
      else {
        const prepare = async (sql: string): Promise<HistoryCacheStatement> => {
          data.assertActive(); const statement = await db.prepareAsync(sql); owner!.statements.add(statement);
          data.assertActive(); return statement;
        };
        const write = async (statement: HistoryCacheStatement, values: SQLiteBindValue[]): Promise<void> => {
          data.assertActive(); const applied = await statement.executeAsync(values); data.assertActive();
          if (applied.changes !== 1) return conflict();
        };
        if (plan.versions.length > 0) {
          const statement = await prepare(
            `INSERT INTO local_transcript_versions (${versionColumns}) VALUES (${HISTORY_CACHE_VERSION_COLUMNS.map(() => "?").join(",")})`);
          for (const version of plan.versions) {
            await write(statement, HISTORY_CACHE_VERSION_COLUMNS.map((key) => key === "is_current" ? 0 :
              key === "language_summary" ? JSON.stringify(version.language_summary) : version[key]));
          }
        }
        if (plan.provenance.length > 0) {
          const statement = await prepare(
            `UPDATE local_transcript_versions SET created_by = ?, transcription_run_id = ?, updated_at = ?
              WHERE id = ? AND workspace_id = ? AND session_id = ?`);
          for (const change of plan.provenance) {
            await write(statement, [change.createdBy, change.runId, change.updatedAt,
              change.id, data.scope.workspaceId, data.scope.sessionId]);
          }
        }
        if (plan.segments.length > 0) {
          const statement = await prepare(
            `INSERT INTO local_transcript_segments (${segmentColumns}) VALUES (${HISTORY_CACHE_SEGMENT_COLUMNS.map(() => "?").join(",")})`);
          for (const segment of plan.segments) await write(statement, HISTORY_CACHE_SEGMENT_COLUMNS.map((key) => segment[key]));
        }
        await finalize(owner);
        data.assertActive();
        commitIssued = true;
        await db.execAsync("COMMIT;");
        owner.transactionOpen = false;
        // No lifetime check can turn an acknowledged COMMIT into a rollback.
        result = { ...historyCacheResult("committed"), insertedVersions: plan.versions.length,
          insertedSegments: plan.segments.length, clearedProvenance: plan.provenance.length };
      }
    } catch (failure) {
      if (commitIssued) result = historyCacheResult("indeterminate", "HISTORY_CACHE_COMMIT_UNCONFIRMED");
      else if (isBusy(failure)) result = historyCacheResult("retryable", "HISTORY_CACHE_BUSY");
      else result = historyCacheResult("rejected", normalizeHistoryCacheError(failure).code);
    } finally {
      if (owner && !(await release(owner))) {
        result.resources = "pending";
        result.resourceError = "HISTORY_CACHE_RESOURCES_PENDING";
      }
    }
    return result;
  };

  const persist = async (command: PreparedHistoryCacheCommand): Promise<HistoryCacheResult> => {
    let data: PreparedHistoryCacheData;
    try { data = consumeHistoryCacheCommand(command); }
    catch (failure) { return historyCacheResult("rejected", normalizeHistoryCacheError(failure).code); }
    const pending = dependencies.withTurn(() => execute(data));
    active.set(pending, data.scope.sessionId);
    try { return await pending; }
    catch (failure) {
      if (failure instanceof LocalWriteRecoveryError) return {
        ...historyCacheResult("retryable", "HISTORY_CACHE_RESOURCES_PENDING"),
        resources: "pending", resourceError: "HISTORY_CACHE_RESOURCES_PENDING",
      };
      throw failure;
    } finally { active.delete(pending); }
  };
  const waitForIdle = async (sessionId?: string): Promise<void> => {
    const relevant = () => [...active].filter(([, id]) => sessionId === undefined || id === sessionId.toLowerCase()).map(([p]) => p);
    while (relevant().length > 0) await Promise.allSettled(relevant());
    // Retries native cleanup only, never a database write/commit or cloud read.
    if (closing) { await closing; return waitForIdle(sessionId); }
    if (![...retained].some((o) => sessionId === undefined || o.sessionId === sessionId.toLowerCase())) return;
    closing = dependencies.withTurn(async () => {
      for (const owner of [...retained]) {
        if (sessionId !== undefined && owner.sessionId !== sessionId.toLowerCase()) continue;
        if (!(await release(owner))) throw historyCacheError("HISTORY_CACHE_RESOURCES_PENDING");
      }
    });
    try { await closing; } finally { closing = null; }
  };
  return { persist, waitForIdle };
};
const writer = createHistoryCacheWriter();
export const persistPreparedTranscriptHistoryCache = writer.persist;
export const waitForHistoryCacheWritesIdle = writer.waitForIdle;
