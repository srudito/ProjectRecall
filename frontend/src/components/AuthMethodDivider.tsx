import { Text, View } from "react-native";

import { useI18n } from "@/src/i18n/I18nProvider";
import { useTheme } from "@/src/theme/ThemeProvider";

export function AuthMethodDivider() {
  const { t } = useI18n();
  const { colors, spacing, typography } = useTheme();

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        marginVertical: spacing.md,
      }}
    >
      <View
        style={{
          flex: 1,
          height: 1,
          backgroundColor: colors.border,
        }}
      />
      <Text
        style={[
          typography.caption,
          { color: colors.textTertiary },
        ]}
      >
        {t("auth", "oauth.orContinueWithEmail")}
      </Text>
      <View
        style={{
          flex: 1,
          height: 1,
          backgroundColor: colors.border,
        }}
      />
    </View>
  );
}
