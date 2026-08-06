import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Switch, Text, TouchableOpacity, View } from "react-native";

import { Button } from "@/src/components/Button";
import { ConnectGoogleIdentityButton } from "@/src/components/ConnectGoogleIdentityButton";
import { DisconnectGoogleIdentityButton } from "@/src/components/DisconnectGoogleIdentityButton";
import { Card } from "@/src/components/Card";
import { Screen } from "@/src/components/Screen";
import {
  branding,
  hasConfiguredPrivacyPolicy,
  hasConfiguredSupportEmail,
  hasConfiguredTermsOfService,
} from "@/src/config/branding";
import { getAppDisplayVersion } from "@/src/config/release";
import { appLanguages, displayLanguageName } from "@/src/i18n/languages";
import { useI18n } from "@/src/i18n/I18nProvider";
import {
  canDisconnectConnectedIdentity,
  ConnectedIdentity,
  hasConnectedProvider,
  listUserIdentities,
  signOut,
  waitForGoogleIdentityLinkCompletion,
} from "@/src/services/supabase/auth";
import { getPreference, setPreference } from "@/src/services/sqlite/repository";
import { requestMediaUploadSync } from "@/src/services/sync/media-upload-worker";
import { requestRecordingUploadSync } from "@/src/services/sync/recording-upload-worker";
import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";

const WIFI_ONLY_KEY = "upload.wifiOnly";

