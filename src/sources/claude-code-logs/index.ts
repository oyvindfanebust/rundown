// The Claude Code logs Source (ADR-0002 §7): read local `~/.claude/projects`
// session transcripts in a window and emit kind:"session" NormalizedItems. It is
// local + no-auth, so it declares no `login` and its `status()` is always
// `ready`. All backend content — a
// session's synthesized title, first prompt, git branch — is branded Untrusted
// at this boundary; its provenance is transcript bytes (including tool output),
// so it is hostile-controlled and never unwrapped here (sole unwrap site is
// plan.ts; CLAUDE.md).
//
// Read path is HYBRID, per project dir: where a
// `sessions-index.json` exists we map its entries (Claude Code has already
// synthesized a nice `summary` title + content-derived `modified`); where it
// does not, we transcript-parse the `.jsonl` files. The index is NOT
// comprehensive on disk (~half of dirs lack it, including the most active), so
// index-only would silently drop most sessions — hence the fallback. Both paths
// emit the identical shape so the Summarizer sees consistent data.
//
// Window semantics are start-in-window, stat-only: a session is included iff its
// START (index `created`, or file `birthtime` — which equals the first-message
// timestamp exactly) lands in `[from, to)`. The parse path stats every file and
// opens ONLY the survivors, so old transcripts are never read. `mtime` is NOT
// used for `end` — bulk touches (git/iCloud/index rebuilds) corrupt it; `end`
// comes from the last message's content timestamp instead.

import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { NormalizedItem, Window } from "../../domain.ts";
import { normalizer, text } from "../normalize.ts";
import type { Source, SourceStatus } from "../source.ts";

const KEY = "claude-code-logs";

// The source's one normalizer — both read paths emit through it.
const normalize = normalizer(KEY, { untitled: "(untitled session)" });

/** Injectable dependencies — the seam that makes the source unit-testable. */
export interface ClaudeCodeLogsDeps {
  /**
   * Session-start provider for the transcript-parse path (default: file
   * `birthtime`). Injectable because `birthtime` is immutable on disk and cannot
   * be set from a test fixture.
   */
  birthtimeOf?: (absPath: string) => Date;
}

function defaultRoot(): string {
  return join(homedir(), ".claude", "projects");
}

/** Inclusive-from, exclusive-to window membership for an ISO instant. */
function inWindow(iso: string, window: Window): boolean {
  const t = Date.parse(iso);
  return t >= Date.parse(window.from) && t < Date.parse(window.to);
}

// ── index path ────────────────────────────────────────────────────────────────

interface IndexEntry {
  sessionId?: string;
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

function readIndexedDir(indexPath: string, window: Window): NormalizedItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(indexPath, "utf-8"));
  } catch {
    return []; // a corrupt index shouldn't nuke the whole brief
  }
  const entries: IndexEntry[] = Array.isArray((parsed as any)?.entries) ? (parsed as any).entries : [];
  const items: NormalizedItem[] = [];
  for (const e of entries) {
    if (e.isSidechain === true) continue; // sub-agent runs double-count parent work
    const start = e.created;
    if (!start || !inWindow(start, window)) continue;
    items.push(
      normalize({
        kind: "session",
        timestamp: start, // start = index `created`
        end: e.modified, // content-derived, reliable (NOT fileMtime)
        id: e.sessionId,
        // Domain judgment stays caller-side: prefer the synthesized summary over the first prompt.
        title: e.summary ?? e.firstPrompt,
        extras: {
          firstPrompt: text(e.firstPrompt),
          summary: text(e.summary),
          messageCount: e.messageCount,
          projectPath: e.projectPath,
          gitBranch: e.gitBranch,
        },
      }),
    );
  }
  return items;
}

// ── transcript-parse path ───────────────────────────────────────────────────

interface ParsedTranscript {
  sessionId?: string;
  isSidechain: boolean;
  firstPrompt?: string;
  end?: string;
  messageCount: number;
  gitBranch?: string;
  projectPath?: string;
}

