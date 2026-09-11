import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Modal, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useI18n } from "@/src/i18n/I18nProvider";
import { fetchTranscriptHistoryPage } from "@/src/services/transcription/history-client";
import type {
  TranscriptHistoryCloudCursor,
  TranscriptHistoryCloudSummary,
} from "@/src/services/transcription/history-cloud-types";
import {
  createLocalTranscriptHistoryReader,
  type TranscriptHistoryHydrationResult,
} from "@/src/services/transcription/history-read-model";
import {
  prepareTranscriptHistoryRestoreDraft,
} from "@/src/services/transcription/history-restore-service";
import {
  normalizeTranscriptHistoryRestoreFailure,
  type TranscriptHistoryRestoreDraftResult,
  type TranscriptHistoryRestoreErrorCode,
} from "@/src/services/transcription/history-restore-types";
import type { HistoryCacheResult } from "@/src/services/transcription/history-cache-types";
import type {
  LocalTranscriptHistoryVersion,
  TranscriptHistoryCursor,
  TranscriptHistoryScope,
  TranscriptHistoryVersionSummary,
} from "@/src/services/transcription/history-types";
import { useTheme } from "@/src/theme/ThemeProvider";

import { Button } from "./Button";

const HISTORY_PAGE_SIZE = 25;

type HistorySummary =
  | TranscriptHistoryVersionSummary
  | TranscriptHistoryCloudSummary;

type HistoryOrigin = TranscriptHistoryVersionSummary["version_origin"];

export interface TranscriptHistoryListItem {
  id: string;
  version: number;
  versionOrigin: HistoryOrigin;
  isCurrent: boolean;
  availability: "local" | "cloud";
}

const sameScope = (
  summary: HistorySummary,
  scope: Readonly<TranscriptHistoryScope>,
): boolean =>
  summary.workspace_id === scope.workspaceId &&
  summary.session_id === scope.sessionId;

/**
 * Merge only identity-compatible metadata. A local observation wins the current
 * marker and offline-availability label for the same immutable version.
 */
export const mergeTranscriptHistoryItems = (
  previous: readonly TranscriptHistoryListItem[],
  summaries: readonly HistorySummary[],
  availability: TranscriptHistoryListItem["availability"],
  scope: Readonly<TranscriptHistoryScope>,
): TranscriptHistoryListItem[] => {
  const byId = new Map(previous.map((item) => [item.id, item]));
  const byVersion = new Map(previous.map((item) => [item.version, item]));

  for (const summary of summaries) {
    if (!sameScope(summary, scope)) throw new Error("history scope mismatch");
    const item: TranscriptHistoryListItem = {
      id: summary.id,
      version: summary.version,
      versionOrigin: summary.version_origin,
      isCurrent: summary.is_current,
      availability,
    };
    const matchingId = byId.get(item.id);
    const matchingVersion = byVersion.get(item.version);
    if (
      (matchingId &&
        (matchingId.version !== item.version ||
          matchingId.versionOrigin !== item.versionOrigin)) ||
      (matchingVersion && matchingVersion.id !== item.id)
    ) {
      throw new Error("history identity conflict");
    }

    if (!matchingId) {
      byId.set(item.id, item);
      byVersion.set(item.version, item);
      continue;
    }

    const localWins =
      matchingId.availability === "local" || availability === "local";
    const merged = localWins && availability !== "local"
      ? matchingId
      : {
          ...matchingId,
          isCurrent: item.isCurrent,
          availability: localWins ? "local" as const : "cloud" as const,
        };
    byId.set(item.id, merged);
    byVersion.set(item.version, merged);
  }

  const merged = [...byId.values()].sort(
    (left, right) => right.version - left.version,
  );
  const preferredCurrent =
    merged.find((item) => item.availability === "local" && item.isCurrent) ??
    merged.find((item) => item.isCurrent) ??
    null;
  return preferredCurrent
    ? merged.map((item) => ({
        ...item,
        isCurrent: item.id === preferredCurrent.id,
      }))
    : merged;
};

export const historyCacheMessageKey = (
  result: HistoryCacheResult | null,
): string => {
  if (!result) return "history.notCached";
  switch (result.kind) {
    case "not_ready":
      return "history.notReady";
    case "unavailable":
      return "history.unavailable";
    case "deferred_to_result_sync":
      return "history.resultSyncPending";
    case "retryable":
      return "history.retryable";
    case "indeterminate":
      return "history.unconfirmed";
    case "rejected":
      return result.code === "HISTORY_CACHE_AUTH_REQUIRED"
        ? "history.authRequired"
        : "history.unavailable";
    default:
      return "history.notCached";
  }
};

