import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, Switch, Text, TouchableOpacity, View } from "react-native";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { Screen } from "@/src/components/Screen";
import { branding } from "@/src/config/branding";
import { appLanguages, displayLanguageName } from "@/src/i18n/languages";
import { useI18n } from "@/src/i18n/I18nProvider";
import { signOut } from "@/src/services/supabase/auth";
import { getPreference, setPreference } from "@/src/services/sqlite/repository";
import { useAuthStore } from "@/src/stores/auth-store";
import { useTheme } from "@/src/theme/ThemeProvider";

const WIFI_ONLY_KEY = "upload.wifiOnly";

export default function Profile() {
  const router = useRouter();
  const { t, language, setLanguage } = useI18n();
  const { colors, spacing, typography, mode, setMode } = useTheme();
  const user = useAuthStore((s) => s.user);
  const [wifiOnly, setWifiOnly] = useState(false);

  useEffect(() => {
    (async () => {
      const v = await getPreference<boolean>(WIFI_ONLY_KEY, true);
      setWifiOnly(v);
    })();
  }, []);

  const toggleWifi = async (v: boolean) => {
    setWifiOnly(v);
    await setPreference(WIFI_ONLY_KEY, v);
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

      <Card title={t("profile", "sections.about")} testID="profile-about-card">
        <Text style={[typography.caption, { color: colors.textSecondary }]}>
          {branding.productName}
        </Text>
        <Text style={[typography.caption, { color: colors.textTertiary }]}>{branding.tagline}</Text>

        <View style={{ height: spacing.md }} />

        <Button
          testID="profile-privacy-button"
          label={t("profile", "privacyPolicy")}
          variant="ghost"
          onPress={() => Linking.openURL(branding.privacyPolicyUrl)}
        />
        <Button
          testID="profile-terms-button"
          label={t("profile", "terms")}
          variant="ghost"
          onPress={() => Linking.openURL(branding.termsOfServiceUrl)}
        />
        <Button
          testID="profile-support-button"
          label={t("profile", "support")}
          variant="ghost"
          onPress={() => Linking.openURL(`mailto:${branding.supportEmail}`)}
        />
        <Text
          style={[typography.overline, { color: colors.textTertiary, marginTop: spacing.md }]}
        >
          {t("profile", "version")} 1.0.0 (Milestone 1) • {displayLanguageName(language)}
        </Text>
      </Card>
    </Screen>
  );
}
