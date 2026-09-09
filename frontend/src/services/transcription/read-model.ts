import { withLocalTranscriptReadSnapshot } from "@/src/services/sqlite/repository";
import { formatDurationMs } from "@/src/utils/format";

import {
  isTranscriptLineageParent,
  MAX_TRANSCRIPT_LINEAGE_DEPTH,
  type SyncedTranscriptSegment,
  type SyncedTranscriptVersion,
  type SyncedTranscriptVersionRecord,
} from "./result-types";

export interface LocalTranscriptSegmentReadRow {
  id: string;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  timestampLabel: string;
  text: string;
  languageCode: string | null;
  speakerLabel: string | null;
}

export type LocalTranscriptReadModel =
  | { kind: "empty" }
  | {
      kind: "ready";
      version: SyncedTranscriptVersion;
      segmentRows: LocalTranscriptSegmentReadRow[];
      plainText: string;
      segmentCount: number;
    };

export class LocalTranscriptReadError extends Error {
  constructor(message = "The local transcript cache is invalid.") {
    super(message);
    this.name = "LocalTranscriptReadError";
  }
}

export interface LocalTranscriptReadDependencies {
  getCurrentVersion: (
    sessionId: string,
  ) => Promise<SyncedTranscriptVersion | null>;
  listSegments: (
    transcriptVersionId: string,
  ) => Promise<SyncedTranscriptSegment[]>;
}

const optionalTrimmed = (value: string | null): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
};

export const formatTranscriptSegmentTimeRange = (
  startMs: number,
  endMs: number,
): string => {
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    startMs < 0 ||
    endMs < startMs
  ) {
    throw new LocalTranscriptReadError();
  }

  const start = formatDurationMs(startMs);
  const end = formatDurationMs(endMs);
  return start === end ? start : `${start}–${end}`;
};

export const buildLocalTranscriptSegmentRows = (
  sessionId: string,
  version: SyncedTranscriptVersionRecord,
  segments: readonly SyncedTranscriptSegment[],
): LocalTranscriptSegmentReadRow[] => {
  let previousIndex = -1;
  const seenIds = new Set<string>();

  return segments.map((segment) => {
    const segmentText = segment.text.trim();
    if (
      segment.workspace_id !== version.workspace_id ||
      segment.session_id !== sessionId ||
      segment.transcript_version_id !== version.id ||
      !Number.isSafeInteger(segment.segment_index) ||
      segment.segment_index <= previousIndex ||
      seenIds.has(segment.id) ||
      segmentText.length === 0
    ) {
      throw new LocalTranscriptReadError();
    }

    const timestampLabel = formatTranscriptSegmentTimeRange(
      segment.start_ms,
      segment.end_ms,
    );
    previousIndex = segment.segment_index;
    seenIds.add(segment.id);

    return {
      id: segment.id,
      segmentIndex: segment.segment_index,
      startMs: segment.start_ms,
      endMs: segment.end_ms,
      timestampLabel,
      text: segmentText,
      languageCode: optionalTrimmed(segment.language_code),
      speakerLabel: optionalTrimmed(segment.speaker_label),
    };
  });
};

const loadTranscriptFromReads = async (
  sessionId: string,
  dependencies: LocalTranscriptReadDependencies,
): Promise<LocalTranscriptReadModel> => {
  const version = await dependencies.getCurrentVersion(sessionId);
  if (!version) return { kind: "empty" };

  if (version.session_id !== sessionId || version.is_current !== true) {
    throw new LocalTranscriptReadError();
  }

  const segments = await dependencies.listSegments(version.id);
  const segmentRows = buildLocalTranscriptSegmentRows(
    sessionId,
    version,
    segments,
  );

  const versionText = version.plain_text.trim();
  const plainText =
    versionText.length > 0
      ? versionText
      : segmentRows.map((segment) => segment.text).join(" ");

  return {
    kind: "ready",
    version,
    segmentRows,
    plainText,
    segmentCount: segmentRows.length,
  };
};

/** Default native path: current version and segments share ONE read snapshot.
 * Complete dependency injection remains available for pure tests; partial
 * overrides use snapshot-bound defaults, never shared-db getters.
 */
export const loadLocalTranscriptReadModel = async (
  sessionId: string,
  overrides: Partial<LocalTranscriptReadDependencies> = {},
): Promise<LocalTranscriptReadModel> => {
  if (overrides.getCurrentVersion && overrides.listSegments) {
    return loadTranscriptFromReads(sessionId, {
      getCurrentVersion: overrides.getCurrentVersion, listSegments: overrides.listSegments,
    });
  }
  return await withLocalTranscriptReadSnapshot(sessionId, (reads) =>
    loadTranscriptFromReads(sessionId, { ...reads, ...overrides })) ?? { kind: "empty" };
};

