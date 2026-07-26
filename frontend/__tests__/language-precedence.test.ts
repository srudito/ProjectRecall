import { SpokenLanguageMode } from "@/src/domain/enums";
import {
  resolveLanguagePreference,
  validateSpokenLanguageSelection,
} from "@/src/services/language/precedence";

describe("language precedence", () => {
  it("session-specific wins over project, user, app default", () => {
    expect(
      resolveLanguagePreference({
        session: "session_val",
        project: "project_val",
        user: "user_val",
        appDefault: "app_val",
      }),
    ).toBe("session_val");
  });

  it("falls back to project when no session-specific value", () => {
    expect(
      resolveLanguagePreference({
        session: null,
        project: "project_val",
        user: "user_val",
        appDefault: "app_val",
      }),
    ).toBe("project_val");
  });

  it("falls back to user when project is missing", () => {
    expect(
      resolveLanguagePreference({
        session: null,
        project: null,
        user: "user_val",
        appDefault: "app_val",
      }),
    ).toBe("user_val");
  });

  it("uses app default when all others are missing", () => {
    expect(
      resolveLanguagePreference({
        session: null,
        project: null,
        user: null,
        appDefault: "en",
      }),
    ).toBe("en");
  });
});

describe("spoken language mode validation", () => {
  it("AUTO_DETECT accepts empty hints", () => {
    expect(validateSpokenLanguageSelection(SpokenLanguageMode.AUTO_DETECT, [])).toEqual({ valid: true });
  });
  it("SINGLE_LANGUAGE requires exactly one", () => {
    expect(validateSpokenLanguageSelection(SpokenLanguageMode.SINGLE_LANGUAGE, []).valid).toBe(false);
    expect(validateSpokenLanguageSelection(SpokenLanguageMode.SINGLE_LANGUAGE, ["en"]).valid).toBe(true);
    expect(validateSpokenLanguageSelection(SpokenLanguageMode.SINGLE_LANGUAGE, ["en", "id"]).valid).toBe(false);
  });
  it("MULTILINGUAL requires two or more", () => {
    expect(validateSpokenLanguageSelection(SpokenLanguageMode.MULTILINGUAL, []).valid).toBe(false);
    expect(validateSpokenLanguageSelection(SpokenLanguageMode.MULTILINGUAL, ["en"]).valid).toBe(false);
    expect(validateSpokenLanguageSelection(SpokenLanguageMode.MULTILINGUAL, ["en", "id"]).valid).toBe(true);
  });
});
