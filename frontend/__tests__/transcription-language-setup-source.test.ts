import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("Milestone 2B.4A transcription language setup source boundary", () => {
  const setup = read("app/record/setup.tsx");
  const capabilities = read(
    "src/services/transcription/language-capabilities.ts",
  );
  const contracts = read("src/services/transcription/contracts.ts");
  const sessionService = read("src/services/session/service.ts");
  const requestMigration = read(
    "../supabase/migrations/0014_transcription_request_worker_v1.sql",
  );

  it("removes the unrestricted spoken-language catalog from transcription setup", () => {
    expect(setup).not.toContain("spokenLanguageCatalog");
    expect(setup).not.toContain("Full catalog");
    expect(setup).not.toContain("record-setup-lang-");
    expect(setup).toContain("SUPPORTED_TRANSCRIPTION_LANGUAGE_CODES");
    expect(setup).toContain('testID={`record-setup-language-${language}`}');
  });

  it("makes code-switching a fixed English and Bahasa Indonesia pair", () => {
    expect(setup).toContain("getTranscriptionLanguageSelectionForMode");
    expect(setup).toContain('testID="record-setup-code-switching-pair"');
    expect(capabilities).toContain(
      'TRANSCRIPTION_CODE_SWITCHING_LANGUAGES = ["en", "id"]',
    );
    expect(capabilities).toContain(
      "mode === SpokenLanguageMode.MULTILINGUAL",
    );
  });

  it("canonicalizes before session persistence, request preparation, and idempotency", () => {
    expect(setup).toContain("resolveSupportedTranscriptionLanguageSelection");
    expect(setup).toContain(
      "expectedSpokenLanguages: languageSelection.languages",
    );
    expect(sessionService).toContain(
      "resolveSupportedTranscriptionLanguageSelection",
    );
    expect(sessionService).toContain(
      "expected_spoken_languages: languageSelection.languages",
    );
    expect(contracts).toContain(
      "resolveSupportedTranscriptionLanguageSelection",
    );
    expect(contracts).toContain("selection.languages.join");
    expect(contracts).toContain("TRANSCRIPTION_LANGUAGE_UNSUPPORTED");
  });

  it("matches the reviewed server intake normalization boundary", () => {
    expect(requestMigration).toContain(
      "normalized_language in ('en','en-au','en-gb','en-uk','en-us')",
    );
    expect(requestMigration).toContain(
      "normalized_languages <> array['en','id']::text[]",
    );
    expect(capabilities).toContain('"en-au"');
    expect(capabilities).toContain('"en-gb"');
    expect(capabilities).toContain('"en-uk"');
    expect(capabilities).toContain('"en-us"');
  });

  it("does not add provider execution or privileged credentials to mobile code", () => {
    const combined = `${setup}\n${capabilities}\n${contracts}\n${sessionService}`;
    for (const forbidden of [
      "ASSEMBLYAI_API_KEY",
      "PROJECT_RECALL_TRANSCRIPTION_WORKER_TOKEN",
      "service_role",
      "functions.invoke",
      "api.assemblyai.com",
    ]) {
      expect(combined).not.toContain(forbidden);
    }
  });
});
