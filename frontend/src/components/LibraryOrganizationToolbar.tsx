import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  Text,
  TouchableOpacity,
  View,
  type GestureResponderEvent,
} from "react-native";

import type { LibraryViewMode } from "@/src/services/library/library-organization";
import { useTheme } from "@/src/theme/ThemeProvider";

export interface LibrarySortOption {
  value: string;
  label: string;
}

interface Props {
  viewMode: LibraryViewMode;
  onViewModeChange: (mode: LibraryViewMode) => void;
  sortValue: string;
  sortOptions: LibrarySortOption[];
  onSortChange: (value: string) => void;
  sortButtonLabel: string;
  sortSheetTitle: string;
  cardViewLabel: string;
  compactViewLabel: string;
  closeLabel: string;
  testIDPrefix: string;
}

export function LibraryOrganizationToolbar({
  viewMode,
  onViewModeChange,
  sortValue,
  sortOptions,
  onSortChange,
  sortButtonLabel,
  sortSheetTitle,
  cardViewLabel,
  compactViewLabel,
  closeLabel,
  testIDPrefix,
}: Props) {
  const { colors, spacing, radii, typography, layout } = useTheme();
  const [sortVisible, setSortVisible] = useState(false);

  const selectedSortLabel = useMemo(
    () =>
      sortOptions.find((option) => option.value === sortValue)?.label ??
      sortOptions[0]?.label ??
      "",
    [sortOptions, sortValue],
  );

  const selectSort = (value: string) => {
    onSortChange(value);
    setSortVisible(false);
  };

  const renderViewButton = (
    mode: LibraryViewMode,
    icon: React.ComponentProps<typeof Ionicons>["name"],
    label: string,
  ) => {
    const selected = viewMode === mode;

    return (
      <TouchableOpacity
        testID={`${testIDPrefix}-view-${mode}`}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected }}
        onPress={() => onViewModeChange(mode)}
        style={{
          width: layout.minTouchTarget,
          height: layout.minTouchTarget,
          borderRadius: radii.md,
          borderWidth: 1,
          borderColor: selected ? colors.accent : colors.border,
          backgroundColor: selected ? colors.accent : colors.surface,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons
          name={icon}
          size={20}
          color={selected ? colors.textOnAccent : colors.textSecondary}
        />
      </TouchableOpacity>
    );
  };

  return (
    <>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: spacing.sm,
          marginBottom: spacing.sm,
        }}
      >
        <TouchableOpacity
          testID={`${testIDPrefix}-sort-button`}
          accessibilityRole="button"
          accessibilityLabel={`${sortButtonLabel}: ${selectedSortLabel}`}
          onPress={() => setSortVisible(true)}
          style={{
            minHeight: layout.minTouchTarget,
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.xs,
            paddingHorizontal: spacing.md,
            borderRadius: radii.md,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
          }}
        >
          <Ionicons
            name="swap-vertical-outline"
            size={18}
            color={colors.textSecondary}
          />
          <Text
            numberOfLines={1}
            style={[
              typography.caption,
              {
                color: colors.textPrimary,
                flex: 1,
              },
            ]}
          >
            {sortButtonLabel}: {selectedSortLabel}
          </Text>
          <Ionicons
            name="chevron-down-outline"
            size={18}
            color={colors.textTertiary}
          />
        </TouchableOpacity>

        <View
          style={{
            flexDirection: "row",
            gap: spacing.xs,
          }}
        >
          {renderViewButton("card", "grid-outline", cardViewLabel)}
          {renderViewButton("compact", "list-outline", compactViewLabel)}
        </View>
      </View>

      <Modal
        transparent
        visible={sortVisible}
        animationType="fade"
        onRequestClose={() => setSortVisible(false)}
      >
        <Pressable
          testID={`${testIDPrefix}-sort-backdrop`}
          accessibilityLabel={closeLabel}
          onPress={() => setSortVisible(false)}
          style={{
            flex: 1,
            backgroundColor: colors.overlay,
            justifyContent: "flex-end",
          }}
        >
          <Pressable
            onPress={(event: GestureResponderEvent) => event.stopPropagation()}
            style={{
              backgroundColor: colors.surfaceElevated,
              borderTopLeftRadius: radii.xl,
              borderTopRightRadius: radii.xl,
              paddingHorizontal: spacing.md,
              paddingTop: spacing.lg,
              paddingBottom: spacing.xl,
            }}
          >
            <Text
              style={[
                typography.headline,
                {
                  color: colors.textPrimary,
                  marginBottom: spacing.sm,
                },
              ]}
            >
              {sortSheetTitle}
            </Text>

            {sortOptions.map((option) => {
              const selected = option.value === sortValue;

              return (
                <TouchableOpacity
                  key={option.value}
                  testID={`${testIDPrefix}-sort-${option.value}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => selectSort(option.value)}
                  style={{
                    minHeight: layout.minTouchTarget,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingVertical: spacing.sm,
                    paddingHorizontal: spacing.xs,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                  }}
                >
                  <Text
                    style={[
                      typography.body,
                      {
                        color: selected ? colors.accent : colors.textPrimary,
                      },
                    ]}
                  >
                    {option.label}
                  </Text>

                  {selected ? (
                    <Ionicons
                      name="checkmark-circle"
                      size={22}
                      color={colors.accent}
                    />
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
