import { useLocalSearchParams, useRouter } from "expo-router";
import { Text } from "react-native";

import { Button } from "@/src/components/Button";
import { Screen } from "@/src/components/Screen";
import { useI18n } from "@/src/i18n/I18nProvider";
import { useTheme } from "@/src/theme/ThemeProvider";

export default function ProjectDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useI18n();
  const { colors, typography, spacing } = useTheme();

  return (
    <Screen testID="project-detail-screen">
      <Text style={[typography.title, { color: colors.textPrimary }]}>{t("common", "labels.project")}</Text>
      <Text style={[typography.caption, { color: colors.textSecondary, marginTop: spacing.xs }]}>{id}</Text>
      <Button
        testID="project-back-button"
        label={t("common", "actions.back")}
        variant="ghost"
        onPress={() => router.back()}
      />
    </Screen>
  );
}
