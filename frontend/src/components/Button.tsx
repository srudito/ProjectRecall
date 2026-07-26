import React from "react";
import { ActivityIndicator, StyleSheet, Text, TextStyle, TouchableOpacity, View, ViewStyle } from "react-native";

import { useTheme } from "@/src/theme/ThemeProvider";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";

interface Props {
  onPress?: () => void;
  label: string;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: React.ReactNode;
  style?: ViewStyle;
  testID?: string;
}

export function Button({
  onPress,
  label,
  variant = "primary",
  disabled,
  loading,
  fullWidth,
  leftIcon,
  style,
  testID,
}: Props) {
  const { colors, radii, spacing, typography, layout } = useTheme();

  const backgrounds: Record<Variant, string> = {
    primary: colors.primary,
    secondary: colors.surface,
    ghost: "transparent",
    danger: colors.recording,
    accent: colors.accent,
  };

  const textColors: Record<Variant, string> = {
    primary: colors.textOnPrimary,
    secondary: colors.textPrimary,
    ghost: colors.textPrimary,
    danger: "#FFFFFF",
    accent: colors.textOnAccent,
  };

  const isDisabled = disabled || loading;

  const containerStyle: ViewStyle = {
    backgroundColor: backgrounds[variant],
    borderRadius: radii.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    minHeight: layout.minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    opacity: isDisabled ? 0.5 : 1,
    borderWidth: variant === "secondary" ? 1 : 0,
    borderColor: colors.border,
    ...(fullWidth ? { alignSelf: "stretch" } : {}),
    ...style,
  };

  const textStyle: TextStyle = {
    ...typography.bodyMedium,
    color: textColors[variant],
    marginLeft: leftIcon ? spacing.xs : 0,
  };

  return (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      onPress={onPress}
      disabled={isDisabled}
      style={containerStyle}
      activeOpacity={0.85}
    >
      {loading ? (
        <ActivityIndicator color={textColors[variant]} />
      ) : (
        <>
          {leftIcon ? <View>{leftIcon}</View> : null}
          <Text style={textStyle}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

// (Kept for potential future style consumers.)
export const buttonStyles = StyleSheet.create({});
