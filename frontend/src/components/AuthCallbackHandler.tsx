import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
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
  completeAuthSessionFromUrl,
  getCurrentSession,
  waitForCurrentSession,
} from "@/src/services/supabase/auth";
import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";

WebBrowser.maybeCompleteAuthSession();

type CallbackDestination =
  | "/(tabs)/home"
  | "/(auth)/reset-password";

interface AuthCallbackHandlerProps {
  destination: CallbackDestination;
  titleKey: "oauth.callbackTitle" | "oauth.resetCallbackTitle";
}

export function AuthCallbackHandler({
  destination,
  titleKey,
}: AuthCallbackHandlerProps) {
  const router = useRouter();
  const callbackUrl = Linking.useURL();
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();
  const setSession = useAuthStore((state) => state.setSession);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const finishWithSession = (
      session: NonNullable<
        Awaited<ReturnType<typeof getCurrentSession>>
      >,
    ) => {
      if (!active) return;

      setSession(session);
      router.replace(destination);
    };

    const complete = async () => {
      setError(null);

      // GoogleSignInButton may already have completed the callback while Expo
      // Router was mounting this deep-link screen. Never show an error for an
      // already authenticated user.
      const existing = await getCurrentSession();
      if (existing) {
        finishWithSession(existing);
        return;
      }

      const url = callbackUrl ?? (await Linking.getInitialURL());

      if (!url) {
        const recovered = await waitForCurrentSession();
        if (recovered) {
          finishWithSession(recovered);
          return;
        }

        if (active) {
          setError(t("errors", "AUTH_OAUTH_CALLBACK_INVALID"));
        }
        return;
      }

      try {
        const result = await completeAuthSessionFromUrl(url);

        if (!active) {
          return;
        }

        if (result.session) {
          finishWithSession(result.session);
          return;
        }

        const recovered = await waitForCurrentSession();
        if (recovered) {
          finishWithSession(recovered);
          return;
        }

        setError(t("errors", "AUTH_OAUTH_CALLBACK_INVALID"));
      } catch (cause) {
        // A parallel WebBrowser callback can succeed after this route receives
        // a bare or already-consumed callback URL. Recover the stored session
        // before surfacing an error to the user.
        const recovered = await waitForCurrentSession();
        if (recovered) {
          finishWithSession(recovered);
          return;
        }

        if (!active) {
          return;
        }

        const code =
          cause instanceof AppError
            ? cause.code
            : "AUTH_OAUTH_FAILED";

        setError(t("errors", code));
      }
    };

    void complete();

    return () => {
      active = false;
    };
  }, [callbackUrl, destination, router, setSession, t]);

  return (
    <Screen testID="auth-callback-screen">
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
          {t("auth", titleKey)}
        </Text>

        {error ? (
          <>
            <Text
              testID="auth-callback-error"
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
              testID="auth-callback-return-button"
              label={t("auth", "oauth.returnToSignIn")}
              variant="secondary"
              onPress={() =>
                router.replace("/(auth)/sign-in")
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
              {t("auth", "oauth.completing")}
            </Text>
          </>
        )}
      </View>
    </Screen>
  );
}
