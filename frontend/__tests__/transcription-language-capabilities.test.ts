import { SpokenLanguageMode } from "@/src/domain/enums";
import {
  getTranscriptionLanguageSelectionForMode,
  resolveSupportedTranscriptionLanguageSelection,
  SUPPORTED_TRANSCRIPTION_LANGUAGE_CODES,
  TRANSCRIPTION_CODE_SWITCHING_LANGUAGES,
} from "@/src/services/transcription/language-capabilities";

describe("transcription language capabilities", () => {
  it("exposes only the reviewed manual rollout languages", () => {
    expect(SUPPORTED_TRANSCRIPTION_LANGUAGE_CODES).toEqual(["en", "id"]);
    expect(TRANSCRIPTION_CODE_SWITCHING_LANGUAGES).toEqual(["en", "id"]);
  });

  it.each(["en", "EN", "en_AU", "en-GB", "en-UK", "en-US"])(
    "canonicalizes supported English alias %s",
    (language) => {
      expect(
        resolveSupportedTranscriptionLanguageSelection(
          SpokenLanguageMode.SINGLE_LANGUAGE,
          [language],
        ),
      ).toEqual({ ok: true, languages: ["en"] });
    },
  );

  it("keeps canonical Bahasa Indonesia and rejects regional aliases not accepted by the server", () => {
    expect(
      resolveSupportedTranscriptionLanguageSelection(
        SpokenLanguageMode.SINGLE_LANGUAGE,
        ["id"],
      ),
    ).toEqual({ ok: true, languages: ["id"] });

    expect(
      resolveSupportedTranscriptionLanguageSelection(
        SpokenLanguageMode.SINGLE_LANGUAGE,
        ["id-ID"],
      ),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        code: "TRANSCRIPTION_LANGUAGE_UNSUPPORTED",
      }),
    );
  });

  it("allows automatic detection without hints and canonicalizes reviewed hints", () => {
    expect(
      resolveSupportedTranscriptionLanguageSelection(
        SpokenLanguageMode.AUTO_DETECT,
        [],
      ),
    ).toEqual({ ok: true, languages: [] });

    expect(
      resolveSupportedTranscriptionLanguageSelection(
        SpokenLanguageMode.AUTO_DETECT,
        ["ID", "en_us"],
      ),
    ).toEqual({ ok: true, languages: ["en", "id"] });

    expect(
      resolveSupportedTranscriptionLanguageSelection(
        SpokenLanguageMode.AUTO_DETECT,
        ["EN", "en-US", "id"],
      ),
    ).toEqual({ ok: true, languages: ["en", "id"] });
  });

  it("requires exactly one supported language in single-language mode", () => {
    for (const selection of [[], ["en", "id"]]) {
      expect(
        resolveSupportedTranscriptionLanguageSelection(
          SpokenLanguageMode.SINGLE_LANGUAGE,
          selection,
        ),
      ).toEqual(
        expect.objectContaining({
          ok: false,
          code: "TRANSCRIPTION_LANGUAGE_SELECTION_INVALID",
        }),
      );
    }
  });

  it("requires the exact English and Bahasa Indonesia code-switching pair", () => {
    expect(
      resolveSupportedTranscriptionLanguageSelection(
        SpokenLanguageMode.MULTILINGUAL,
        ["ID", "en-GB"],
      ),
    ).toEqual({ ok: true, languages: ["en", "id"] });

    for (const selection of [["en"], ["en", "EN"], ["id", "id"]]) {
      expect(
        resolveSupportedTranscriptionLanguageSelection(
          SpokenLanguageMode.MULTILINGUAL,
          selection,
        ),
      ).toEqual(
        expect.objectContaining({
          ok: false,
          code: "TRANSCRIPTION_LANGUAGE_SELECTION_INVALID",
        }),
      );
    }
  });

  it("distinguishes malformed and unsupported language values", () => {
    expect(
      resolveSupportedTranscriptionLanguageSelection(
        SpokenLanguageMode.SINGLE_LANGUAGE,
        [" en"],
      ),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        code: "TRANSCRIPTION_LANGUAGE_CODE_INVALID",
      }),
    );

    expect(
      resolveSupportedTranscriptionLanguageSelection(
        SpokenLanguageMode.SINGLE_LANGUAGE,
        ["ja"],
      ),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        code: "TRANSCRIPTION_LANGUAGE_UNSUPPORTED",
      }),
    );
  });

  it("keeps setup mode transitions deterministic", () => {
    expect(
      getTranscriptionLanguageSelectionForMode(
        SpokenLanguageMode.AUTO_DETECT,
        ["en"],
      ),
    ).toEqual([]);
    expect(
      getTranscriptionLanguageSelectionForMode(
        SpokenLanguageMode.SINGLE_LANGUAGE,
        ["id", "en"],
      ),
    ).toEqual(["id"]);
    expect(
      getTranscriptionLanguageSelectionForMode(
        SpokenLanguageMode.MULTILINGUAL,
        [],
      ),
    ).toEqual(["en", "id"]);
  });
});
