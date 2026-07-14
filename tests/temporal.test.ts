import { test, expect, describe } from "bun:test";
import { parseWindowSelector, resolveSelector, WindowError } from "../src/temporal.ts";

describe("resolveSelector — span math", () => {
  const wed = new Date("2026-07-08T12:00:00Z"); // a Wednesday

  test("today in UTC is a calendar day", () => {
    expect(resolveSelector({ kind: "span", span: "today" }, "UTC", wed)).toEqual({
      from: "2026-07-08T00:00:00.000Z",
      to: "2026-07-09T00:00:00.000Z",
    });
  });

  test("this-week is Monday→Monday in the timezone", () => {
    // Oslo is CEST (+02) in July; local midnight is 22:00Z the prior day.
    expect(resolveSelector({ kind: "span", span: "this-week" }, "Europe/Oslo", wed)).toEqual({
      from: "2026-07-05T22:00:00.000Z",
      to: "2026-07-12T22:00:00.000Z",
    });
  });

  test("next-week is the following Monday→Monday", () => {
    expect(resolveSelector({ kind: "span", span: "next-week" }, "UTC", wed)).toEqual({
      from: "2026-07-13T00:00:00.000Z",
      to: "2026-07-20T00:00:00.000Z",
    });
  });

  test("last-week is the preceding Monday→Monday", () => {
    expect(resolveSelector({ kind: "span", span: "last-week" }, "UTC", wed)).toEqual({
      from: "2026-06-29T00:00:00.000Z",
      to: "2026-07-06T00:00:00.000Z",
    });
  });

  test("is deterministic — same inputs, same output", () => {
    expect(resolveSelector({ kind: "span", span: "this-week" }, "UTC", wed)).toEqual(
      resolveSelector({ kind: "span", span: "this-week" }, "UTC", wed),
    );
  });
});

describe("parseWindowSelector", () => {
  test("a symbolic span parses to a span selector", () => {
    expect(parseWindowSelector("this-week")).toEqual({ kind: "span", span: "this-week" });
  });

  test("an explicit range parses to a range selector with a literal label", () => {
    expect(parseWindowSelector("2026-07-06..2026-07-12")).toEqual({
      kind: "range",
      from: { y: 2026, m: 7, d: 6 },
      to: { y: 2026, m: 7, d: 12 },
      label: "2026-07-06..2026-07-12",
    });
  });

  test("a single date is shorthand for from..from", () => {
    expect(parseWindowSelector("2026-07-14")).toEqual({
      kind: "range",
      from: { y: 2026, m: 7, d: 14 },
      to: { y: 2026, m: 7, d: 14 },
      label: "2026-07-14",
    });
  });

  test("rejects an unreal calendar date", () => {
    expect(() => parseWindowSelector("2026-02-30")).toThrow(/calendar date/);
  });

  test("rejects an out-of-range month", () => {
    expect(() => parseWindowSelector("2026-13-01")).toThrow(/calendar date/);
  });

  test("rejects from > to", () => {
    expect(() => parseWindowSelector("2026-07-12..2026-07-06")).toThrow(/after end/);
  });

  test("rejects a half-open range (missing end)", () => {
    expect(() => parseWindowSelector("2026-07-01..")).toThrow(WindowError);
  });

  test("rejects a half-open range (missing start)", () => {
    expect(() => parseWindowSelector("..2026-07-01")).toThrow(WindowError);
  });

  test("rejects a three-part range", () => {
    expect(() => parseWindowSelector("2026-07-01..2026-07-02..2026-07-03")).toThrow(WindowError);
  });

  test("rejects a datetime (date-only granularity)", () => {
    expect(() => parseWindowSelector("2026-07-06T09:00")).toThrow(WindowError);
  });

  test("rejects an unknown span", () => {
    expect(() => parseWindowSelector("yesterday")).toThrow(/Expected a span/);
  });
});

describe("resolveSelector", () => {
  const wed = new Date("2026-07-08T12:00:00Z"); // a Wednesday

  test("a span selector resolves like resolveWindow", () => {
    expect(resolveSelector({ kind: "span", span: "today" }, "UTC", wed)).toEqual({
      from: "2026-07-08T00:00:00.000Z",
      to: "2026-07-09T00:00:00.000Z",
    });
  });

  test("an explicit range is inclusive of the end date (end + 1 day, exclusive)", () => {
    expect(resolveSelector(parseWindowSelector("2026-07-06..2026-07-12"), "UTC", wed)).toEqual({
      from: "2026-07-06T00:00:00.000Z",
      to: "2026-07-13T00:00:00.000Z",
    });
  });

  test("a single date resolves to that one calendar day", () => {
    expect(resolveSelector(parseWindowSelector("2026-07-14"), "UTC", wed)).toEqual({
      from: "2026-07-14T00:00:00.000Z",
      to: "2026-07-15T00:00:00.000Z",
    });
  });

  test("range midnights resolve against the timezone", () => {
    // Oslo is CEST (+02) in July; local midnight is 22:00Z the prior day.
    expect(resolveSelector(parseWindowSelector("2026-07-06..2026-07-12"), "Europe/Oslo", wed)).toEqual({
      from: "2026-07-05T22:00:00.000Z",
      to: "2026-07-12T22:00:00.000Z",
    });
  });

  test("a range is independent of `now`", () => {
    const a = resolveSelector(parseWindowSelector("2026-07-06..2026-07-12"), "UTC", new Date("2020-01-01T00:00:00Z"));
    const b = resolveSelector(parseWindowSelector("2026-07-06..2026-07-12"), "UTC", new Date("2030-01-01T00:00:00Z"));
    expect(a).toEqual(b);
  });
});