const historyRestoreErrorKeys: Record<
  TranscriptHistoryRestoreErrorCode,
  string
> = {
  HISTORY_RESTORE_INPUT_INVALID: "history.restore.errors.invalid",
  HISTORY_RESTORE_NATIVE_ONLY: "history.restore.errors.nativeOnly",
  HISTORY_RESTORE_AUTH_REQUIRED: "history.restore.errors.auth",
  HISTORY_RESTORE_CONTEXT_INACTIVE: "history.restore.errors.inactive",
  HISTORY_RESTORE_DELETION_PENDING: "history.restore.errors.deletion",
  HISTORY_RESTORE_STORAGE_UNAVAILABLE: "history.restore.errors.storage",
  HISTORY_RESTORE_SESSION_UNAVAILABLE: "history.restore.errors.session",
  HISTORY_RESTORE_CACHE_INVALID: "history.restore.errors.cache",
  HISTORY_RESTORE_SOURCE_INVALID: "history.restore.errors.source",
  HISTORY_RESTORE_SOURCE_UNAVAILABLE: "history.restore.errors.sourceUnavailable",
  HISTORY_RESTORE_SOURCE_CHANGED: "history.restore.errors.sourceChanged",
  HISTORY_RESTORE_CHECKSUM_MISMATCH: "history.restore.errors.checksum",
  HISTORY_RESTORE_HASH_UNAVAILABLE: "history.restore.errors.hash",
  HISTORY_RESTORE_CURRENT_UNAVAILABLE: "history.restore.errors.current",
  HISTORY_RESTORE_DRAFT_EXISTS: "history.restore.errors.draftExists",
  HISTORY_RESTORE_OPERATION_PENDING: "history.restore.errors.pending",
  HISTORY_RESTORE_OUTCOME_UNCONFIRMED: "history.restore.errors.unconfirmed",
  HISTORY_RESTORE_REFRESH_REQUIRED: "history.restore.errors.refresh",
  HISTORY_RESTORE_UNCHANGED: "history.restore.errors.unchanged",
  HISTORY_RESTORE_WRITE_FAILED: "history.restore.errors.writeFailed",
};

export const historyRestoreErrorKey = (code: unknown): string =>
  typeof code === "string" &&
  Object.prototype.hasOwnProperty.call(historyRestoreErrorKeys, code)
    ? historyRestoreErrorKeys[code as TranscriptHistoryRestoreErrorCode]
    : "history.restore.errors.unknown";

interface Props {
  scope: Readonly<TranscriptHistoryScope>;
  onClosed: () => void;
  onRestoreDraftPrepared?: (result: TranscriptHistoryRestoreDraftResult) => void;
}

type HistoryReader = ReturnType<typeof createLocalTranscriptHistoryReader>;

/**
 * Explicit history browser. Historical rows remain read-only. After a separate
 * confirmation, restore copies one exact historical Full Text into a guarded
 * local draft; it never promotes a version, queues Save, polls, or registers a
 * background coordinator.
 */
