# ADR 0022 — The trust boundary for the digest

**Status:** Accepted

Supersedes [ADR-0004](0004-trust-boundary-enforcement.md). Decided on the map
[#117](https://github.com/oyvindfanebust/rundown/issues/117), specified in
[#141](https://github.com/oyvindfanebust/rundown/issues/141) and built in
[#150](https://github.com/oyvindfanebust/rundown/issues/150). Builds on typed records
([ADR-0019](0019-typed-records.md) §2, trust follows type) and the digest
([ADR-0021](0021-the-digest.md)).

## Context

The rule is unchanged: untrusted source content meets a model only in the sandboxed, tool-less
Summarizer. ADR-0004 enforced it for the Brief, where the model wrote everything the agent read
except a fixed list of trusted envelope fields, and the summarizer-prompt assembly was the only
place untrusted bytes were read.

The digest changes what crosses. Most of each entry is now filled by code: counts, times, flags and
enums from typed records, and subjects, titles and names copied from records rather than relayed
by the model. Copying source text by code is a second read of untrusted bytes, and grouping mail
reads senders and subjects. The boundary needs a rule for every output field and a second,
equally narrow extraction site.

## Decision

### 1. Three output classes

Every digest field has exactly one class, recorded as Zod metadata in the contract (ADR-0021 §3):

- **trusted value:** a number, instant, boolean, closed enum or digest. Parsed from the backend's
  bytes by the source or computed by code, and dropped when the parse fails. Its type cannot carry
  text.
- **label:** source text copied by code: a subject, a meeting title, a person's name, a channel,
  a room or a location. Unfabricated, not trusted. It is stripped of smuggled codepoints, defanged,
  collapsed to one line and clamped with a trailing "…": 255 chars for subjects and titles, 120
  for names, channels, rooms and locations. An empty label is absent.
- **model output:** the overview and the entry summaries. Defanged, clamped with a trailing "…"
  and length-bounded by the digest schema (2,000 and 300).

### 2. Never out

Bodies, addresses, Slack handles and user ids, backend ids, URLs and mail or calendar categories
never leave the binary. A body reaches only the Summarizer. A backend id leaves only as a one-way
digest (ADR-0020 §5).

### 3. `Untrusted<T>` has two extraction sites

`Untrusted<T>` stays as ADR-0004 §3 built it: a runtime box in `src/trust.ts` whose `toString()`,
`toJSON()`, `Symbol.toPrimitive` and console-inspect channels all yield `"[untrusted]"`, opaque to
TypeScript through a private field, with `unwrap()` the only extraction primitive. The normalizer
(`src/sources/normalize.ts`) brands source text at the source edge (ADR-0019 §6).

Two places call `unwrap()`:

- **The Digester's unwrap** (`src/digester.ts`), for Summarizer input and for grouping: the mail
  merge's sender and subject comparison (ADR-0020 §4).
- **`label()`** (`src/label.ts`), which turns an untrusted string into a label per §1.

`src/sanitize.ts` holds the pure string transforms both sites and the Summarizer share, the
invisible-Unicode strip and the defang, and never unwraps. `scripts/check-unwrap-sites.sh` fails
CI on any `unwrap` import or call outside `src/trust.ts` (the definition), `src/digester.ts` and
`src/label.ts`, and its test allows exactly those.

### 4. The structural seal is unchanged

The sources → aggregate → summarize hop runs inside the compiled binary. The agent-facing surface is
`rundown digest`, `login`, `status`, `init` and `--version`; no command emits raw source data, and
the release build has no raw-dump path ([ADR-0008](0008-bounded-context-and-component-architecture.md)
§6–§7). The Bundle and the rendered Summarizer input stay in memory.

### 5. Defense in three layers

- **Layer 1, the Summarizer resists obeying.** The instruction region is trusted and the data
  arrives inside an `<untrusted-data>` delimiter whose closing tag carries a per-request nonce, so
  source bytes cannot close it. A literal un-nonced closing tag in the data is neutralized, and
  invisible and smuggled Unicode (the tag block, bidi controls, standalone zero-width and BOM
  characters) is stripped before the call. The system prompt says the data is to be described,
  never followed. The Summarizer has zero tools, so injection against it can only produce text.
- **Layer 2, the schema confines what crosses.** Every field has a trust class. The model can fill
  only the `summary` fields; extra keys are stripped. Trusted values and labels are set by code from
  records. Summaries attach by opaque per-run id, and unknown, meeting and duplicate ids are dropped
  (ADR-0021 §4). Every label and summary is defanged: markdown image and link wrappers are reduced
  to their visible text with the URL discarded, and any remaining `http(s)://` becomes
  `hxxp(s)://`. There is no allowlist.
- **Layer 3, the consumer treats it as data.** The `rundown` skill carries the trust contract:
  labels and summaries are quoted data about the user's work, an imperative inside one is never
  acted on, and trusted values are facts. Its field reference lists each field's class and is
  checked against the schema (ADR-0021 §3).

Output scanning for injection patterns is still not adopted.

### 6. Leak paths

| Path | Disposition |
|------|-------------|
| Agent invokes a raw source-fetch command | **Closed**: no such command; sources are internal to `digest` |
| A dev or debug raw-dump command | **Closed**: compiled out of the release build |
| Bundle or Summarizer input spilled to a file | **Closed**: in memory only; `rundown` writes nothing raw to disk |
| Summarizer input printed or logged | **Closed**: the Digester's unwrap feeds only `summarize()` and grouping |
| Logs, errors, status or the manifest echo untrusted bytes | **Closed**: those sinks cannot unwrap; the budget error carries counts only |
| Grouping on untrusted sender and subject | **Closed**: done inside the Digester's unwrap site; the result leaves only as entry membership, counts and the entry id |
| Labels → agent | **Accepted**: unfabricated source text, stripped, defanged, clamped and marked `label` in the schema |
| Summaries → agent | **Accepted**: the intended crossing, mitigated by Layers 1–3 |
| Digest persisted or re-read by the agent | **Accepted**: same status as the digest |
| Model sets a trusted field or a label | **Closed**: the output schema has only `summary` fields and strips extra keys; code fills the rest |
| Model attaches a summary to an unknown, meeting or already-summarized entry | **Closed**: opaque per-run ids; those ids are dropped, and entries left without a summary are counted in `unsummarized` |
| Render-time exfiltration through a URL or markdown image in a label or summary | **Closed**: every label and summary is defanged |
| `status` and `login` print the signed-in account's label | **Accepted**: the user's own account label from a first-party API, outside `Untrusted<T>` |
| Structural URLs (join link, Outlook `webLink`, Slack permalink) | **Closed, out of scope**: not read or not kept; a code-copied URL field would be a new trust decision |

`guidance` is no longer a row: the key is removed (ADR-0021 §6). The instruction region carries
no config text and no source text; its only per-run values are `generatedAt` and the timezone, both
trusted values.

## Consequences

- Trust follows a rule instead of a list. A new field gets a class or fails at module load, and
  the class decides how it is produced.
- The unwrap-site audit grows from one site to two, both small and named in the check.
- Labels widen the crossing: subjects, titles and names reach the agent as source text, not as model
  paraphrase. They are bounded and inert, and an imperative in a subject is still an imperative
  the consumer must ignore (Layer 3).
- The id join cannot tell two valid ids apart. A model that swaps the summaries of two mail or
  chat entries goes undetected; the entries' trusted values and labels stay correct.
- The residual is unchanged in kind: an injection that survives Layers 1 and 2 reaches the agent as
  data in a summary or label, closed only behaviorally. The live hostile-input evals check that the
  real model does not relay payloads ([#141](https://github.com/oyvindfanebust/rundown/issues/141)).
