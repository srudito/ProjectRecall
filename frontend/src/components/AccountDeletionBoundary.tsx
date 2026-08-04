import { useRouter } from "expo-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/src/components/Button";
import { Screen } from "@/src/components/Screen";
import { AppError, ErrorCode, type ErrorCodeKey } from "@/src/domain/errors";
import { useI18n } from "@/src/i18n/I18nProvider";
import {
  AccountDeletionClientError,
  getCurrentAccountExistence,
  invokeDeleteAccount,
  isSafeAccountDeletionPreflightBlock,
} from "@/src/services/account-deletion/client";
import { performLocalAccountCleanup } from "@/src/services/account-deletion/local-cleanup";
import { waitForAccountDeletionBackgroundWork } from "@/src/services/account-deletion/quiescence";
import {
  clearAccountDeletionMarker,
  createAccountDeletionMarker,
  getCurrentAccountDeletionMarker,
  loadAccountDeletionMarker,
  resolveAccountDeletionAuthMismatchStatus,
  resolveAccountDeletionLocalCleanupErrorCode,
  resolveAccountDeletionWorkflowFailureMarker,
  saveAccountDeletionMarker,
  updateAccountDeletionMarker,
  type AccountDeletionMarker,
} from "@/src/services/account-deletion/state";
import { collectLocalAccountCleanupScope } from "@/src/services/sqlite/repository";
import {
  clearAuthTransientState,
  clearLocalAuthSession,
} from "@/src/services/supabase/auth";
import { resolvePersonalWorkspace } from "@/src/services/workspace/service";
import { useAuthStore } from "@/src/stores/auth-store";
import { useRecordingStore } from "@/src/stores/recording-store";
import { useTheme } from "@/src/theme/ThemeProvider";

interface AccountDeletionContextValue {
  initialized: boolean;
  pending: boolean;
  beginDeletion: (userId: string) => Promise<void>;
}

const AccountDeletionContext = createContext<
  AccountDeletionContextValue | undefined
>(undefined);

// Preserve one workflow across route/root remounts in the same JS process.
// The durable marker remains the source of truth across process restarts.
let activeWorkflow: Promise<void> | null = null;

const uniqueStrings = (values: readonly string[]): string[] =>
  [...new Set(values.filter(Boolean))].sort();

const isReauthenticationError = (code: string): boolean =>
  code === ErrorCode.ACCOUNT_DELETION_REAUTHENTICATION_REQUIRED ||
  code === ErrorCode.ACCOUNT_DELETION_INVALID_SESSION;

