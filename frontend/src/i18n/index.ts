import { I18n, TranslateOptions } from "i18n-js";
import * as Localization from "expo-localization";

import { AppLanguageTag, isSupportedAppLanguage } from "./languages";

import enCommon from "./en/common.json";
import enAuth from "./en/auth.json";
import enOnboarding from "./en/onboarding.json";
import enRecording from "./en/recording.json";
import enLibrary from "./en/library.json";
import enSession from "./en/session.json";
import enProfile from "./en/profile.json";
import enPermissions from "./en/permissions.json";
import enErrors from "./en/errors.json";

import idCommon from "./id/common.json";
import idAuth from "./id/auth.json";
import idOnboarding from "./id/onboarding.json";
import idRecording from "./id/recording.json";
import idLibrary from "./id/library.json";
import idSession from "./id/session.json";
import idProfile from "./id/profile.json";
import idPermissions from "./id/permissions.json";
import idErrors from "./id/errors.json";

export const namespaces = {
  common: { en: enCommon, id: idCommon },
  auth: { en: enAuth, id: idAuth },
  onboarding: { en: enOnboarding, id: idOnboarding },
  recording: { en: enRecording, id: idRecording },
  library: { en: enLibrary, id: idLibrary },
  session: { en: enSession, id: idSession },
  profile: { en: enProfile, id: idProfile },
  permissions: { en: enPermissions, id: idPermissions },
  errors: { en: enErrors, id: idErrors },
} as const;

export type Namespace = keyof typeof namespaces;

// Merge namespaces into the flat store i18n-js expects: e.g. "auth.signIn.title".
const buildStore = (locale: "en" | "id") => {
  const store: Record<string, unknown> = {};
  (Object.keys(namespaces) as Namespace[]).forEach((ns) => {
    store[ns] = namespaces[ns][locale];
  });
  return store;
};

export const i18n = new I18n({
  en: buildStore("en"),
  id: buildStore("id"),
});

i18n.defaultLocale = "en";
i18n.enableFallback = true;
i18n.missingBehavior = "guess"; // Falls back to the English string if key missing in id
i18n.locale = "en";

export const detectDeviceAppLanguage = (): AppLanguageTag => {
  const locales = Localization.getLocales();
  for (const l of locales) {
    const raw = (l.languageTag || l.languageCode || "en").toLowerCase();
    const primary = raw.split("-")[0];
    if (isSupportedAppLanguage(primary)) {
      return primary as AppLanguageTag;
    }
  }
  return "en";
};

export const setAppLanguage = (tag: AppLanguageTag) => {
  i18n.locale = tag;
};

// Namespaced translator: t("auth", "signIn.title").
export const t = (ns: Namespace, key: string, options?: TranslateOptions): string => {
  return i18n.t(`${ns}.${key}`, options);
};
