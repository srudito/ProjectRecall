// Jest setup. Keep native modules stubbed so pure logic tests never need real
// native code.

// AsyncStorage is a native module and must be mocked in Jest.
jest.mock("@react-native-async-storage/async-storage", () =>
  require(
    "@react-native-async-storage/async-storage/jest/async-storage-mock",
  ),
);

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

const mockFileSystem = {
  cacheDirectory: "/tmp/cache/",
  documentDirectory: "/tmp/documents/",
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 0 })),
  copyAsync: jest.fn(async () => undefined),
  deleteAsync: jest.fn(async () => undefined),
  makeDirectoryAsync: jest.fn(async () => undefined),
  uploadAsync: jest.fn(async () => ({ status: 200, body: "{}", headers: {} })),
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  EncodingType: { Base64: "base64" },
};

jest.mock("expo-file-system", () => mockFileSystem);
jest.mock("expo-file-system/legacy", () => mockFileSystem);

jest.mock("expo-crypto", () => ({
  randomUUID: jest.fn(() => "00000000-0000-0000-0000-000000000000"),
  digestStringAsync: jest.fn(async () => "0123456789abcdef0123456789abcdef"),
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
}));

jest.mock("expo-localization", () => ({
  getLocales: () => [{ languageTag: "en", languageCode: "en" }],
}));

jest.mock("react-native-url-polyfill/auto", () => ({}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(async () => ({
      isConnected: true,
      isInternetReachable: true,
    })),
    addEventListener: jest.fn(() => jest.fn()),
  },
}));
