import React from "react";
import { StyleSheet, Text, View, ViewStyle } from "react-native";

import { useTheme } from "@/src/theme/ThemeProvider";

interface Props {
  title?: string;
  children: React.ReactNode;
  style?: ViewStyle;
  testID?: string;
}

export function Card({ title, children, style, testID }: Props) {
  const { colors, spacing, radii, typography, shadows } = useTheme();
  return (
    <View
      testID={testID}
      style={[
        {
          backgroundColor: colors.surface,
          borderRadius: radii.lg,
          padding: spacing.md,
          borderWidth: 1,
          borderColor: colors.border,
          ...shadows.low,
        },
        style,
      ]}
    >
      {title ? (
        <Text
          style={[
            typography.headline,
            { color: colors.textPrimary, marginBottom: spacing.sm },
          ]}
        >
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

export const cardStyles = StyleSheet.create({});
