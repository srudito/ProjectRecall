// Jest setup. Keep native modules stubbed so pure logic tests never need real
// native code.

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock("expo-sqlite", () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => undefined),
    withTransactionAsync: jest.fn(async (fn) => fn()),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async () => null),
  })),
}));

jest.mock("expo-file-system", () => ({
  documentDirectory: "/tmp/",
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 0 })),
  copyAsync: jest.fn(async () => undefined),
  deleteAsync: jest.fn(async () => undefined),
  makeDirectoryAsync: jest.fn(async () => undefined),
  EncodingType: { Base64: "base64" },
}));

jest.mock("expo-crypto", () => ({
  randomUUID: jest.fn(() => "00000000-0000-0000-0000-000000000000"),
  digestStringAsync: jest.fn(async () => "0123456789abcdef0123456789abcdef"),
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
}));

jest.mock("expo-localization", () => ({
  getLocales: () => [{ languageTag: "en", languageCode: "en" }],
}));

jest.mock("react-native-url-polyfill/auto", () => ({}));
