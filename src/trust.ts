// The `Untrusted<T>` box and the single unwrap primitive (ADR-0004 §3), hardened
// as a real runtime box so accidental leaks redact instead of leaking.
//
// Every untrusted field a Source emits (`id`, `url`, `title`, all of `extras`)
// carries this brand. It is a REAL runtime box now, not a phantom cast: at
// runtime the value is wrapped in an `UntrustedBox` instance, and the type
// system additionally treats `Untrusted<T>` as opaque — not assignable to `T`
// and not accepted where a plain `T` is expected (enforced by a TypeScript
// `private` field, so only a genuine `UntrustedBox` instance satisfies the
// type; no other object can structurally impersonate one). So the only way to
// obtain the raw bytes through the type system is an explicit `unwrap()`, and
// the call sites of `unwrap()` ARE the leak-path audit: a short, greppable
// list of every place untrusted data legitimately flows. The sole legitimate
// unwrap site is the summarizer-prompt assembly in `plan.ts`.
//
// The box is a defense-in-depth layer UNDERNEATH the type-level guarantee: any
// path the typechecker can't see (a `catch (e)` stringifying an item,
// `console.error(JSON.stringify(item))`, an `any` leak) hits the box's
// accidental-serialization surface instead of the raw bytes. `toString()`,
// `toJSON()`, `Symbol.toPrimitive`, and the Node/Bun console-inspect symbol
// all yield the fixed marker `"[untrusted]"` — so `String(box)`,
// `` `${box}` ``, `JSON.stringify(box)` (including of any object graph
// containing it), and console inspection all redact rather than leak.
//
// Guarantee scope: dev-time types (editor / `tsc --noEmit` in CI) PLUS runtime
// redaction on every accidental-serialization channel above. Bun does not
// typecheck at runtime, so the type-level guarantee alone was insufficient
// against typechecker-invisible paths; the box closes that gap. The primary
// structural seal remains the compiled binary (ADR-0004 §4).

const REDACTED = "[untrusted]";

/**
 * The runtime box. `raw` is a TypeScript `private` field — not a real
 * (unforgeable) JS private, but enough for TypeScript's nominal-typing rule
 * for private/protected members: a type is only assignable to `UntrustedBox<T>`
 * if it originates from this exact class declaration, so no plain object or
 * lying cast can structurally impersonate one. Every accidental-serialization
 * channel is overridden to emit the redaction marker instead of `raw`.
 */
class UntrustedBox<T> {
  private readonly raw: T;

  constructor(raw: T) {
    this.raw = raw;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

/** An opaque, boxed wrapper marking a value as untrusted backend content. */
export type Untrusted<T> = UntrustedBox<T>;

/** Brand a raw value as untrusted by boxing it in a real runtime wrapper. */
export function untrusted<T>(value: T): Untrusted<T> {
  return new UntrustedBox(value);
}

/**
 * The sole primitive that yields the raw bytes of an untrusted value. Every
 * call site is a deliberate, reviewable point in the leak-path audit. The
 * cast through `unknown` here is the one place trust.ts itself reaches past
 * the `private` field — it is the definition of the primitive, not a leak.
 */
export function unwrap<T>(value: Untrusted<T>): T {
  return (value as unknown as { raw: T }).raw;
}

/** Brand an optional value, preserving `undefined`. */
export function untrustedOpt<T>(value: T | undefined): Untrusted<T> | undefined {
  return value === undefined ? undefined : untrusted(value);
}
