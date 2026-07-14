import { test, expect, describe } from "bun:test";
import {
  validateOptionValue,
  optionTemplateDefault,
  narrateStatus,
  type OptionSpec,
} from "../src/sources/source.ts";

// The config seam builds this same label; pin the exact wording in messages.
const LABEL = `option "kinds" for source "graph"`;

describe("validateOptionValue", () => {
  describe("string[]", () => {
    const spec: OptionSpec = { type: "string[]", description: "list" };

    test("an array of strings is valid", () => {
      expect(validateOptionValue(spec, ["a", "b"], LABEL)).toBeNull();
    });

    test("a non-array fails", () => {
      expect(validateOptionValue(spec, "nope", LABEL)).toBe(
        `option "kinds" for source "graph" must be an array of strings.`,
      );
    });

    test("an array with a non-string member fails", () => {
      expect(validateOptionValue(spec, ["a", 1], LABEL)).toBe(
        `option "kinds" for source "graph" must be an array of strings.`,
      );
    });
  });

  describe("string[] with enum", () => {
    const spec: OptionSpec = { type: "string[]", enum: ["event", "message"], description: "kinds" };

    test("all members in the enum is valid", () => {
      expect(validateOptionValue(spec, ["event"], LABEL)).toBeNull();
    });

    test("a member outside the enum fails, quoting the enum", () => {
      expect(validateOptionValue(spec, ["chat"], LABEL)).toBe(
        `option "kinds" for source "graph": "chat" is not one of ${JSON.stringify(["event", "message"])}.`,
      );
    });
  });

  describe("string", () => {
    const spec: OptionSpec = { type: "string", description: "a string" };

    test("a string is valid", () => {
      expect(validateOptionValue(spec, "hi", LABEL)).toBeNull();
    });

    test("a non-string fails", () => {
      expect(validateOptionValue(spec, 42, LABEL)).toBe(`option "kinds" for source "graph" must be a string.`);
    });
  });

  describe("boolean", () => {
    const spec: OptionSpec = { type: "boolean", description: "a bool" };

    test("a boolean is valid", () => {
      expect(validateOptionValue(spec, false, LABEL)).toBeNull();
    });

    test("a non-boolean fails", () => {
      expect(validateOptionValue(spec, "true", LABEL)).toBe(`option "kinds" for source "graph" must be a boolean.`);
    });
  });

  describe("number", () => {
    const spec: OptionSpec = { type: "number", description: "a number" };

    test("a number is valid", () => {
      expect(validateOptionValue(spec, 7, LABEL)).toBeNull();
    });

    test("a non-number fails", () => {
      expect(validateOptionValue(spec, "7", LABEL)).toBe(`option "kinds" for source "graph" must be a number.`);
    });
  });
});

describe("optionTemplateDefault", () => {
  test("string[] with enum lists its members", () => {
    const spec: OptionSpec = { type: "string[]", enum: ["event", "message"], description: "kinds" };
    expect(optionTemplateDefault(spec)).toBe(JSON.stringify(["event", "message"]));
  });

  test("string[] without enum is an empty array", () => {
    expect(optionTemplateDefault({ type: "string[]", description: "list" })).toBe("[]");
  });

  test("boolean is false", () => {
    expect(optionTemplateDefault({ type: "boolean", description: "b" })).toBe("false");
  });

  test("number is 0", () => {
    expect(optionTemplateDefault({ type: "number", description: "n" })).toBe("0");
  });

  test("string is an empty string literal", () => {
    expect(optionTemplateDefault({ type: "string", description: "s" })).toBe('""');
  });
});

describe("narrateStatus", () => {
  test("ready with identity: identity is the note, regardless of interactivity", () => {
    expect(narrateStatus({ state: "ready", identity: "me@example.com" }, { interactive: true })).toEqual({
      glyph: "✓",
      label: "ready",
      note: "me@example.com",
    });
  });

  test("ready without identity, interactive source: no note (a plain 'ready')", () => {
    expect(narrateStatus({ state: "ready" }, { interactive: true })).toEqual({
      glyph: "✓",
      label: "ready",
      note: undefined,
    });
  });

  test("ready without identity, no-auth source: '(no auth required)'", () => {
    expect(narrateStatus({ state: "ready" }, { interactive: false })).toEqual({
      glyph: "✓",
      label: "ready",
      note: "(no auth required)",
    });
  });

  test("not-authenticated: ✗ + the login remedy", () => {
    expect(narrateStatus({ state: "not-authenticated" }, { interactive: true })).toEqual({
      glyph: "✗",
      label: "not authenticated",
      remedy: "rundown login",
    });
  });

  test("not-configured with a detail: ○ + detail note + the status remedy", () => {
    expect(narrateStatus({ state: "not-configured", detail: "set LINEAR_API_KEY" }, { interactive: false })).toEqual({
      glyph: "○",
      label: "not configured",
      note: "set LINEAR_API_KEY",
      remedy: "rundown status",
    });
  });

  test("not-configured without a detail: no note", () => {
    expect(narrateStatus({ state: "not-configured" }, { interactive: false })).toEqual({
      glyph: "○",
      label: "not configured",
      note: undefined,
      remedy: "rundown status",
    });
  });
});