/** Provider timestamps never become timestamp mappings for edited Full Text. */
export type LocalTranscriptEvidenceState =
  | {
      kind: "available";
      source: "current" | "ancestor";
      version: SyncedTranscriptVersionRecord;
      segmentRows: LocalTranscriptSegmentReadRow[];
      segmentCount: number;
    }
  | { kind: "none" }
  | {
      kind: "unavailable";
      reason: "parent_missing" | "invalid_cache" | "depth_limit" | "read_failed";
    };

export type LocalTranscriptReadModelWithEvidence =
  | { kind: "empty" }
  | (Extract<LocalTranscriptReadModel, { kind: "ready" }> & {
      /** Exact stored text for future editing; never trimmed or synthesized. */
      rawPlainText: string;
      evidence: LocalTranscriptEvidenceState;
    });

export interface LocalTranscriptEvidenceReadDependencies
  extends LocalTranscriptReadDependencies {
  getVersionById: (input: {
    versionId: string;
    workspaceId: string;
    sessionId: string;
  }) => Promise<SyncedTranscriptVersionRecord | null>;
}

const loadLocalProviderEvidence = async (
  model: Extract<LocalTranscriptReadModel, { kind: "ready" }>,
  dependencies: LocalTranscriptEvidenceReadDependencies,
): Promise<LocalTranscriptEvidenceState> => {
  const { version } = model;
  if (version.version_origin === "provider") {
    return {
      kind: "available",
      source: "current",
      version,
      segmentRows: model.segmentRows,
      segmentCount: model.segmentCount,
    };
  }
  // Match the remote snapshot contract: only user edits traverse ancestry.
  if (version.version_origin !== "user_edit") return { kind: "none" };

  const visited = new Set<string>([version.id]);
  let child: SyncedTranscriptVersionRecord = version;
  for (let depth = 0; child.parent_version_id !== null; depth += 1) {
    if (depth >= MAX_TRANSCRIPT_LINEAGE_DEPTH) {
      return { kind: "unavailable", reason: "depth_limit" };
    }
    const parentId = child.parent_version_id;
    if (visited.has(parentId)) {
      return { kind: "unavailable", reason: "invalid_cache" };
    }
    visited.add(parentId);

    let parent: SyncedTranscriptVersionRecord | null;
    try {
      parent = await dependencies.getVersionById({
        versionId: parentId,
        workspaceId: version.workspace_id,
        sessionId: version.session_id,
      });
    } catch {
      return { kind: "unavailable", reason: "read_failed" };
    }
    if (!parent) return { kind: "unavailable", reason: "parent_missing" };
    if (!isTranscriptLineageParent(child, parent)) {
      return { kind: "unavailable", reason: "invalid_cache" };
    }

    if (parent.version_origin === "provider") {
      try {
        const segments = await dependencies.listSegments(parent.id);
        const segmentRows = buildLocalTranscriptSegmentRows(
          version.session_id,
          parent,
          segments,
        );
        return {
          kind: "available",
          source: "ancestor",
          version: parent,
          segmentRows,
          segmentCount: segmentRows.length,
        };
      } catch (error) {
        return {
          kind: "unavailable",
          reason: error instanceof LocalTranscriptReadError
            ? "invalid_cache"
            : "read_failed",
        };
      }
    }
    child = parent;
  }
  return { kind: "none" };
};

const loadTranscriptEvidenceFromReads = async (
  sessionId: string,
  dependencies: LocalTranscriptEvidenceReadDependencies,
): Promise<LocalTranscriptReadModelWithEvidence> => {
  const model = await loadTranscriptFromReads(sessionId, dependencies);
  if (model.kind === "empty") return model;
  if (
    model.version.version_status !== "final" ||
    (model.version.version_origin === "user_edit" && model.segmentCount !== 0)
  ) {
    throw new LocalTranscriptReadError();
  }

  return {
    ...model,
    rawPlainText: model.version.plain_text,
    evidence: await loadLocalProviderEvidence(model, dependencies),
  };
};

/** Full Text, exact ancestry and provider evidence share ONE local snapshot. */
export const loadLocalTranscriptReadModelWithEvidence = async (
  sessionId: string,
  overrides: Partial<LocalTranscriptEvidenceReadDependencies> = {},
): Promise<LocalTranscriptReadModelWithEvidence> => {
  if (overrides.getCurrentVersion && overrides.listSegments && overrides.getVersionById) {
    return loadTranscriptEvidenceFromReads(sessionId, {
      getCurrentVersion: overrides.getCurrentVersion, listSegments: overrides.listSegments,
      getVersionById: overrides.getVersionById,
    });
  }
  return await withLocalTranscriptReadSnapshot(sessionId, (reads) =>
    loadTranscriptEvidenceFromReads(sessionId, { ...reads, ...overrides })) ?? { kind: "empty" };
};
