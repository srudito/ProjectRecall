import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { storage } from "@/src/utils/storage";

import { detectDeviceAppLanguage, i18n, Namespace, setAppLanguage as setLocale } from "./index";
import { AppLanguageTag, isSupportedAppLanguage } from "./languages";
import type { TranslateOptions } from "i18n-js";

interface I18nContextValue {
  language: AppLanguageTag;
  setLanguage: (tag: AppLanguageTag) => Promise<void>;
  t: (ns: Namespace, key: string, options?: TranslateOptions) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);
const STORAGE_KEY = "app.language.v1";

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<AppLanguageTag>("en");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const stored = await storage.getItem<string>(STORAGE_KEY, "");
      const initial: AppLanguageTag =
        stored && isSupportedAppLanguage(stored) ? (stored as AppLanguageTag) : detectDeviceAppLanguage();
      setLocale(initial);
      setLanguageState(initial);
      setReady(true);
    })();
  }, []);

  const setLanguage = useCallback(async (tag: AppLanguageTag) => {
    setLocale(tag);
    setLanguageState(tag);
    await storage.setItem(STORAGE_KEY, tag);
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      setLanguage,
      t: (ns, key, options) => i18n.t(`${ns}.${key}`, options),
    }),
    [language, setLanguage],
  );

  if (!ready) return null;

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
