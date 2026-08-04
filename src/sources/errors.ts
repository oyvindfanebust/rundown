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
  const error = new Error(`${name} request failed${status !== undefined ? `: ${status}` : ""}`);
  // Re-expose the status as a trusted numeric scalar on the thrown error. Without
  // it the code survives only inside the message string, so a downstream
  // trusted-only channel (a `status()` detail, ADR-0015 §1) would have to parse
  // prose to recover it — or, as it did, silently lose it. Nothing else is
  // attached, so the error still carries no backend-authored bytes.
  if (status !== undefined) (error as Error & { status?: number }).status = status;
  return error;
}

/**
 * The ` (HTTP <status>)` fragment a source appends to a rejected-credential
 * `status()` detail, or `""` when the caught error carries no status (a DNS
 * failure, a timeout). A `status()` catch would otherwise discard the code the
 * transport error already carries, which is what made a scoped-token 401 read the
 * same as a 403 or a 5xx (ADR-0015 §1).
 *
 * Like {@link statusOnlyError} it reads only the status scalar via {@link statusOf}
 * — never a message or body — so a `status()` detail can never carry backend bytes
 * (ADR-0004 §5). Shared rather than formatted per source so the wording cannot drift.
 */
export function httpStatusNote(err: unknown): string {
  const status = statusOf(err);
  return status !== undefined ? ` (HTTP ${status})` : "";
}
