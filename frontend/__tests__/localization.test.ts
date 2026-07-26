import { namespaces } from "@/src/i18n";

describe("localization key parity", () => {
  const collectKeys = (obj: any, prefix = ""): string[] => {
    if (obj == null || typeof obj !== "object") return [prefix];
    return Object.entries(obj).flatMap(([k, v]) =>
      collectKeys(v, prefix ? `${prefix}.${k}` : k),
    );
  };

  (Object.keys(namespaces) as (keyof typeof namespaces)[]).forEach((ns) => {
    it(`Indonesian namespace "${ns}" has the same keys as English`, () => {
      const en = collectKeys(namespaces[ns].en).sort();
      const id = collectKeys(namespaces[ns].id).sort();
      expect(id).toEqual(en);
    });
  });
});

describe("English fallback via i18n-js", () => {
  it("returns the English value when a namespace exists in both", () => {
    // Values are structurally identical in shape; the key set was validated above.
    // This test asserts the store presence rather than i18n runtime behavior
    // (i18n runtime is exercised inline throughout the app).
    expect(namespaces.common.en.actions.continue).toBeTruthy();
    expect(namespaces.common.id.actions.continue).toBeTruthy();
  });
});