function AccountDeletionStatusScreen({
  marker,
  onRetry,
  onReturnToProfile,
  onSignOut,
  onContinueAfterUnverifiedCleanup,
}: {
  marker: AccountDeletionMarker;
  onRetry: () => void;
  onReturnToProfile: () => void;
  onSignOut: () => void;
  onContinueAfterUnverifiedCleanup: () => void;
}) {
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();

  const isServerDeleted =
    marker.status === "server_deleted_local_cleanup_pending";
  const isBlocked = marker.status === "blocked";
  const isReauth = marker.status === "reauthentication_required";
  const isCleanupFailed = marker.status === "local_cleanup_failed";
  const isRetryable = marker.status === "retryable_error";
  const isUnverifiedCleanupPending =
    marker.status ===
    "server_outcome_unverified_local_cleanup_pending";
  const isUnverifiedCleanupComplete =
    marker.status === "local_cleanup_complete_server_unverified";

  const title = isUnverifiedCleanupComplete
    ? t("profile", "deleteAccount.unverifiedCompleteTitle")
    : isUnverifiedCleanupPending
      ? t("profile", "deleteAccount.unverifiedCleanupTitle")
      : isServerDeleted
        ? t("profile", "deleteAccount.cleanupTitle")
        : isBlocked
          ? t("profile", "deleteAccount.blockedTitle")
          : isReauth
            ? t("profile", "deleteAccount.reauthTitle")
            : isCleanupFailed
              ? t("profile", "deleteAccount.cleanupFailedTitle")
              : isRetryable
                ? t("profile", "deleteAccount.retryTitle")
                : t("profile", "deleteAccount.progressTitle");

  const body = isUnverifiedCleanupComplete
    ? t("profile", "deleteAccount.unverifiedCompleteBody")
    : isUnverifiedCleanupPending
      ? t("profile", "deleteAccount.unverifiedCleanupBody")
      : isServerDeleted
        ? t("profile", "deleteAccount.cleanupBody")
        : isBlocked
          ? t("profile", "deleteAccount.blockedBody")
          : isReauth
            ? t("profile", "deleteAccount.reauthBody")
            : marker.lastErrorCode
              ? t("errors", marker.lastErrorCode)
              : t("profile", "deleteAccount.progressBody");

  const showSpinner =
    !isBlocked &&
    !isReauth &&
    !isCleanupFailed &&
    !isRetryable &&
    !isUnverifiedCleanupComplete;

  return (
    <Screen testID="account-deletion-status-screen">
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          paddingVertical: spacing.xl,
        }}
      >
        {showSpinner ? (
          <ActivityIndicator
            testID="account-deletion-status-spinner"
            color={colors.accent}
            size="large"
          />
        ) : null}

        <Text
          style={[
            typography.displayMedium,
            {
              color: colors.textPrimary,
              marginTop: spacing.lg,
              textAlign: "center",
            },
          ]}
        >
          {title}
        </Text>
        <Text
          accessibilityRole={
            isBlocked ||
            isReauth ||
            isCleanupFailed ||
            isRetryable ||
            isUnverifiedCleanupComplete
              ? "alert"
              : undefined
          }
          style={[
            typography.body,
            {
              color: colors.textSecondary,
              marginTop: spacing.md,
              textAlign: "center",
            },
          ]}
        >
          {body}
        </Text>

        {isRetryable || isCleanupFailed ? (
          <Button
            testID="account-deletion-retry-button"
            label={t("profile", "deleteAccount.retry")}
            fullWidth
            style={{ marginTop: spacing.xl }}
            onPress={onRetry}
          />
        ) : null}

        {isBlocked ? (
          <Button
            testID="account-deletion-return-button"
            label={t("profile", "deleteAccount.returnToProfile")}
            variant="secondary"
            fullWidth
            style={{ marginTop: spacing.xl }}
            onPress={onReturnToProfile}
          />
        ) : null}

        {isReauth ? (
          <Button
            testID="account-deletion-reauth-button"
            label={t("profile", "deleteAccount.signOut")}
            variant="secondary"
            fullWidth
            style={{ marginTop: spacing.xl }}
            onPress={onSignOut}
          />
        ) : null}

        {isUnverifiedCleanupComplete ? (
          <Button
            testID="account-deletion-unverified-continue-button"
            label={t("profile", "deleteAccount.continueSafely")}
            fullWidth
            style={{ marginTop: spacing.xl }}
            onPress={onContinueAfterUnverifiedCleanup}
          />
        ) : null}
      </View>
    </Screen>
  );
}

function AccountDeletionStateCheckErrorScreen({
  errorCode,
  onRetry,
}: {
  errorCode: ErrorCodeKey;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();

  return (
    <Screen testID="account-deletion-state-check-error-screen">
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          paddingVertical: spacing.xl,
        }}
      >
        <Text
          style={[
            typography.displayMedium,
            { color: colors.textPrimary, textAlign: "center" },
          ]}
        >
          {t("profile", "deleteAccount.stateCheckTitle")}
        </Text>
        <Text
          accessibilityRole="alert"
          style={[
            typography.body,
            {
              color: colors.textSecondary,
              marginTop: spacing.md,
              textAlign: "center",
            },
          ]}
        >
          {t("errors", errorCode)}
        </Text>
        <Button
          testID="account-deletion-state-check-retry-button"
          label={t("profile", "deleteAccount.retry")}
          fullWidth
          style={{ marginTop: spacing.xl }}
          onPress={onRetry}
        />
      </View>
    </Screen>
  );
}