/** True for the `<command-name>…` / `<local-command…>` wrappers Claude Code logs, not a real prompt. */
function isCommandNoise(text: string): boolean {
  return /^<(command-|local-command)/.test(text.trimStart());
}

/** Pull the text of a user message: a plain string, or the concatenated `text` blocks. */
function extractPromptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type?: string; text?: string } => typeof b === "object" && b !== null)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  }
  return "";
}

function parseTranscript(file: string): ParsedTranscript | null {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  let sessionId: string | undefined;
  let gitBranch: string | undefined;
  let projectPath: string | undefined;
  let firstPrompt: string | undefined;
  let end: string | undefined;
  let isSidechain = false;
  let sawSidechain = false;
  let messageCount = 0;

  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let o: any;
    try {
      o = JSON.parse(trimmed);
    } catch {
      continue; // tolerate a partial/garbled line
    }
    if (!sessionId && typeof o.sessionId === "string") sessionId = o.sessionId;
    if (!projectPath && typeof o.cwd === "string") projectPath = o.cwd;
    if (!gitBranch && typeof o.gitBranch === "string" && o.gitBranch) gitBranch = o.gitBranch;
    // The first line carrying the field decides sidechain-ness for the whole file.
    if (!sawSidechain && typeof o.isSidechain === "boolean") {
      isSidechain = o.isSidechain;
      sawSidechain = true;
    }
    if (typeof o.timestamp === "string") end = o.timestamp; // last-wins → session end
    if (o.type === "user" || o.type === "assistant") {
      messageCount++;
      if (!firstPrompt && o.type === "user" && o.isMeta !== true) {
        const t = extractPromptText(o.message?.content).trim();
        if (t && !isCommandNoise(t)) firstPrompt = t;
      }
    }
  }
  return { sessionId, isSidechain, firstPrompt, end, messageCount, gitBranch, projectPath };
}

export class ClaudeCodeLogsSource implements Source {
  readonly key = KEY;
  readonly label = "Claude Code session logs";
  readonly options = {};

  private readonly root: string;
  private readonly birthtimeOf: (absPath: string) => Date;

  constructor(root: string = defaultRoot(), deps: ClaudeCodeLogsDeps = {}) {
    this.root = root;
    this.birthtimeOf = deps.birthtimeOf ?? ((p) => statSync(p).birthtime);
  }

  // Local + no-auth: always ready to read.
  async status(): Promise<SourceStatus> {
    return { state: "ready" };
  }

  async read(window: Window, _options: Record<string, unknown> = {}): Promise<NormalizedItem[]> {
    if (!existsSync(this.root)) return [];
    const items: NormalizedItem[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(this.root, entry.name);
      const indexPath = join(dir, "sessions-index.json");
      if (existsSync(indexPath)) {
        items.push(...readIndexedDir(indexPath, window)); // per-dir either/or: no double count
      } else {
        items.push(...this.readParsedDir(dir, window));
      }
    }
    return items;
  }

  private readParsedDir(dir: string, window: Window): NormalizedItem[] {
    const items: NormalizedItem[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      let startIso: string;
      try {
        startIso = this.birthtimeOf(file).toISOString(); // stat only
      } catch {
        continue;
      }
      if (!inWindow(startIso, window)) continue; // old transcripts are never opened
      const parsed = parseTranscript(file);
      if (!parsed || parsed.isSidechain) continue;
      const sessionId = parsed.sessionId ?? name.replace(/\.jsonl$/, "");
      items.push(
        normalize({
          kind: "session",
          timestamp: startIso, // start = file birthtime (== first-message timestamp)
          end: parsed.end, // last message's content timestamp
          id: sessionId,
          title: parsed.firstPrompt,
          extras: {
            firstPrompt: text(parsed.firstPrompt),
            messageCount: parsed.messageCount,
            projectPath: parsed.projectPath,
            gitBranch: parsed.gitBranch,
          },
        }),
      );
    }
    return items;
  }
}