export function TranscriptHistoryModal({
  scope,
  onClosed,
  onRestoreDraftPrepared,
}: Props) {
  const { t } = useI18n();
  const { colors, spacing, radii, typography, layout } = useTheme();
  const onClosedRef = useRef(onClosed);
  const onRestoreDraftPreparedRef = useRef(onRestoreDraftPrepared);
  const lifetime = useRef({ active: false, generation: 0, closed: false });
  const readerRef = useRef<HistoryReader | null>(null);
  const cloudAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const detailRequestRef = useRef(0);
  const restoreRequestRef = useRef(0);
  const restorePendingRef = useRef(false);
  const restoreDialogRef = useRef({ open: false, token: 0 });
  const loadingMoreRef = useRef(false);
  const itemsRef = useRef<TranscriptHistoryListItem[]>([]);
  const localCursorRef = useRef<TranscriptHistoryCursor | null>(null);
  const cloudCursorRef = useRef<TranscriptHistoryCloudCursor | null>(null);
  const cloudExhaustedRef = useRef(false);
  const cloudFailedRef = useRef(false);

  const [items, setItems] = useState<TranscriptHistoryListItem[]>([]);
  const [localCursor, setLocalCursor] =
    useState<TranscriptHistoryCursor | null>(null);
  const [cloudCursor, setCloudCursor] =
    useState<TranscriptHistoryCloudCursor | null>(null);
  const [cloudExhausted, setCloudExhausted] = useState(false);
  const [localLoading, setLocalLoading] = useState(true);
  const [cloudLoading, setCloudLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [localError, setLocalError] = useState(false);
  const [cloudError, setCloudError] = useState(false);
  const [selected, setSelected] =
    useState<TranscriptHistoryListItem | null>(null);
  const [detail, setDetail] =
    useState<LocalTranscriptHistoryVersion | null>(null);
  const [cacheResult, setCacheResult] = useState<HistoryCacheResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreErrorCode, setRestoreErrorCode] =
    useState<TranscriptHistoryRestoreErrorCode | null>(null);

  useEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);
  useEffect(() => {
    onRestoreDraftPreparedRef.current = onRestoreDraftPrepared;
  }, [onRestoreDraftPrepared]);

  const isActive = useCallback((generation: number): boolean => {
    const current = lifetime.current;
    return current.active && !current.closed && current.generation === generation;
  }, []);

  const appendItems = useCallback((
    summaries: readonly HistorySummary[],
    availability: TranscriptHistoryListItem["availability"],
    normalizedScope: Readonly<TranscriptHistoryScope>,
    generation: number,
  ): void => {
    if (!isActive(generation)) return;
    const next = mergeTranscriptHistoryItems(
      itemsRef.current,
      summaries,
      availability,
      normalizedScope,
    );
    itemsRef.current = next;
    setItems(next);
  }, [isActive]);

  const loadLocalPage = useCallback(async (
    reader: HistoryReader,
    cursor: TranscriptHistoryCursor | null,
    generation: number,
  ): Promise<void> => {
    const page = await reader.listPage({ pageSize: HISTORY_PAGE_SIZE, cursor });
    if (!isActive(generation)) return;
    appendItems(page.versions, "local", reader.scope, generation);
    localCursorRef.current = page.nextCursor;
    setLocalCursor(page.nextCursor);
  }, [appendItems, isActive]);

  const loadCloudPage = useCallback(async (
    normalizedScope: Readonly<TranscriptHistoryScope>,
    cursor: TranscriptHistoryCloudCursor | null,
    generation: number,
  ): Promise<void> => {
    cloudAbortRef.current?.abort();
    const controller = new AbortController();
    cloudAbortRef.current = controller;
    try {
      const page = await fetchTranscriptHistoryPage({
        scope: normalizedScope,
        pageSize: HISTORY_PAGE_SIZE,
        cursor,
        signal: controller.signal,
        isContextActive: () => isActive(generation),
      });
      if (!isActive(generation)) return;
      appendItems(page.versions, "cloud", normalizedScope, generation);
      cloudCursorRef.current = page.nextCursor;
      cloudExhaustedRef.current = page.visibleWindowExhausted;
      cloudFailedRef.current = false;
      setCloudCursor(page.nextCursor);
      setCloudExhausted(page.visibleWindowExhausted);
      setCloudError(false);
    } finally {
      if (cloudAbortRef.current === controller) cloudAbortRef.current = null;
    }
  }, [appendItems, isActive]);

  useEffect(() => {
    const generation = lifetime.current.generation + 1;
    lifetime.current = { active: true, generation, closed: false };
    itemsRef.current = [];
    localCursorRef.current = null;
    cloudCursorRef.current = null;
    cloudExhaustedRef.current = false;
    cloudFailedRef.current = false;
    loadingMoreRef.current = false;
    detailRequestRef.current += 1;
    restoreRequestRef.current += 1;
    restorePendingRef.current = false;
    restoreDialogRef.current.open = false;
    restoreDialogRef.current.token += 1;
    setItems([]);
    setLocalCursor(null);
    setCloudCursor(null);
    setCloudExhausted(false);
    setLocalLoading(true);
    setCloudLoading(true);
    setLoadingMore(false);
    setLocalError(false);
    setCloudError(false);
    setSelected(null);
    setDetail(null);
    setCacheResult(null);
    setDetailLoading(false);
    setDetailError(false);
    setRestoreLoading(false);
    setRestoreErrorCode(null);

    let reader: HistoryReader;
    try {
      reader = createLocalTranscriptHistoryReader(scope, {
        isContextActive: () => isActive(generation),
      });
      readerRef.current = reader;
    } catch {
      setLocalError(true);
      setCloudError(false);
      setLocalLoading(false);
      setCloudLoading(false);
      return () => {
        lifetime.current.active = false;
        lifetime.current.generation += 1;
      };
    }

    void (async () => {
      try {
        await loadLocalPage(reader, null, generation);
      } catch {
        if (isActive(generation)) setLocalError(true);
      } finally {
        if (isActive(generation)) setLocalLoading(false);
      }
    })();
    void (async () => {
      try {
        await loadCloudPage(reader.scope, null, generation);
      } catch {
        if (isActive(generation)) {
          cloudFailedRef.current = true;
          setCloudError(true);
        }
      } finally {
        if (isActive(generation)) setCloudLoading(false);
      }
    })();

    const restoreDialog = restoreDialogRef.current;
    return () => {
      const current = lifetime.current;
      if (current.generation === generation) {
        current.active = false;
        current.generation += 1;
      }
      detailRequestRef.current += 1;
      restoreRequestRef.current += 1;
      restoreDialog.open = false;
      restoreDialog.token += 1;
      cloudAbortRef.current?.abort();
      detailAbortRef.current?.abort();
      if (readerRef.current === reader) {
        reader.dispose();
        readerRef.current = null;
      }
    };
  }, [isActive, loadCloudPage, loadLocalPage, scope]);

  const retire = useCallback((): boolean => {
    const current = lifetime.current;
    if (!current.active || current.closed) return false;
    current.closed = true;
    current.active = false;
    current.generation += 1;
    detailRequestRef.current += 1;
    restoreRequestRef.current += 1;
    restorePendingRef.current = false;
    restoreDialogRef.current.open = false;
    restoreDialogRef.current.token += 1;
    cloudAbortRef.current?.abort();
    detailAbortRef.current?.abort();
    readerRef.current?.dispose();
    readerRef.current = null;
    return true;
  }, []);

  const close = useCallback((): void => {
    if (retire()) onClosedRef.current();
  }, [retire]);

  const backToList = useCallback((): void => {
    detailRequestRef.current += 1;
    restoreRequestRef.current += 1;
    restorePendingRef.current = false;
    restoreDialogRef.current.open = false;
    restoreDialogRef.current.token += 1;
    detailAbortRef.current?.abort();
    detailAbortRef.current = null;
    setSelected(null);
    setDetail(null);
    setCacheResult(null);
    setDetailLoading(false);
    setDetailError(false);
    setRestoreLoading(false);
    setRestoreErrorCode(null);
  }, []);

  const openVersion = useCallback(async (
    item: TranscriptHistoryListItem,
  ): Promise<void> => {
    const reader = readerRef.current;
    const generation = lifetime.current.generation;
    if (!reader || !isActive(generation)) return;
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    restoreRequestRef.current += 1;
    restorePendingRef.current = false;
    restoreDialogRef.current.open = false;
    restoreDialogRef.current.token += 1;
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    setSelected(item);
    setDetail(null);
    setCacheResult(null);
    setDetailError(false);
    setDetailLoading(true);
    setRestoreLoading(false);
    setRestoreErrorCode(null);
    try {
      const result: TranscriptHistoryHydrationResult = await reader.hydrateVersion({
        versionId: item.id,
        expectedVersion: item.version,
        signal: controller.signal,
      });
      if (!isActive(generation) || detailRequestRef.current !== requestId) return;
      if (result.detail.kind === "ready") {
        const next = mergeTranscriptHistoryItems(
          itemsRef.current,
          [result.detail.version],
          "local",
          reader.scope,
        );
        itemsRef.current = next;
        setItems(next);
        setSelected(next.find((current) => current.id === item.id) ?? item);
      }
      setDetail(result.detail);
      setCacheResult(result.cacheResult ? { ...result.cacheResult } : null);
    } catch {
      if (
        isActive(generation) &&
        detailRequestRef.current === requestId &&
        !controller.signal.aborted
      ) {
        setDetailError(true);
      }
    } finally {
      if (detailAbortRef.current === controller) detailAbortRef.current = null;
      if (isActive(generation) && detailRequestRef.current === requestId) {
        setDetailLoading(false);
      }
    }
  }, [isActive]);

  const prepareRestoreDraft = useCallback(async (
    source: Extract<LocalTranscriptHistoryVersion, { kind: "ready" }>,
    generation: number,
  ): Promise<void> => {
    if (
      source.version.is_current ||
      restorePendingRef.current ||
      !onRestoreDraftPreparedRef.current ||
      !isActive(generation)
    ) return;

    const requestId = restoreRequestRef.current + 1;
    restoreRequestRef.current = requestId;
    restorePendingRef.current = true;
    setRestoreErrorCode(null);
    setRestoreLoading(true);
    const assertActive = (): void => {
      if (!isActive(generation) || restoreRequestRef.current !== requestId) {
        throw new Error("history restore context inactive");
      }
    };

    try {
      const result = await prepareTranscriptHistoryRestoreDraft({
        scope,
        sourceVersionId: source.version.id,
        sourceVersionNumber: source.version.version,
        sourcePlainText: source.rawPlainText,
        sourceContentChecksumSha256:
          source.version.content_checksum_sha256,
        assertActive,
      });
      assertActive();
      const callback = onRestoreDraftPreparedRef.current;
      if (!callback) {
        if (retire()) onClosedRef.current();
        return;
      }
      if (!retire()) return;
      // The service has acknowledged the durable draft. A parent callback
      // failure cannot honestly turn that commit into a restore failure.
      try {
        callback(result);
      } catch {
        try {
          onClosedRef.current();
        } catch {
          // The durable draft remains discoverable by the next editor owner.
        }
      }
    } catch (failure) {
      if (isActive(generation) && restoreRequestRef.current === requestId) {
        setRestoreErrorCode(
          normalizeTranscriptHistoryRestoreFailure(failure).code,
        );
      }
    } finally {
      if (restoreRequestRef.current === requestId) {
        restorePendingRef.current = false;
      }
      if (isActive(generation) && restoreRequestRef.current === requestId) {
        setRestoreLoading(false);
      }
    }
  }, [isActive, retire, scope]);

  const requestRestore = useCallback((): void => {
    if (
      detail?.kind !== "ready" ||
      detail.version.is_current ||
      restoreLoading ||
      restorePendingRef.current ||
      restoreDialogRef.current.open ||
      !onRestoreDraftPreparedRef.current
    ) return;
    const generation = lifetime.current.generation;
    if (!isActive(generation)) return;
    const source: Extract<LocalTranscriptHistoryVersion, { kind: "ready" }> = {
      ...detail,
      scope: { ...detail.scope },
      version: { ...detail.version },
    };
    restoreDialogRef.current.open = true;
    const dialogToken = restoreDialogRef.current.token + 1;
    restoreDialogRef.current.token = dialogToken;
    const valid = (): boolean =>
      isActive(generation) &&
      restoreDialogRef.current.open &&
      restoreDialogRef.current.token === dialogToken;
    const dismiss = (): void => {
      if (valid()) restoreDialogRef.current.open = false;
    };

    try {
      Alert.alert(
        t("session", "history.restore.confirmTitle", {
          version: source.version.version,
        }),
        t("session", "history.restore.confirmBody"),
        [
          {
            text: t("common", "actions.cancel"),
            style: "cancel",
            onPress: dismiss,
          },
          {
            text: t("session", "history.restore.confirmAction"),
            onPress: () => {
              if (!valid()) return;
              restoreDialogRef.current.open = false;
              void prepareRestoreDraft(source, generation);
            },
          },
        ],
        { cancelable: true, onDismiss: dismiss },
      );
    } catch {
      restoreDialogRef.current.open = false;
      setRestoreErrorCode("HISTORY_RESTORE_WRITE_FAILED");
    }
  }, [detail, isActive, prepareRestoreDraft, restoreLoading, t]);

  const loadMorePages = useCallback(async (): Promise<void> => {
    const reader = readerRef.current;
    const generation = lifetime.current.generation;
    if (!reader || !isActive(generation) || loadingMoreRef.current) return;
    if (
      !localCursorRef.current &&
      (cloudFailedRef.current || cloudExhaustedRef.current || !cloudCursorRef.current)
    ) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      if (localCursorRef.current) {
        try {
          await loadLocalPage(reader, localCursorRef.current, generation);
          if (isActive(generation)) setLocalError(false);
        } catch {
          if (isActive(generation)) setLocalError(true);
        }
      }
      if (!isActive(generation)) return;
      if (
        !cloudFailedRef.current &&
        !cloudExhaustedRef.current &&
        cloudCursorRef.current
      ) {
        try {
          await loadCloudPage(reader.scope, cloudCursorRef.current, generation);
        } catch {
          if (isActive(generation)) {
            cloudFailedRef.current = true;
            setCloudError(true);
          }
        }
      }
    } finally {
      loadingMoreRef.current = false;
      if (isActive(generation)) setLoadingMore(false);
    }
  }, [isActive, loadCloudPage, loadLocalPage]);

  const retryCloud = useCallback(async (): Promise<void> => {
    const reader = readerRef.current;
    const generation = lifetime.current.generation;
    if (!reader || !isActive(generation) || cloudLoading) return;
    setCloudLoading(true);
    cloudFailedRef.current = false;
    try {
      await loadCloudPage(reader.scope, cloudCursorRef.current, generation);
    } catch {
      if (isActive(generation)) {
        cloudFailedRef.current = true;
        setCloudError(true);
      }
    } finally {
      if (isActive(generation)) setCloudLoading(false);
    }
  }, [cloudLoading, isActive, loadCloudPage]);

  const originLabel = (origin: HistoryOrigin): string =>
    t("session", `history.origin.${origin}`);
  const availabilityLabel = (
    availability: TranscriptHistoryListItem["availability"],
  ): string => t("session", availability === "local"
    ? "history.availableLocal"
    : "history.availableCloud");
  const canLoadMore =
    localCursor !== null ||
    (!cloudError && !cloudExhausted && cloudCursor !== null);
  const selectedMessage = detail?.kind === "not_cached"
    ? historyCacheMessageKey(cacheResult)
    : null;

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={close}
      testID="transcript-history-modal"
    >
      <SafeAreaView
        edges={["top", "bottom", "left", "right"]}
        style={{ flex: 1, backgroundColor: colors.background }}
      >
        <View
          style={{
            padding: spacing.md,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <Text
            accessibilityRole="header"
            style={[typography.title, { color: colors.textPrimary }]}
          >
            {t("session", "history.title")}
          </Text>
          <Text style={[typography.caption, { color: colors.textSecondary }]}>
            {t("session", "history.subtitle")}
          </Text>
        </View>

        {selected ? (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          >
            <Button
              testID="transcript-history-back"
              label={t("session", "history.back")}
              variant="ghost"
              onPress={backToList}
            />
            <Text
              testID="transcript-history-selected-version"
              style={[typography.headline, { color: colors.textPrimary }]}
            >
              {t("session", "history.version", { version: selected.version })}
            </Text>
            <Text style={[typography.caption, { color: colors.textSecondary }]}>
              {originLabel(selected.versionOrigin)} • {availabilityLabel(selected.availability)}
              {selected.isCurrent ? ` • ${t("session", "history.current")}` : ""}
            </Text>
            <Text style={[typography.caption, { color: colors.textSecondary }]}>
              {t("session", "history.readOnly")}
            </Text>

            {detailLoading ? (
              <Text
                testID="transcript-history-detail-loading"
                accessibilityLiveRegion="polite"
                style={[typography.caption, { color: colors.textSecondary }]}
              >
                {t("session", "history.loadingVersion")}
              </Text>
            ) : null}
            {detailError ? (
              <Text
                testID="transcript-history-detail-error"
                accessibilityRole="alert"
                style={[typography.caption, { color: colors.recording }]}
              >
                {t("session", "history.detailFailed")}
              </Text>
            ) : null}
            {detail?.kind === "ready" && detail.rawPlainText.length > 0 ? (
              <Text
                selectable
                testID="transcript-history-detail-text"
                style={[typography.body, { color: colors.textPrimary }]}
              >
                {detail.rawPlainText}
              </Text>
            ) : null}
            {detail?.kind === "ready" && detail.rawPlainText.length === 0 ? (
              <Text
                testID="transcript-history-detail-empty"
                style={[typography.body, { color: colors.textSecondary }]}
              >
                {t("session", "history.emptyText")}
              </Text>
            ) : null}
            {!detailLoading && !detailError && selectedMessage ? (
              <Text
                testID="transcript-history-detail-status"
                accessibilityRole="alert"
                style={[typography.body, { color: colors.textSecondary }]}
              >
                {t("session", selectedMessage)}
              </Text>
            ) : null}
            {!detailLoading && (detailError || detail?.kind === "not_cached") ? (
              <Button
                testID="transcript-history-retry-version"
                label={t("session", "history.retryVersion")}
                variant="secondary"
                onPress={() => {
                  void openVersion(selected);
                }}
              />
            ) : null}
            {restoreErrorCode ? (
              <Text
                testID="transcript-history-restore-error"
                accessibilityRole="alert"
                style={[typography.body, { color: colors.recording }]}
              >
                {t("session", historyRestoreErrorKey(restoreErrorCode))}
              </Text>
            ) : null}
            {
              detail?.kind === "ready" &&
              detail.rawPlainText.trim().length > 0 &&
              !detail.version.is_current &&
              onRestoreDraftPrepared
                ? (
                    <View style={{ gap: spacing.xs }}>
                      <Text
                        style={[
                          typography.caption,
                          { color: colors.textSecondary },
                        ]}
                      >
                        {t("session", "history.restore.hint")}
                      </Text>
                      <Button
                        testID="transcript-history-restore-draft"
                        label={t("session", "history.restore.action")}
                        variant="secondary"
                        loading={restoreLoading}
                        disabled={restoreLoading}
                        onPress={requestRestore}
                      />
                    </View>
                  )
                : null
            }
          </ScrollView>
        ) : (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          >
            {localLoading ? (
              <Text
                testID="transcript-history-local-loading"
                accessibilityLiveRegion="polite"
                style={[typography.caption, { color: colors.textSecondary }]}
              >
                {t("session", "history.loadingLocal")}
              </Text>
            ) : null}
            {items.map((item) => (
              <TouchableOpacity
                key={item.id}
                testID={`transcript-history-version-${item.id}`}
                accessibilityRole="button"
                accessibilityLabel={t("session", "history.version", {
                  version: item.version,
                })}
                onPress={() => {
                  void openVersion(item);
                }}
                style={{
                  minHeight: layout.minTouchTarget,
                  padding: spacing.sm,
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: radii.md,
                  backgroundColor: colors.surface,
                  justifyContent: "center",
                }}
              >
                <Text
                  testID={`transcript-history-version-label-${item.id}`}
                  style={[typography.bodyMedium, { color: colors.textPrimary }]}
                >
                  {t("session", "history.version", { version: item.version })}
                </Text>
                <Text
                  testID={`transcript-history-version-availability-${item.id}`}
                  style={[typography.caption, { color: colors.textSecondary }]}
                >
                  {originLabel(item.versionOrigin)} • {availabilityLabel(item.availability)}
                  {item.isCurrent ? ` • ${t("session", "history.current")}` : ""}
                </Text>
              </TouchableOpacity>
            ))}
            {localError ? (
              <Text
                testID="transcript-history-local-error"
                accessibilityRole="alert"
                style={[typography.caption, { color: colors.recording }]}
              >
                {t("session", "history.localUnavailable")}
              </Text>
            ) : null}
            {cloudLoading ? (
              <Text
                testID="transcript-history-cloud-loading"
                accessibilityLiveRegion="polite"
                style={[typography.caption, { color: colors.textSecondary }]}
              >
                {t("session", "history.loadingCloud")}
              </Text>
            ) : null}
            {cloudError ? (
              <View style={{ gap: spacing.xs }}>
                <Text
                  testID="transcript-history-cloud-error"
                  accessibilityRole="alert"
                  style={[typography.caption, { color: colors.warning }]}
                >
                  {t("session", "history.cloudUnavailable")}
                </Text>
                <Button
                  testID="transcript-history-retry-cloud"
                  label={t("session", "history.retryCloud")}
                  variant="secondary"
                  disabled={cloudLoading}
                  onPress={() => {
                    void retryCloud();
                  }}
                />
              </View>
            ) : null}
            {!localLoading && !cloudLoading && !localError && !cloudError && items.length === 0 ? (
              <Text
                testID="transcript-history-empty"
                style={[typography.body, { color: colors.textSecondary }]}
              >
                {t("session", "history.empty")}
              </Text>
            ) : null}
            {canLoadMore ? (
              <Button
                testID="transcript-history-load-more"
                label={t("session", "history.loadMore")}
                variant="secondary"
                loading={loadingMore}
                disabled={loadingMore}
                onPress={() => {
                  void loadMorePages();
                }}
              />
            ) : null}
          </ScrollView>
        )}

        <View
          style={{
            padding: spacing.md,
            borderTopWidth: 1,
            borderTopColor: colors.border,
          }}
        >
          <Button
            testID="transcript-history-close"
            label={t("common", "actions.close")}
            variant="secondary"
            onPress={close}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}
