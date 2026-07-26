// Design tokens. Centralize colors, typography, spacing, radii, shadows here so
// branding can be swapped without touching screens.

export const palette = {
  primary: "#17233D",
  primaryPressed: "#0F182B",
  accent: "#20A89A",
  accentPressed: "#168A80",
  mutedBlue: "#4A6180",

  // Semantic
  recording: "#E5484D",
  warning: "#D4881A",
  success: "#219653",
  info: "#2F80ED",

  // Surfaces
  lightBackground: "#F6F8FB",
  lightSurface: "#FFFFFF",
  lightBorder: "#E4E9F2",
  lightTextPrimary: "#0D1526",
  lightTextSecondary: "#4A5772",
  lightTextTertiary: "#7A869A",
  lightDisabled: "#C4CBD9",

  darkBackground: "#0D1526",
  darkSurface: "#151F33",
  darkSurfaceElevated: "#1C2942",
  darkBorder: "#233152",
  darkTextPrimary: "#F6F8FB",
  darkTextSecondary: "#B7C0D3",
  darkTextTertiary: "#7A869A",
  darkDisabled: "#455171",
} as const;

export type ColorScheme = "light" | "dark";

export const buildColors = (scheme: ColorScheme) => {
  const isDark = scheme === "dark";
  return {
    primary: palette.primary,
    primaryPressed: palette.primaryPressed,
    accent: palette.accent,
    accentPressed: palette.accentPressed,
    mutedBlue: palette.mutedBlue,
    recording: palette.recording,
    warning: palette.warning,
    success: palette.success,
    info: palette.info,
    background: isDark ? palette.darkBackground : palette.lightBackground,
    surface: isDark ? palette.darkSurface : palette.lightSurface,
    surfaceElevated: isDark ? palette.darkSurfaceElevated : palette.lightSurface,
    border: isDark ? palette.darkBorder : palette.lightBorder,
    textPrimary: isDark ? palette.darkTextPrimary : palette.lightTextPrimary,
    textSecondary: isDark ? palette.darkTextSecondary : palette.lightTextSecondary,
    textTertiary: isDark ? palette.darkTextTertiary : palette.lightTextTertiary,
    textOnAccent: "#FFFFFF",
    textOnPrimary: "#FFFFFF",
    disabled: isDark ? palette.darkDisabled : palette.lightDisabled,
    overlay: isDark ? "rgba(0,0,0,0.6)" : "rgba(13,21,38,0.4)",
    // Tab bar / navigation
    tabBarBackground: isDark ? palette.darkSurface : palette.lightSurface,
    tabBarActive: palette.accent,
    tabBarInactive: isDark ? palette.darkTextTertiary : palette.lightTextTertiary,
  } as const;
};

export type Colors = ReturnType<typeof buildColors>;

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

export const typography = {
  displayLarge: { fontSize: 34, lineHeight: 40, fontWeight: "700" as const, letterSpacing: -0.5 },
  displayMedium: { fontSize: 28, lineHeight: 34, fontWeight: "700" as const, letterSpacing: -0.3 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "600" as const },
  headline: { fontSize: 18, lineHeight: 24, fontWeight: "600" as const },
  bodyLarge: { fontSize: 17, lineHeight: 24, fontWeight: "400" as const },
  body: { fontSize: 15, lineHeight: 22, fontWeight: "400" as const },
  bodyMedium: { fontSize: 15, lineHeight: 22, fontWeight: "500" as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: "400" as const },
  overline: { fontSize: 11, lineHeight: 14, fontWeight: "600" as const, letterSpacing: 0.5 },
  timer: {
    fontSize: 56,
    lineHeight: 62,
    fontWeight: "700" as const,
    // Tabular numerals for the recording timer.
    fontVariant: ["tabular-nums"] as ("tabular-nums")[],
  },
} as const;

export const shadows = {
  none: {
    shadowColor: "transparent",
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
  low: {
    shadowColor: "#0D1526",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  medium: {
    shadowColor: "#0D1526",
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
} as const;

export const layout = {
  minTouchTarget: 44,
  contentMaxWidth: 720,
} as const;
