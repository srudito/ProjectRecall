import {
  getCurrentTranscriptVersionForSession,
  listTranscriptSegmentsForVersion,
} from "@/src/services/sqlite/repository";

import type {
  SyncedTranscriptSegment,
  SyncedTranscriptVersion,
} from "./result-types";

export type LocalTranscriptReadModel =
  | { kind: "empty" }
  | {
      kind: "ready";
      version: SyncedTranscriptVersion;
      segments: SyncedTranscriptSegment[];
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

const validateSegments = (
  sessionId: string,
  version: SyncedTranscriptVersion,
  segments: readonly SyncedTranscriptSegment[],
): void => {
  let previousIndex = -1;

  for (const segment of segments) {
    if (
      segment.workspace_id !== version.workspace_id ||
      segment.session_id !== sessionId ||
      segment.transcript_version_id !== version.id ||
      segment.segment_index <= previousIndex
    ) {
      throw new LocalTranscriptReadError();
    }
    previousIndex = segment.segment_index;
  }
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
  validateSegments(sessionId, version, segments);

  const versionText = version.plain_text.trim();
  const plainText =
    versionText.length > 0
      ? versionText
      : segments
          .map((segment) => segment.text.trim())
          .filter((text) => text.length > 0)
          .join(" ");

  return {
    kind: "ready",
    version,
    segments: [...segments],
    plainText,
    segmentCount: segments.length,
  };
};
