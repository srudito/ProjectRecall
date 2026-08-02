import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Text,
  View,
} from "react-native";

import { Button } from "@/src/components/Button";
import { Screen } from "@/src/components/Screen";
import { AppError } from "@/src/domain/errors";
import { useI18n } from "@/src/i18n/I18nProvider";
import {
  getPasswordRecoveryCallbackKey,
  isActionablePasswordRecoveryCallbackUrl,
  selectPasswordRecoveryCallbackUrl,
} from "@/src/services/auth/password-recovery-callback";
import { completePasswordRecoveryFromUrl } from "@/src/services/supabase/auth";
import { useTheme } from "@/src/theme/ThemeProvider";

WebBrowser.maybeCompleteAuthSession();

const CALLBACK_CAPTURE_TIMEOUT_MS = 3_000;

interface PasswordRecoveryCallbackHandlerProps {
  routeCallbackUrl?: string | null;
}

export function PasswordRecoveryCallbackHandler({
  routeCallbackUrl = null,
}: PasswordRecoveryCallbackHandlerProps) {
  const router = useRouter();
  const linkingUrl = Linking.useURL();
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const [initialUrl, setInitialUrl] = useState<string | null>(null);
  const [eventUrl, setEventUrl] = useState<string | null>(null);
  const [captureExpired, setCaptureExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptedCallbackKeyRef = useRef<string | null>(null);

  const actionableUrl = useMemo(
    () =>
      selectPasswordRecoveryCallbackUrl(
        routeCallbackUrl,
        linkingUrl,
        eventUrl,
        initialUrl,
      ),
    [eventUrl, initialUrl, linkingUrl, routeCallbackUrl],
  );

  useEffect(() => {
    let active = true;

    void Linking.getInitialURL().then((url) => {
      if (active && isActionablePasswordRecoveryCallbackUrl(url)) {
        setInitialUrl(url);
      }
    });

    const subscription = Linking.addEventListener("url", ({ url }) => {
      if (
        active &&
        isActionablePasswordRecoveryCallbackUrl(url)
      ) {
        setEventUrl(url);
      }
    });

    const timeout = setTimeout(() => {
      if (active) setCaptureExpired(true);
    }, CALLBACK_CAPTURE_TIMEOUT_MS);

    return () => {
      active = false;
      clearTimeout(timeout);
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    let active = true;

    if (!actionableUrl) {
      if (captureExpired) {
        setError(
          t("errors", "AUTH_PASSWORD_RECOVERY_CALLBACK_MISSING"),
        );
      }

      return () => {
        active = false;
      };
    }

    const callbackKey = getPasswordRecoveryCallbackKey(actionableUrl);
    if (!callbackKey || attemptedCallbackKeyRef.current === callbackKey) {
      return () => {
        active = false;
      };
    }

    attemptedCallbackKeyRef.current = callbackKey;
    setError(null);

    const complete = async () => {
      try {
        await completePasswordRecoveryFromUrl(actionableUrl);
        if (active) {
          router.replace("/(auth)/reset-password");
        }
      } catch (cause) {
        if (!active) return;

        const code =
          cause instanceof AppError
            ? cause.code
            : "AUTH_PASSWORD_RECOVERY_INVALID";

        setError(t("errors", code));
      }
    };

    void complete();

    return () => {
      active = false;
    };
  }, [actionableUrl, captureExpired, router, t]);

  return (
    <Screen testID="password-recovery-callback-screen">
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: spacing.lg,
        }}
      >
        <Text
          style={[
            typography.title,
            {
              color: colors.textPrimary,
              textAlign: "center",
            },
          ]}
        >
          {t("auth", "oauth.resetCallbackTitle")}
        </Text>

        {error ? (
          <>
            <Text
              testID="password-recovery-callback-error"
              accessibilityRole="alert"
              style={[
                typography.body,
                {
                  color: colors.recording,
                  textAlign: "center",
                  marginTop: spacing.md,
                  marginBottom: spacing.lg,
                },
              ]}
            >
              {error}
            </Text>
            <Button
              testID="password-recovery-request-new-link-button"
              label={t("auth", "resetPassword.requestNewLink")}
              variant="secondary"
              onPress={() =>
                router.replace("/(auth)/forgot-password")
              }
            />
          </>
        ) : (
          <>
            <ActivityIndicator
              color={colors.accent}
              style={{ marginTop: spacing.lg }}
            />
            <Text
              style={[
                typography.body,
                {
                  color: colors.textSecondary,
                  textAlign: "center",
                  marginTop: spacing.md,
                },
              ]}
            >
              {t("auth", "oauth.recoveryCompleting")}
            </Text>
          </>
        )}
      </View>
    </Screen>
  );
}
