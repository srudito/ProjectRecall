// Language catalog. BCP 47 tags. This is the searchable catalog used for
// choosing SPOKEN languages (not application language).
//
// Application language options are a smaller set (see appLanguages).

export interface LanguageEntry {
  tag: string; // BCP 47
  englishName: string;
  nativeName: string;
}

export const spokenLanguageCatalog: readonly LanguageEntry[] = [
  { tag: "en", englishName: "English", nativeName: "English" },
  { tag: "en-US", englishName: "English (US)", nativeName: "English (US)" },
  { tag: "en-GB", englishName: "English (UK)", nativeName: "English (UK)" },
  { tag: "id", englishName: "Indonesian", nativeName: "Bahasa Indonesia" },
  { tag: "id-ID", englishName: "Indonesian (Indonesia)", nativeName: "Bahasa Indonesia (Indonesia)" },
  { tag: "ms", englishName: "Malay", nativeName: "Bahasa Melayu" },
  { tag: "zh-CN", englishName: "Chinese (Simplified)", nativeName: "简体中文" },
  { tag: "zh-TW", englishName: "Chinese (Traditional)", nativeName: "繁體中文" },
  { tag: "yue", englishName: "Cantonese", nativeName: "粵語" },
  { tag: "ja-JP", englishName: "Japanese", nativeName: "日本語" },
  { tag: "ko-KR", englishName: "Korean", nativeName: "한국어" },
  { tag: "es-ES", englishName: "Spanish", nativeName: "Español" },
  { tag: "fr-FR", englishName: "French", nativeName: "Français" },
  { tag: "de-DE", englishName: "German", nativeName: "Deutsch" },
  { tag: "it-IT", englishName: "Italian", nativeName: "Italiano" },
  { tag: "pt-BR", englishName: "Portuguese (Brazil)", nativeName: "Português (Brasil)" },
  { tag: "pt-PT", englishName: "Portuguese (Portugal)", nativeName: "Português (Portugal)" },
  { tag: "nl-NL", englishName: "Dutch", nativeName: "Nederlands" },
  { tag: "ar-SA", englishName: "Arabic", nativeName: "العربية" },
  { tag: "hi-IN", englishName: "Hindi", nativeName: "हिन्दी" },
  { tag: "th-TH", englishName: "Thai", nativeName: "ไทย" },
  { tag: "vi-VN", englishName: "Vietnamese", nativeName: "Tiếng Việt" },
  { tag: "tl-PH", englishName: "Filipino", nativeName: "Filipino" },
  { tag: "ru-RU", englishName: "Russian", nativeName: "Русский" },
  { tag: "tr-TR", englishName: "Turkish", nativeName: "Türkçe" },
  { tag: "pl-PL", englishName: "Polish", nativeName: "Polski" },
];

export const appLanguages = [
  { tag: "en", englishName: "English", nativeName: "English" },
  { tag: "id", englishName: "Indonesian", nativeName: "Bahasa Indonesia" },
] as const;

export type AppLanguageTag = (typeof appLanguages)[number]["tag"];

export const isSupportedAppLanguage = (tag: string): tag is AppLanguageTag =>
  appLanguages.some((l) => l.tag === tag);

export const findLanguage = (tag: string): LanguageEntry | undefined =>
  spokenLanguageCatalog.find((l) => l.tag === tag);

export const displayLanguageName = (tag: string): string => {
  const found = findLanguage(tag);
  return found ? found.nativeName : tag;
};
