// The suppression filter (#107, ADR-0017): drop configured recurring noise from the
// Bundle before it is rendered for the Summarizer. Pure mechanism between the
// Aggregator and the Planner — deterministic (no model discretion), and the removed
// items never cost bundle tokens. Matching runs against untrusted fields through the
// trust.ts boolean comparison primitives, so this module adds no unwrap site: only
// booleans cross the boundary, driven by user-authored patterns.

import type { AnnotatedItem, Bundle, SuppressRule, SuppressedEntry } from "./domain.ts";
import { untrustedExtrasInclude, untrustedIncludes } from "./trust.ts";

/**
 * Whether one rule matches one item. Criteria AND together; an absent criterion
 * constrains nothing. `source` and `series` compare trusted structural scalars;
 * `title` and `sender` are case-insensitive substring tests computed inside
 * trust.ts. `sender` matches the address (the structural `sender` field) or the
 * display name (`extras.from`) — a rule can name whichever the user has.
 */
export function ruleMatches(rule: SuppressRule, item: AnnotatedItem): boolean {
  if (rule.source !== undefined && item.source !== rule.source) return false;
  if (rule.series !== undefined && item.seriesFingerprint !== rule.series) return false;
  if (rule.title !== undefined && !untrustedIncludes(item.title, rule.title)) return false;
  if (
    rule.sender !== undefined &&
    !untrustedIncludes(item.sender, rule.sender) &&
    !untrustedExtrasInclude(item.extras, "from", rule.sender)
  ) {
    return false;
  }
  return true;
}

/**
 * Apply the config's rules to a Bundle. Returns the filtered Bundle — with the
 * per-source manifest counts recomputed, so `sources[].itemCount` keeps meaning
 * "items the Summarizer saw" — plus one audit entry per rule that matched at least
 * one item (presence is signal). An item matched by several rules is counted by
 * each (the audit answers "is my rule firing"), but removed once.
 */
export function suppress(
  bundle: Bundle,
  rules: SuppressRule[],
): { bundle: Bundle; suppressed: SuppressedEntry[] } {
  if (rules.length === 0) return { bundle, suppressed: [] };

  const perRule = rules.map((rule) => ({ rule, count: 0, fingerprints: [] as string[] }));
  const kept: AnnotatedItem[] = [];
  for (const item of bundle.items) {
    let matched = false;
    for (const entry of perRule) {
      if (!ruleMatches(entry.rule, item)) continue;
      matched = true;
      entry.count += 1;
      if (item.fingerprint !== undefined) entry.fingerprints.push(item.fingerprint);
    }
    if (!matched) kept.push(item);
  }

  const counts = new Map<string, number>();
  for (const item of kept) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  const sources = bundle.sources.map((s) => ({ ...s, itemCount: counts.get(s.source) ?? 0 }));

  return {
    bundle: { ...bundle, sources, items: kept },
    suppressed: perRule.filter((e) => e.count > 0),
  };
}
