// The runtime box's redaction guarantees, alongside the pre-existing
// round-trip/untrustedOpt coverage. Every accidental-serialization channel —
// toString/template interpolation, JSON.stringify (top-level and nested in an
// object graph), and console inspection — must emit the fixed "[untrusted]"
// marker and never the raw bytes, since the whole point of the box is to
// redact leaks a typechecker can't see (a stray `any`, a `catch` block that
// stringifies an item, `console.error(JSON.stringify(item))`).

import { test, expect } from "bun:test";
import { inspect } from "node:util";
import { untrusted, unwrap, untrustedOpt } from "../src/trust.ts";
import type { AnnotatedItem } from "../src/domain.ts";

test("unwrap returns the original value", () => {
  expect(unwrap(untrusted("hello"))).toBe("hello");
  const obj = { a: 1 };
  expect(unwrap(untrusted(obj))).toBe(obj);
});

test("untrustedOpt preserves undefined", () => {
  expect(untrustedOpt(undefined)).toBeUndefined();
  expect(unwrap(untrustedOpt("x")!)).toBe("x");
});

// ── 1. every accidental-serialization channel redacts, never leaks ──

test("String() redacts, never leaks the raw bytes", () => {
  const box = untrusted("secret");
  expect(String(box)).toContain("[untrusted]");
  expect(String(box)).not.toContain("secret");
});

test("template interpolation redacts, never leaks the raw bytes", () => {
  const box = untrusted("secret");
  const s = `value: ${box}`;
  expect(s).toContain("[untrusted]");
  expect(s).not.toContain("secret");
});

test("JSON.stringify of the box itself redacts, never leaks the raw bytes", () => {
  const box = untrusted("secret");
  const s = JSON.stringify(box);
  expect(s).toContain("[untrusted]");
  expect(s).not.toContain("secret");
});

test("JSON.stringify of an object graph containing the box redacts at every depth", () => {
  const s = JSON.stringify({ deep: { nested: untrusted("secret") } });
  expect(s).toContain("[untrusted]");
  expect(s).not.toContain("secret");
});

test("console/util.inspect redacts, never leaks the raw bytes", () => {
  const box = untrusted("secret");
  const s = inspect(box);
  expect(s).toContain("[untrusted]");
  expect(s).not.toContain("secret");
});

// ── 2. unwrap round-trips byte-identical ──

test("unwrap round-trips a string byte-identical", () => {
  expect(unwrap(untrusted("hello world"))).toBe("hello world");
});

test("unwrap round-trips an object (extras-shaped) identically, same reference", () => {
  const extras = { organizer: "Alice", attendees: ["Bo", "Cy"], count: 0 };
  const box = untrusted(extras);
  expect(unwrap(box)).toBe(extras); // same reference, not a clone
  expect(unwrap(box)).toEqual(extras);
});

test("unwrap round-trips an array identically, same reference", () => {
  const arr = ["a", "b", "c"];
  const box = untrusted(arr);
  expect(unwrap(box)).toBe(arr);
});

// ── 3. untrustedOpt ──

test("untrustedOpt(undefined) is undefined; untrustedOpt(x) boxes x", () => {
  expect(untrustedOpt(undefined)).toBeUndefined();
  const boxed = untrustedOpt("present")!;
  expect(unwrap(boxed)).toBe("present");
  expect(String(boxed)).toBe("[untrusted]");
});

// ── 4. an AnnotatedItem-shaped object graph leaks no title/url/extras bytes ──

test("JSON.stringify of an AnnotatedItem-shaped graph leaks no title/url/extras bytes", () => {
  const item: AnnotatedItem = {
    source: "graph",
    kind: "event",
    timestamp: "2026-07-08T09:00:00Z",
    bucket: "recent",
    id: untrusted("secret-id-123"),
    title: untrusted("SECRET MEETING TITLE"),
    url: untrusted("https://secret.example/leak"),
    extras: untrusted({ body: "SECRET BODY TEXT", organizer: "SECRET ORGANIZER" }),
  };

  const s = JSON.stringify(item);
  expect(s).not.toContain("secret-id-123");
  expect(s).not.toContain("SECRET MEETING TITLE");
  expect(s).not.toContain("secret.example");
  expect(s).not.toContain("SECRET BODY TEXT");
  expect(s).not.toContain("SECRET ORGANIZER");
  // Trusted structural fields still come through untouched.
  expect(s).toContain("graph");
  expect(s).toContain("event");
  expect(s).toContain("recent");
});
