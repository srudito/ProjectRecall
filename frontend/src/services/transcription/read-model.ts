import {
  getCurrentTranscriptVersionForSession,
  listTranscriptSegmentsForVersion,
} from "@/src/services/sqlite/repository";
import { formatDurationMs } from "@/src/utils/format";

import type {
  SyncedTranscriptSegment,
  SyncedTranscriptVersion,
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

const defaultDependencies: LocalTranscriptReadDependencies = {
  getCurrentVersion: getCurrentTranscriptVersionForSession,
  listSegments: listTranscriptSegmentsForVersion,
};

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
  version: SyncedTranscriptVersion,
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

export const loadLocalTranscriptReadModel = async (
  sessionId: string,
  overrides: Partial<LocalTranscriptReadDependencies> = {},
): Promise<LocalTranscriptReadModel> => {
  const dependencies: LocalTranscriptReadDependencies = {
    ...defaultDependencies,
    ...overrides,
  };
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
