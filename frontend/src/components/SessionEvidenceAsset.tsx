import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";

import { useI18n } from "@/src/i18n/I18nProvider";
import {
  EvidenceOpenError,
  openEvidenceAsset,
} from "@/src/services/evidence/open-evidence";
import {
  resolveMediaAssetUri,
  retryMediaAssetUpload,
} from "@/src/services/session/service";
import type { MediaAssetRecord } from "@/src/services/sqlite/repository";
import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";
import { formatDurationMs } from "@/src/utils/format";

import { Button } from "./Button";
import { Card } from "./Card";

const statusKey = (status: string): string => {
  const supported = new Set([
    "local_only",
    "pending",
    "uploading",
    "synchronized",
    "failed",
    "cancelled",
  ]);
  return supported.has(status) ? status : "local_only";
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const iconForAsset = (assetType: string): keyof typeof Ionicons.glyphMap => {
  switch (assetType) {
    case "image":
      return "image-outline";
    case "video":
      return "videocam-outline";
    case "document":
      return "document-outline";
    default:
      return "attach-outline";
  }
};

export function SessionEvidenceAsset({
  asset,
  onUpdated,
}: {
  asset: MediaAssetRecord;
  onUpdated?: (asset: MediaAssetRecord) => void;
}) {
  const { t } = useI18n();
  const { colors, spacing, typography, radii } = useTheme();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const [uri, setUri] = useState<string | null>(null);
  const [initializingUri, setInitializingUri] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const assetRef = useRef(asset);
  const uriRef = useRef<string | null>(null);
  const resolvedSourceKeyRef = useRef<string | null>(null);

  assetRef.current = asset;

  // Upload-status and updated-at changes should not force the preview/open
  // control to disappear and reappear. Only re-resolve when an actual URI
  // source changes.
  const sourceKey = [
    asset.id,
    asset.local_file_uri ?? "",
    asset.private_storage_path ?? "",
  ].join("|");

  const loadUri = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;

    const isInitialResolution =
      resolvedSourceKeyRef.current === null && uriRef.current === null;

    if (isInitialResolution) {
      setInitializingUri(true);
    }

    try {
      const nextUri = await resolveMediaAssetUri(assetRef.current);

      if (requestId !== requestRef.current) return;

      uriRef.current = nextUri;
      setUri(nextUri);
      resolvedSourceKeyRef.current = sourceKey;
      setError(null);
    } catch (cause) {
      if (requestId !== requestRef.current) return;

      // Keep an already-resolved local or signed URL visible during a
      // transient background refresh failure. Only surface an error when no
      // usable URI has ever been resolved.
      if (uriRef.current === null) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (requestId === requestRef.current) {
        setInitializingUri(false);
      }
    }
  }, [sourceKey]);

  useEffect(() => {
    void loadUri();

    return () => {
      requestRef.current += 1;
    };
  }, [loadUri]);

  const openAsset = async () => {
    if (!uri || opening) return;

    setOpening(true);
    setError(null);

    try {
      await openEvidenceAsset({
        uri,
        assetId: asset.id,
        fileName: asset.sanitized_file_name || asset.original_file_name,
        mimeType: asset.mime_type,
      });
    } catch (cause) {
      if (cause instanceof EvidenceOpenError) {
        const key =
          cause.code === "EVIDENCE_NOT_AVAILABLE_OFFLINE"
            ? "evidence.offlineUnavailable"
            : cause.code === "EVIDENCE_VIEWER_UNAVAILABLE"
              ? "evidence.viewerUnavailable"
              : "evidence.openFailed";
        setError(t("session", key));
        return;
      }

      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(false);
    }
  };

  const retry = async () => {
    if (!userId || retrying) return;
    setRetrying(true);
    setError(null);
    try {
      const pending = await retryMediaAssetUpload({ asset, userId });
      onUpdated?.(pending);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRetrying(false);
    }
  };

  const statusColor =
    asset.upload_status === "synchronized"
      ? colors.success
      : asset.upload_status === "failed"
        ? colors.recording
        : colors.warning;

  const imageAspectRatio =
    asset.image_width && asset.image_height
      ? asset.image_width / asset.image_height
      : 4 / 3;

  const imageFrameStyle = {
    width: "100%" as const,
    aspectRatio: imageAspectRatio,
    maxHeight: 320,
    borderRadius: radii.md,
    marginTop: spacing.sm,
    backgroundColor: colors.surfaceElevated,
  };

  const showNonImageActionArea =
    asset.asset_type !== "image" &&
    (initializingUri || uri !== null || asset.upload_status === "synchronized");

  return (
    <Card
      testID={`session-evidence-asset-${asset.id}`}
      style={{ marginBottom: spacing.sm }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Ionicons
          name={iconForAsset(asset.asset_type)}
          size={22}
          color={colors.accent}
        />
        <View style={{ flex: 1 }}>
          <Text style={[typography.bodyMedium, { color: colors.textPrimary }]}>
            {asset.original_file_name}
          </Text>
          <Text
            testID={`session-evidence-status-${asset.id}`}
            style={[
              typography.caption,
              { color: statusColor, marginTop: spacing.xxs },
            ]}
          >
            {t("session", `evidence.status.${statusKey(asset.upload_status)}`)}
          </Text>
        </View>
      </View>

      {asset.asset_type === "image" ? (
        uri ? (
          <Image
            testID={`session-evidence-image-${asset.id}`}
            source={{ uri }}
            contentFit="cover"
            transition={150}
            style={imageFrameStyle}
          />
        ) : initializingUri ? (
          <View
            testID={`session-evidence-image-placeholder-${asset.id}`}
            style={[
              imageFrameStyle,
              {
                alignItems: "center",
                justifyContent: "center",
              },
            ]}
          >
            <Text style={[typography.caption, { color: colors.textTertiary }]}>
              {t("common", "status.loading")}
            </Text>
          </View>
        ) : null
      ) : null}

      <Text
        style={[
          typography.caption,
          { color: colors.textTertiary, marginTop: spacing.sm },
        ]}
      >
        {formatBytes(asset.file_size)} • {formatDurationMs(asset.recording_offset_ms)}
      </Text>

      {asset.user_caption ? (
        <Text
          style={[
            typography.body,
            { color: colors.textSecondary, marginTop: spacing.xs },
          ]}
        >
          {asset.user_caption}
        </Text>
      ) : null}

      {showNonImageActionArea ? (
        <View
          style={{
            minHeight: 44,
            marginTop: spacing.sm,
            justifyContent: "center",
          }}
        >
          {initializingUri && !uri ? (
            <Text style={[typography.caption, { color: colors.textTertiary }]}>
              {t("common", "status.loading")}
            </Text>
          ) : uri ? (
            <Button
              testID={`session-evidence-open-${asset.id}`}
              label={t("session", "evidence.open")}
              variant="secondary"
              loading={opening}
              disabled={opening}
              onPress={() => {
                void openAsset();
              }}
            />
          ) : asset.upload_status === "synchronized" ? (
            <Text style={[typography.caption, { color: colors.textTertiary }]}>
              {t("session", "evidence.previewUnavailable")}
            </Text>
          ) : null}
        </View>
      ) : null}

      {asset.asset_type === "image" &&
      !initializingUri &&
      !uri &&
      asset.upload_status === "synchronized" ? (
        <Text
          style={[
            typography.caption,
            { color: colors.textTertiary, marginTop: spacing.sm },
          ]}
        >
          {t("session", "evidence.previewUnavailable")}
        </Text>
      ) : null}

      {asset.upload_status === "failed" &&
      Platform.OS !== "web" &&
      asset.local_file_uri ? (
        <Button
          testID={`session-evidence-retry-${asset.id}`}
          label={t("session", "evidence.retry")}
          variant="secondary"
          loading={retrying}
          disabled={retrying}
          onPress={() => {
            void retry();
          }}
          style={{ marginTop: spacing.sm }}
        />
      ) : null}

      {asset.upload_error_message ? (
        <Text
          accessibilityRole="alert"
          style={[
            typography.caption,
            { color: colors.recording, marginTop: spacing.sm },
          ]}
        >
          {asset.upload_error_message}
        </Text>
      ) : null}

      {error ? (
        <Text
          accessibilityRole="alert"
          style={[
            typography.caption,
            { color: colors.recording, marginTop: spacing.sm },
          ]}
        >
          {error}
        </Text>
      ) : null}
    </Card>
  );
}
