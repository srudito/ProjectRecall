import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Appearance, ColorSchemeName } from "react-native";

import { storage } from "@/src/utils/storage";

import { buildColors, Colors, ColorScheme, layout, radii, shadows, spacing, typography } from "./tokens";

export type AppearanceMode = "light" | "dark" | "system";

interface ThemeContextValue {
  mode: AppearanceMode;
  scheme: ColorScheme;
  colors: Colors;
  spacing: typeof spacing;
  radii: typeof radii;
  typography: typeof typography;
  shadows: typeof shadows;
  layout: typeof layout;
  setMode: (mode: AppearanceMode) => Promise<void>;
}

const STORAGE_KEY = "app.appearanceMode.v1";

const ThemeContext = createContext<ThemeContextValue | null>(null);

const resolveScheme = (mode: AppearanceMode, system: ColorSchemeName): ColorScheme => {
  if (mode === "system") {
    return system === "dark" ? "dark" : "light";
  }
  return mode;
};

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<AppearanceMode>("system");
  const [systemScheme, setSystemScheme] = useState<ColorSchemeName>(
    Appearance.getColorScheme(),
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await storage.getItem<AppearanceMode>(STORAGE_KEY, "system");
      if (!cancelled && stored) {
        setModeState(stored);
      }
    })();
    const sub = Appearance.addChangeListener(({ colorScheme }) => setSystemScheme(colorScheme));
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  const setMode = useCallback(async (next: AppearanceMode) => {
    setModeState(next);
    await storage.setItem(STORAGE_KEY, next);
  }, []);

  const scheme = resolveScheme(mode, systemScheme);
  const colors = useMemo(() => buildColors(scheme), [scheme]);

  const value: ThemeContextValue = useMemo(
    () => ({
      mode,
      scheme,
      colors,
      spacing,
      radii,
      typography,
      shadows,
      layout,
      setMode,
    }),
    [mode, scheme, colors, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return ctx;
}