export function AccountDeletionBoundary({
  children,
}: {
  children: ReactNode;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const setSession = useAuthStore((state) => state.setSession);
  const authInitialized = useAuthStore((state) => state.initialized);
  const authUserId = useAuthStore((state) => state.user?.id ?? null);
  const controller = useRecordingStore((state) => state.controller);
  const [initialized, setInitialized] = useState(false);
  const [marker, setMarker] = useState<AccountDeletionMarker | null>(null);
  const [markerLoadError, setMarkerLoadError] =
    useState<ErrorCodeKey | null>(null);
  const mountedRef = useRef(true);

  const reloadMarker = useCallback(async (): Promise<void> => {
    if (mountedRef.current) {
      setInitialized(false);
      setMarkerLoadError(null);
    }

    try {
      const value = await loadAccountDeletionMarker();
      if (mountedRef.current) setMarker(value);
    } catch (cause) {
      if (mountedRef.current) {
        setMarker(null);
        setMarkerLoadError(
          cause instanceof AppError
            ? cause.code
            : ErrorCode.ACCOUNT_DELETION_LOCAL_STATE_FAILED,
        );
      }
    } finally {
      if (mountedRef.current) setInitialized(true);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void reloadMarker();

    return () => {
      mountedRef.current = false;
    };
  }, [reloadMarker]);

  const persistMarker = useCallback(
    async (next: AccountDeletionMarker): Promise<void> => {
      await saveAccountDeletionMarker(next);
      if (mountedRef.current) setMarker(next);
    },
    [],
  );

  const finishLocalCleanup = useCallback(
    async (current: AccountDeletionMarker): Promise<void> => {
      try {
        await controller.discard();
        await waitForAccountDeletionBackgroundWork();
        await performLocalAccountCleanup({
          userId: current.userId,
          workspaceIds: current.workspaceIds,
        });
        queryClient.clear();
        clearAuthTransientState();

        const currentUserId = useAuthStore.getState().user?.id ?? null;
        const shouldClearDeletedSession =
          currentUserId === null || currentUserId === current.userId;
        let routeAfterCleanup: "/(auth)/welcome" | "/(tabs)/home" =
          "/(tabs)/home";

        if (shouldClearDeletedSession) {
          const result = await clearLocalAuthSession(current.userId);
          if (result === "cleared") {
            setSession(null);
            routeAfterCleanup = "/(auth)/welcome";
          }
        }

        if (current.serverDeletionConfirmedAt === null) {
          await persistMarker(
            updateAccountDeletionMarker(current, {
              status: "local_cleanup_complete_server_unverified",
              lastErrorCode: ErrorCode.ACCOUNT_DELETION_NETWORK_FAILED,
            }),
          );
          return;
        }

        // Marker removal is intentionally last. A crash before this point
        // resumes the idempotent local cleanup on the next app launch.
        await clearAccountDeletionMarker();
        if (mountedRef.current) setMarker(null);
        router.replace(routeAfterCleanup);
      } catch (cause) {
        const next = updateAccountDeletionMarker(current, {
          status: "local_cleanup_failed",
          lastErrorCode: resolveAccountDeletionLocalCleanupErrorCode(
            current,
            cause instanceof AppError ? cause.code : null,
          ),
        });
        await persistMarker(next);
      }
    },
    [controller, persistMarker, queryClient, router, setSession],
  );

  const runServerDeletion = useCallback(
    async (current: AccountDeletionMarker): Promise<void> => {
      const currentAuth = useAuthStore.getState();
      if (
        !currentAuth.initialized ||
        currentAuth.user?.id !== current.userId
      ) {
        const status = resolveAccountDeletionAuthMismatchStatus(current);
        await persistMarker(
          updateAccountDeletionMarker(current, {
            status,
            lastErrorCode: current.serverRequestStartedAt
              ? ErrorCode.ACCOUNT_DELETION_NETWORK_FAILED
              : ErrorCode.ACCOUNT_DELETION_INVALID_SESSION,
          }),
        );
        return;
      }

      const started = updateAccountDeletionMarker(current, {
        status: "in_progress",
        retryCount: current.retryCount + 1,
        lastErrorCode: null,
        blockers: [],
      });
      await persistMarker(started);
      let requestMarker = started;

      try {
        await controller.discard();
        await waitForAccountDeletionBackgroundWork();
        requestMarker = updateAccountDeletionMarker(started, {
          serverRequestStartedAt:
            started.serverRequestStartedAt ?? new Date().toISOString(),
        });
        await persistMarker(requestMarker);
        await invokeDeleteAccount(current.userId);
        await persistMarker(
          updateAccountDeletionMarker(requestMarker, {
            status: "server_deleted_local_cleanup_pending",
            serverDeletionConfirmedAt: new Date().toISOString(),
            lastErrorCode: null,
            blockers: [],
          }),
        );
      } catch (cause) {
        if (
          cause instanceof AppError &&
          !(cause instanceof AccountDeletionClientError)
        ) {
          await persistMarker(
            updateAccountDeletionMarker(requestMarker, {
              status: "retryable_error",
              lastErrorCode: cause.code,
            }),
          );
          return;
        }

        const existence = await getCurrentAccountExistence(
          current.userId,
        );

        if (existence === "missing") {
          await persistMarker(
            updateAccountDeletionMarker(requestMarker, {
              status: "server_deleted_local_cleanup_pending",
              serverDeletionConfirmedAt: new Date().toISOString(),
              lastErrorCode: null,
              blockers: [],
            }),
          );
          return;
        }

        if (cause instanceof AccountDeletionClientError) {
          if (isSafeAccountDeletionPreflightBlock(cause)) {
            await persistMarker(
              updateAccountDeletionMarker(requestMarker, {
                status: "blocked",
                serverRequestStartedAt: null,
                lastErrorCode: cause.code,
                blockers: [...cause.blockers],
              }),
            );
            return;
          }

          if (
            cause.gateActive === false &&
            isReauthenticationError(cause.code)
          ) {
            const status = resolveAccountDeletionAuthMismatchStatus(current);
            await persistMarker(
              updateAccountDeletionMarker(requestMarker, {
                status,
                serverRequestStartedAt:
                  status === "reauthentication_required"
                    ? null
                    : requestMarker.serverRequestStartedAt,
                lastErrorCode:
                  status === "reauthentication_required"
                    ? cause.code
                    : ErrorCode.ACCOUNT_DELETION_NETWORK_FAILED,
              }),
            );
            return;
          }

          if (existence === "session_changed") {
            await persistMarker(
              updateAccountDeletionMarker(requestMarker, {
                status:
                  "server_outcome_unverified_local_cleanup_pending",
                lastErrorCode: cause.code,
              }),
            );
            return;
          }

          await persistMarker(
            updateAccountDeletionMarker(requestMarker, {
              status: "retryable_error",
              lastErrorCode: cause.code,
            }),
          );
          return;
        }

        await persistMarker(
          updateAccountDeletionMarker(requestMarker, {
            status: "retryable_error",
            lastErrorCode: ErrorCode.ACCOUNT_DELETION_NETWORK_FAILED,
          }),
        );
      }
    },
    [controller, persistMarker],
  );

  useEffect(() => {
    if (
      !initialized ||
      !authInitialized ||
      !marker ||
      activeWorkflow
    ) {
      return;
    }

    if (
      marker.status !== "requested" &&
      marker.status !== "in_progress" &&
      marker.status !== "server_deleted_local_cleanup_pending" &&
      marker.status !==
        "server_outcome_unverified_local_cleanup_pending"
    ) {
      return;
    }

    activeWorkflow = (async () => {
      if (
        marker.status === "server_deleted_local_cleanup_pending" ||
        marker.status ===
          "server_outcome_unverified_local_cleanup_pending"
      ) {
        await finishLocalCleanup(marker);
        return;
      }

      await runServerDeletion(marker);
      const latest = getCurrentAccountDeletionMarker();
      if (
        latest?.status === "server_deleted_local_cleanup_pending" ||
        latest?.status ===
          "server_outcome_unverified_local_cleanup_pending"
      ) {
        await finishLocalCleanup(latest);
      }
    })()
      .catch(() => {
        // A marker-storage failure must never become an unhandled rejection or
        // remount private UI. Keep an in-memory retry screen; the last durable
        // marker remains available for crash recovery on the next launch.
        if (mountedRef.current) {
          setMarker(
            resolveAccountDeletionWorkflowFailureMarker(marker),
          );
        }
      })
      .finally(() => {
        activeWorkflow = null;
      });
  }, [
    authInitialized,
    finishLocalCleanup,
    initialized,
    marker,
    runServerDeletion,
  ]);

  const beginDeletion = useCallback(
    async (userId: string): Promise<void> => {
      if (marker) return;
      if (!userId || authUserId !== userId || !authInitialized) {
        throw new AppError(ErrorCode.ACCOUNT_DELETION_INVALID_SESSION);
      }

      const localScope = await collectLocalAccountCleanupScope(userId);
      const workspaceIds = [...localScope.workspaceIds];
      try {
        const personalWorkspace = await resolvePersonalWorkspace(userId);
        workspaceIds.push(personalWorkspace.id);
      } catch {
        // The server performs the authoritative ownership preflight. The local
        // cleanup can still scope itself from SQLite if workspace resolution
        // is temporarily unavailable.
      }

      const next = createAccountDeletionMarker({
        userId,
        workspaceIds: uniqueStrings(workspaceIds),
      });
      await persistMarker(next);
    },
    [authInitialized, authUserId, marker, persistMarker],
  );

  const retry = useCallback(() => {
    if (!marker) return;
    const status =
      marker.status === "local_cleanup_failed"
        ? marker.serverDeletionConfirmedAt
          ? "server_deleted_local_cleanup_pending"
          : marker.serverRequestStartedAt
            ? "server_outcome_unverified_local_cleanup_pending"
            : "requested"
        : "requested";
    void persistMarker(
      updateAccountDeletionMarker(marker, {
        status,
        lastErrorCode: null,
      }),
    ).catch(() => {
      // Keep the existing marker visible; a later tap can retry persistence.
    });
  }, [marker, persistMarker]);

  const returnToProfile = useCallback(() => {
    void (async () => {
      try {
        await clearAccountDeletionMarker();
        if (mountedRef.current) setMarker(null);
        router.replace("/(tabs)/profile");
      } catch {
        // Keep the safe blocked screen visible when local marker cleanup fails.
      }
    })();
  }, [router]);

  const signOutForReauthentication = useCallback(() => {
    if (!marker) return;

    void (async () => {
      try {
        if (marker.serverRequestStartedAt) {
          await persistMarker(
            updateAccountDeletionMarker(marker, {
              status:
                "server_outcome_unverified_local_cleanup_pending",
              lastErrorCode: ErrorCode.ACCOUNT_DELETION_NETWORK_FAILED,
            }),
          );
          return;
        }

        queryClient.clear();
        clearAuthTransientState();

        const currentUserId = useAuthStore.getState().user?.id ?? null;
        const shouldClearCurrentSession =
          currentUserId === null || currentUserId === marker.userId;
        let target: "/(auth)/welcome" | "/(tabs)/home" =
          "/(tabs)/home";

        if (shouldClearCurrentSession) {
          const result = await clearLocalAuthSession(marker.userId);
          if (result === "cleared") {
            setSession(null);
            target = "/(auth)/welcome";
          }
        }

        await clearAccountDeletionMarker();
        if (mountedRef.current) setMarker(null);
        router.replace(target);
      } catch {
        // Keep the marker and reauthentication screen so the action is safely
        // retryable instead of revealing private routes.
      }
    })();
  }, [marker, persistMarker, queryClient, router, setSession]);

  const continueAfterUnverifiedCleanup = useCallback(() => {
    if (!marker) return;

    void (async () => {
      try {
        const currentUserId = useAuthStore.getState().user?.id ?? null;
        await clearAccountDeletionMarker();
        if (mountedRef.current) setMarker(null);
        router.replace(
          currentUserId ? "/(tabs)/home" : "/(auth)/welcome",
        );
      } catch {
        // Keep the privacy boundary visible until the user can safely
        // acknowledge the unverified cloud outcome.
      }
    })();
  }, [marker, router]);

  const contextValue = useMemo<AccountDeletionContextValue>(
    () => ({
      initialized,
      pending: marker !== null,
      beginDeletion,
    }),
    [beginDeletion, initialized, marker],
  );

  if (!initialized || !authInitialized) {
    return (
      <Screen testID="account-deletion-initializing-screen">
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ActivityIndicator />
        </View>
      </Screen>
    );
  }

  if (markerLoadError) {
    return (
      <AccountDeletionStateCheckErrorScreen
        errorCode={markerLoadError}
        onRetry={() => {
          void reloadMarker();
        }}
      />
    );
  }

  return (
    <AccountDeletionContext.Provider value={contextValue}>
      {marker ? (
        <AccountDeletionStatusScreen
          marker={marker}
          onRetry={retry}
          onReturnToProfile={returnToProfile}
          onSignOut={signOutForReauthentication}
          onContinueAfterUnverifiedCleanup={
            continueAfterUnverifiedCleanup
          }
        />
      ) : (
        children
      )}
    </AccountDeletionContext.Provider>
  );
}

export const useAccountDeletion = (): AccountDeletionContextValue => {
  const value = useContext(AccountDeletionContext);
  if (!value) {
    throw new Error(
      "useAccountDeletion must be used inside AccountDeletionBoundary",
    );
  }
  return value;
};
