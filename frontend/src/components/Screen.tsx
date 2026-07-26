import React from "react";
import { ScrollView, StyleSheet, View, ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "@/src/theme/ThemeProvider";

interface Props {
  children: React.ReactNode;
  scrollable?: boolean;
  contentContainerStyle?: ViewStyle;
  testID?: string;
  padded?: boolean;
}

export function Screen({ children, scrollable, contentContainerStyle, testID, padded = true }: Props) {
  const { colors, spacing } = useTheme();
  const pad = padded ? { padding: spacing.md, paddingBottom: spacing.xl } : {};
  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: colors.background,
  };

  const inner = scrollable ? (
    <ScrollView
      testID={testID}
      contentContainerStyle={[pad, contentContainerStyle]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View testID={testID} style={[{ flex: 1 }, pad, contentContainerStyle]}>
      {children}
    </View>
  );

  return (
    <SafeAreaView style={containerStyle} edges={["top", "left", "right"]}>
      {inner}
    </SafeAreaView>
  );
}

export const screenStyles = StyleSheet.create({});
