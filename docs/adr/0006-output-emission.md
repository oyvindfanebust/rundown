# ADR 0006 — The output emission boundary

**Status:** Accepted

Builds on the Planner and Summarizer components ([ADR-0005](0005-planning-layer.md) — the Brief is
structured content, the agent owns presentation) and the trust boundary
([ADR-0004](0004-trust-boundary-enforcement.md) — the brief crossing to the agent is the accepted
residual).

## Context

Emission is where the [Brief](../../CONTEXT.md) leaves `rundown`. A coding agent triggers planning
on demand and is always in the loop; there is no unattended cron writing the Brief anywhere on its
own. [ADR-0005](0005-planning-layer.md) already made the Brief a structured content contract
(`{envelope, summary, items}`) with all presentation and landing assigned to the consuming agent.
Given that, the question this ADR settles is whether `rundown` owns any output mechanism beyond
producing the Brief, or stops there. A `rundown`-owned renderer or vault-writer would re-import
presentation into the toolkit.

## Decision

### 1. No output sinks — `rundown` emits the Brief and stops

`rundown` provides no pluggable output sinks. There is no vault-writer, no file-writer, no sink
registry. `rundown brief` produces the Brief and emits it; landing and rendering are entirely the
consuming agent's job, exactly as ADR-0005 states. Where the Brief ultimately goes (a daily note, a
file, a chat message) and how it is formatted are agent concerns, configured — if at all — on the
agent/skill side, never in `~/.config/rundown/`.

This follows directly from ADR-0005 and it shrinks the toolkit's surface: one fewer thing `rundown`
does with untrusted-derived data.

### 2. The emission contract — JSON on stdout

`rundown brief` writes the Brief as a single JSON object to stdout: a direct serialization of the
Brief type ADR-0005 already fixed, one Brief per invocation. Nothing is rendered, and there is no
`--format` switch, since formatting is the agent's job and a format flag would be presentation
re-entering `rundown`.

- stdout is either a valid Brief or empty. Errors, summarizer failures, and refusals go to stderr
  with a non-zero exit (fail-hard, per ADR-0005). The agent never has to parse a partial or
  error-shaped Brief out of stdout.
- Empty bundle → empty Brief, exit 0. ADR-0005 short-circuits an empty bundle to an empty Brief
  with no model call. That empty Brief is emitted as ordinary JSON (envelope with zero-count
  sources, empty `items`, empty/absent `summary`) and exits 0; "nothing to plan" is data, not an
  error.

### 3. Emission is the CLI-exit boundary

Emission names the point where the structured Brief crosses out of the compiled `rundown` binary to
the agent, the emission / CLI-exit boundary. Naming this crossing is worthwhile because it is the
accepted trust-boundary exit (ADR-0004 §5 row 7). There is no sink mechanism and nothing else for
`rundown` to name beyond this one crossing.

### 4. Trust — no new leak path; the surface shrinks

`rundown`'s only agent-facing output from `brief` is the Brief JSON on stdout. Against
ADR-0004 §5:

- Row 7 (summarizer output → agent, the brief) is the stdout emission: the intended, accepted
  crossing, mitigated by the Layer 1–3 stack (hardened summarizer; structured output labels any
  leaked content as quoted data; agent treats-as-data).
- Row 8 (brief lands somewhere, agent later reads it) is now entirely an agent action, since
  `rundown` never writes it anywhere. The trust status is unchanged: untrusted-derived,
  treat-as-data. The writer is the agent, not `rundown`.

No new path opens. stdout carries only the post-summarizer Brief: no `extras`, no Bundle, no raw
source content. The `Untrusted<T>` seal (ADR-0004 §3) already guarantees the serialized Brief holds
no unwrapped source bytes beyond the summarizer's own quoted `evidence`, which is the Layer-2
injection quarantine by design. `rundown` owning no output mechanism beyond stdout keeps the trust
surface as small as it can be.

### 5. Config fallout — what leaves config

This keeps the selection-vs-mechanism split clean, mirroring how Source relates to selection:

- Sink-selection and vault-path leave config entirely. There is no sink mechanism to select and no
  path for `rundown` to write to. Where the Brief lands is the agent's concern.
- Render-time personalization is agent-side. Sections, ordering, tone, and format are applied to
  the Brief by the agent (ADR-0005, agent owns presentation), not executed by a config-driven
  renderer.
- Config keeps only what feeds the binary: source selection and options, window construction
  (timezone → two absolute instants), and the trusted planning-guidance seam (config → the
  Summarizer's instruction region).

## Consequences

**Positive**

- The emission boundary stays clean: `rundown` produces the Brief, and presentation and storage
  never re-enter the toolkit. ADR-0005's "agent owns presentation" is upheld end-to-end.
- The trust surface shrinks by one untrusted-derived write path, with no behavioral change to the
  accepted crossings.
- The emission contract is simple to implement and test: serialize an existing typed value to
  stdout, fail-hard to stderr.

**Negative / accepted costs**

- No format consistency guarantee from `rundown`. Because rendering is the agent's, two runs can
  produce differently-formatted output. If consistent rendering is wanted, it is the responsibility
  of the `rundown` SKILL.md's rendering guidance (skills-inventory work), not `rundown`. This is the
  direct cost of ADR-0005's presentation split, chosen deliberately.
- An agent that wants the Brief in a file/vault must do the write itself. Accepted, and intended:
  the agent triggers planning on demand and is always in the loop.

**Follow-ups**

- Config & personalization ([ADR-0007](0007-config-personalization-layer.md)): config owns source
  selection, window construction, and the planning-guidance seam, and explicitly not sink-selection
  or vault-path.
- Skills inventory ([ADR-0009](0009-skills-collection.md)): consistent Brief rendering, where
  desired, is carried by the `rundown` SKILL.md's rendering guidance.
