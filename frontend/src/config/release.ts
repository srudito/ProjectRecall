import Constants from "expo-constants";

const FALLBACK_APP_VERSION = "—";

export const getAppDisplayVersion = (): string => {
  const version = Constants.expoConfig?.version?.trim();
  return version || FALLBACK_APP_VERSION;
};
