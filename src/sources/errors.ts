// Shared Source error scrub (ADR-0004 §5): the one home for turning a failed
// remote request into a thrown error that carries only the HTTP status — never a
// backend-authored body byte. A read()/status() transport error propagates to
// cli.ts fail() → stderr, an agent-readable channel; a Graph `error.message`, a
// Linear GraphQL error string, or any body an external party can shape must never
// cross into that message. Both remote sources throw through here so the
// status-only rule has a single audited definition, beside the Untrusted<T> unwrap
// sites (trust.ts) as a leak-path audit surface.

/** The status-bearing shapes a caught transport error (or a non-ok Response) can take. */
interface StatusBearing {
  status?: unknown;
  response?: { status?: unknown };
}

/**
 * The numeric HTTP status carried by `source`, or undefined. Reads only `.status`
 * (a `fetch` Response, or an SDK `LinearError`) and `.response.status` (a raw
 * `GraphQLClientError`) — both trusted structural scalars. It never touches a
 * message, body, or any other field, so no externally-authorable bytes can be
 * read out, whatever else the object carries.
 */
function statusOf(source: unknown): number | undefined {
  const s = source as StatusBearing | null | undefined;
  const candidate = s?.status ?? s?.response?.status;
  return typeof candidate === "number" ? candidate : undefined;
}

/**
 * Build the error thrown when a remote Source request fails: a generic
 * `<name> request failed` plus the HTTP status when one is present, and nothing
 * else. `name` is the caller-supplied label (e.g. "Graph", "Linear"); `err` is the
 * caught error or the non-ok Response — only its status scalar is read (see
 * {@link statusOf}). This is the sole formatter for the ADR-0004 §5 status-only
 * scrub across sources.
 */
export function statusOnlyError(name: string, err: unknown): Error {
  const status = statusOf(err);
  return new Error(`${name} request failed${status !== undefined ? `: ${status}` : ""}`);
}