export default function Profile() {
  const router = useRouter();
  const { t, language, setLanguage } = useI18n();
  const { colors, spacing, typography, mode, setMode } = useTheme();
  const user = useAuthStore((s) => s.user);
  const [wifiOnly, setWifiOnly] = useState(false);
  const [connectedIdentities, setConnectedIdentities] = useState<
    ConnectedIdentity[]
  >([]);
  const [identitiesLoading, setIdentitiesLoading] = useState(true);
  const [identitiesError, setIdentitiesError] = useState(false);
  const mountedRef = useRef(true);
  const appVersion = getAppDisplayVersion();

  const loadConnectedIdentities = useCallback(async (): Promise<void> => {
    if (mountedRef.current) {
      setIdentitiesLoading(true);
      setIdentitiesError(false);
    }

    try {
      // On native, Expo Router can remount Profile while the WebBrowser
      // callback is still resolving in the same JS process. Wait for that
      // bounded single-flight operation before reading identities so the
      // newly mounted screen cannot render stale "Connect Google" state.
      await waitForGoogleIdentityLinkCompletion();
      const identities = await listUserIdentities();
      if (mountedRef.current) {
        setConnectedIdentities(identities);
      }
    } catch {
      // Never surface raw Supabase/auth errors or callback data in Profile.
      if (mountedRef.current) {
        setConnectedIdentities([]);
        setIdentitiesError(true);
      }
    } finally {
      if (mountedRef.current) {
        setIdentitiesLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    (async () => {
      const v = await getPreference<boolean>(WIFI_ONLY_KEY, true);
      if (mountedRef.current) {
        setWifiOnly(v);
      }
    })();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadConnectedIdentities();

    return () => {
      mountedRef.current = false;
    };
  }, [loadConnectedIdentities]);

  const toggleWifi = async (v: boolean) => {
    setWifiOnly(v);
    await setPreference(WIFI_ONLY_KEY, v);
    requestRecordingUploadSync();
    requestMediaUploadSync();
  };

  const doSignOut = async () => {
    await signOut();
    router.replace("/(auth)/welcome");
  };

  const renderLanguageOption = (tag: (typeof appLanguages)[number]) => {
    const active = tag.tag === language;
    return (
      <TouchableOpacity
        key={tag.tag}
        testID={`profile-language-${tag.tag}`}
        onPress={() => setLanguage(tag.tag)}
        style={{
          paddingVertical: spacing.sm,
          paddingHorizontal: spacing.md,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: active ? colors.accent : colors.border,
          backgroundColor: active ? colors.accent : colors.surface,
          marginRight: spacing.xs,
        }}
      >
        <Text
          style={[
            typography.bodyMedium,
            { color: active ? "#fff" : colors.textPrimary },
          ]}
        >
          {tag.nativeName}
        </Text>
      </TouchableOpacity>
    );
  };

  const renderAppearance = () => {
    const options: { key: "light" | "dark" | "system"; label: string }[] = [
      { key: "light", label: t("profile", "appearance.light") },
      { key: "dark", label: t("profile", "appearance.dark") },
      { key: "system", label: t("profile", "appearance.system") },
    ];
    return (
      <View style={{ flexDirection: "row", gap: spacing.xs, marginTop: spacing.xs }}>
        {options.map((opt) => (
          <TouchableOpacity
            key={opt.key}
            testID={`profile-appearance-${opt.key}`}
            onPress={() => setMode(opt.key)}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: spacing.sm,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: mode === opt.key ? colors.accent : colors.border,
              backgroundColor: mode === opt.key ? colors.accent : colors.surface,
            }}
          >
            <Text style={[typography.caption, { color: mode === opt.key ? "#fff" : colors.textPrimary }]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  };

  const providerDisplayName = (provider: string): string => {
    const known = t("profile", `connectedAccounts.providers.${provider}`);
    // i18n-js returns a "[missing ...]" style string for unknown keys; fall
    // back to a simple capitalization for providers without a translated
    // label instead of showing that placeholder in the UI.
    if (known.startsWith("[missing")) {
      return provider.charAt(0).toUpperCase() + provider.slice(1);
    }
    return known;
  };

  const googleConnected = hasConnectedProvider(
    connectedIdentities,
    "google",
  );

  const renderConnectGoogleAction = () => {
    if (googleConnected) {
      return null;
    }

    return (
      <View style={{ marginTop: spacing.md }}>
        <Text
          style={[typography.caption, { color: colors.textSecondary }]}
        >
          {t("profile", "connectedAccounts.connectGoogleDescription")}
        </Text>
        <View style={{ height: spacing.sm }} />
        <ConnectGoogleIdentityButton
          onLinked={loadConnectedIdentities}
        />
      </View>
    );
  };

  const renderConnectedAccounts = () => {
    if (identitiesLoading) {
      return (
        <Text
          testID="profile-connected-accounts-loading"
          style={[typography.caption, { color: colors.textSecondary }]}
        >
          {t("profile", "connectedAccounts.loading")}
        </Text>
      );
    }

    if (identitiesError) {
      return (
        <Text
          testID="profile-connected-accounts-error"
          style={[typography.caption, { color: colors.textSecondary }]}
        >
          {t("profile", "connectedAccounts.loadError")}
        </Text>
      );
    }

    if (connectedIdentities.length === 0) {
      return (
        <View>
          <Text
            testID="profile-connected-accounts-empty"
            style={[typography.caption, { color: colors.textSecondary }]}
          >
            {t("profile", "connectedAccounts.empty")}
          </Text>
          {renderConnectGoogleAction()}
        </View>
      );
    }

    const onlyIdentity = connectedIdentities.length === 1;

    return (
      <View testID="profile-connected-accounts-list">
        {connectedIdentities.map((identity, index) => (
          <View
            key={identity.identityId}
            testID={`profile-connected-account-${identity.provider}`}
            style={{
              paddingVertical: spacing.sm,
              borderTopWidth: index === 0 ? 0 : 1,
              borderTopColor: colors.border,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Text
                style={[typography.bodyMedium, { color: colors.textPrimary }]}
              >
                {providerDisplayName(identity.provider)}
              </Text>
              <Text style={[typography.caption, { color: colors.accent }]}>
                {t("profile", "connectedAccounts.status")}
              </Text>
            </View>
            {identity.email ? (
              <Text
                style={[typography.caption, { color: colors.textSecondary }]}
              >
                {identity.email}
              </Text>
            ) : null}
            {onlyIdentity ? (
              <Text
                testID="profile-connected-accounts-only-badge"
                style={[typography.overline, { color: colors.textTertiary }]}
              >
                {t("profile", "connectedAccounts.onlyIdentity")}
              </Text>
            ) : null}
            {identity.provider === "google" &&
            canDisconnectConnectedIdentity(
              connectedIdentities,
              identity.identityId,
            ) ? (
              <View style={{ marginTop: spacing.sm }}>
                <DisconnectGoogleIdentityButton
                  identityId={identity.identityId}
                  identityEmail={identity.email}
                  onUnlinked={loadConnectedIdentities}
                />
              </View>
            ) : null}
          </View>
        ))}
        {renderConnectGoogleAction()}
      </View>
    );
  };

  return (
    <Screen scrollable testID="profile-screen">
      <Text style={[typography.displayMedium, { color: colors.textPrimary, marginBottom: spacing.lg }]}>
        {t("profile", "title")}
      </Text>

      <Card title={t("profile", "sections.account")} testID="profile-account-card">
        <Text style={[typography.body, { color: colors.textPrimary }]}>{user?.email ?? "-"}</Text>
        <View style={{ height: spacing.sm }} />
        <Button
          testID="profile-sign-out-button"
          label={t("profile", "signOut")}
          variant="secondary"
          onPress={doSignOut}
        />
      </Card>

      <View style={{ height: spacing.md }} />

      <Card
        title={t("profile", "connectedAccounts.title")}
        testID="profile-connected-accounts-card"
      >
        {renderConnectedAccounts()}
      </Card>

      <View style={{ height: spacing.md }} />

      <Card title={t("profile", "sections.preferences")} testID="profile-preferences-card">
        <Text style={[typography.caption, { color: colors.textSecondary }]}>
          {t("profile", "appLanguage")}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: spacing.xs }}>
          {appLanguages.map(renderLanguageOption)}
        </View>

        <View style={{ height: spacing.md }} />

        <Text style={[typography.caption, { color: colors.textSecondary }]}>
          {t("profile", "appearance.title")}
        </Text>
        {renderAppearance()}

        <View style={{ height: spacing.md }} />

        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={[typography.body, { color: colors.textPrimary, flex: 1 }]}>
            {t("profile", "wifiOnly")}
          </Text>
          <Switch
            testID="profile-wifi-only-switch"
            value={wifiOnly}
            onValueChange={toggleWifi}
            trackColor={{ true: colors.accent }}
          />
        </View>
      </Card>

      <View style={{ height: spacing.md }} />

      <Card
        title={t("profile", "sections.danger")}
        testID="profile-danger-zone-card"
      >
        <Text style={[typography.body, { color: colors.textPrimary }]}>
          {t("profile", "deleteAccount.summary")}
        </Text>
        <View style={{ height: spacing.sm }} />
        <Button
          testID="profile-delete-account-button"
          label={t("profile", "deleteAccount.open")}
          variant="danger"
          fullWidth
          onPress={() => router.push("/account/delete")}
        />
      </Card>

      <View style={{ height: spacing.md }} />

      <Card title={t("profile", "sections.about")} testID="profile-about-card">
        <Text style={[typography.caption, { color: colors.textSecondary }]}>
          {branding.productName}
        </Text>
        <Text style={[typography.caption, { color: colors.textTertiary }]}>{branding.tagline}</Text>

        <View style={{ height: spacing.md }} />

        {hasConfiguredPrivacyPolicy() ? (
          <Button
            testID="profile-privacy-button"
            label={t("profile", "privacyPolicy")}
            variant="ghost"
            onPress={() => Linking.openURL(branding.privacyPolicyUrl)}
          />
        ) : null}
        {hasConfiguredTermsOfService() ? (
          <Button
            testID="profile-terms-button"
            label={t("profile", "terms")}
            variant="ghost"
            onPress={() => Linking.openURL(branding.termsOfServiceUrl)}
          />
        ) : null}
        {hasConfiguredSupportEmail() ? (
          <Button
            testID="profile-support-button"
            label={t("profile", "support")}
            variant="ghost"
            onPress={() => Linking.openURL(`mailto:${branding.supportEmail}`)}
          />
        ) : null}
        <Text
          testID="profile-app-version"
          style={[typography.overline, { color: colors.textTertiary, marginTop: spacing.md }]}
        >
          {t("profile", "version")} {appVersion} • {displayLanguageName(language)}
        </Text>
      </Card>
    </Screen>
  );
}
