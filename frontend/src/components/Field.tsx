import React from "react";
import { StyleSheet, Text, TextInput, TextInputProps, View } from "react-native";

import { useTheme } from "@/src/theme/ThemeProvider";

interface Props extends TextInputProps {
  label?: string;
  helperText?: string;
  errorText?: string;
  testID?: string;
}

export function Field({ label, helperText, errorText, style, testID, ...rest }: Props) {
  const { colors, spacing, typography, radii } = useTheme();

  return (
    <View style={{ marginBottom: spacing.md }} testID={testID ? `${testID}-container` : undefined}>
      {label ? (
        <Text style={[typography.caption, { color: colors.textSecondary, marginBottom: spacing.xxs }]}>
          {label}
        </Text>
      ) : null}
      <TextInput
        {...rest}
        testID={testID}
        placeholderTextColor={colors.textTertiary}
        style={[
          {
            borderWidth: 1,
            borderColor: errorText ? colors.recording : colors.border,
            backgroundColor: colors.surface,
            borderRadius: radii.md,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm + 2,
            color: colors.textPrimary,
            fontSize: 16,
            minHeight: 48,
          },
          style,
        ]}
      />
      {errorText ? (
        <Text style={[typography.caption, { color: colors.recording, marginTop: spacing.xxs }]}>
          {errorText}
        </Text>
      ) : helperText ? (
        <Text style={[typography.caption, { color: colors.textTertiary, marginTop: spacing.xxs }]}>
          {helperText}
        </Text>
      ) : null}
    </View>
  );
}

export const fieldStyles = StyleSheet.create({});
