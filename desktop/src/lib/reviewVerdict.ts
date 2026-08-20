// What a safety check is allowed to say it found.
//
// Two surfaces read the same `aura pr-review` output — the PR rail's Safety
// check card and the Safety check dialog — and both used to state a verdict
// computed from part of the evidence as if it covered all of it. The folds
// live here, away from the components, so they can be tested directly and so
// there is one place where the channels are enumerated.

import type { AuraReviewPayload } from "./api";

/** Unverified nodes arrive as strings, or as `{path, node}` objects, or as
 *  something older. Flatten to display strings; anything not an array is no
 *  data rather than an error. */
export function flattenUnverified(uv: unknown): string[] {
  if (!Array.isArray(uv)) return [];
  return uv.map((n) => {
    if (typeof n === "string") return n;
    if (n && typeof n === "object") {
      const obj = n as Record<string, unknown>;
      const path = typeof obj.path === "string" ? obj.path : null;
      const node = typeof obj.node === "string" ? obj.node : null;
      if (path && node) return `${path} :: ${node}`;
      if (path) return path;
      if (node) return node;
      return JSON.stringify(obj);
    }
    return String(n);
  });
}

/** The four things a safety check counts.
 *
 *  This set was written out three times — once as the PR card's grid of
 *  Counters, once as the ternary inside its FindingList, and once as the
 *  summary line that fires after a run. The summary named two of the four, so
 *  a review that found nine ripple effects and three branch clashes announced
 *
 *      Safety check done · all clear
 *
 *  while the grid directly underneath drew nine and three. That sentence also
 *  goes to the OS as a toast, which is read with the card out of view, by
 *  somebody deciding whether to merge.
 *
 *  One list now. Adding a fifth channel means adding it here, and the grid,
 *  the detail list and the summary all pick it up together. */
export const REVIEW_CHANNELS = [
  {
    key: "violations",
    label: "Broken rules",
    one: "broken rule",
    many: "broken rules",
    tone: "red",
    /** Engine prose ("Protected Node Deleted: …"), not an identifier. */
    prose: true,
    items: (r: AuraReviewPayload): string[] => r.invariant_violations ?? [],
  },
  {
    key: "blast",
    label: "Ripple effects",
    one: "ripple effect",
    many: "ripple effects",
    tone: "amber",
    prose: false,
    items: (r: AuraReviewPayload): string[] => r.blast_radius ?? [],
  },
  {
    key: "unverified",
    label: "Unproven",
    one: "unproven",
    many: "unproven",
    tone: "violet",
    prose: false,
    items: (r: AuraReviewPayload): string[] => flattenUnverified(r.unverified_nodes),
  },
  {
    key: "conflicts",
    label: "Branch clashes",
    one: "branch clash",
    many: "branch clashes",
    tone: "sky",
    prose: true,
    items: (r: AuraReviewPayload): string[] => r.cross_branch_conflicts ?? [],
  },
] as const;

export type ReviewSection = (typeof REVIEW_CHANNELS)[number]["key"];

/** What the flash — and the OS toast beside it — may claim once a check ran.
 *
 *  Besides naming only half the channels, this read its numbers off
 *  `refreshed.aura_review`, which is typed `AuraReviewPayload | null`. A null
 *  payload made every count zero, so the one case where we know nothing at
 *  all produced the most confident sentence in the app.
 *
 *  Nothing here says "clear". It reports what the check found, in the card's
 *  own four words, and carries the risk score because the pill that normally
 *  states it is not on screen when a toast fires. */
export function reviewFlash(r: AuraReviewPayload | null): string {
  if (!r) return "Safety check ran. Open this PR to see what it found.";
  const risk = Number.isFinite(r.risk_score) ? ` · risk ${r.risk_score}/100` : "";
  const parts = REVIEW_CHANNELS.map((ch) => {
    const n = ch.items(r).length;
    return n > 0 ? `${n} ${n === 1 ? ch.one : ch.many}` : null;
  }).filter((p): p is string => p !== null);
  return parts.length
    ? `Safety check done · ${parts.join(" · ")}${risk}`
    : `Safety check done · nothing flagged${risk}`;
}

/** The engine's overall read. Open-ended because older binaries send other
 *  words, and an unknown label must not silently become the safe one. */
export type RiskLabel = "LOW" | "MODERATE" | "CRITICAL" | string;

/** What the Safety check dialog's lead line may say, given everything the
 *  report actually holds.
 *
 *  `problems` counts two of the report's channels: rule breaks and
 *  cross-branch clashes. Off those two numbers alone the dialog used to print
 *
 *      ✓ Safe to keep
 *      Aura checked everything that changed … Nothing here looks risky —
 *      you're good to keep these changes.
 *
 *  Three things were wrong with that. The engine's own `risk_label` was
 *  ignored, so a change the engine called CRITICAL got "Safe to keep". The
 *  colour was taken from the verdict rather than the label, so the CRITICAL
 *  tag two inches away was painted green. And `unverified_nodes` — the list
 *  of things Aura could NOT check — is exactly what "checked everything that
 *  changed" claims didn't exist.
 *
 *  Nothing here grants permission any more. It reports what the check found
 *  and says plainly what it couldn't reach. The reader decides. */
export function verdictCopy(s: {
  problems: number;
  totalChanges: number;
  risk: RiskLabel;
  unverified: number;
}): { headline: string; sub: string; glyph: string; tone: "good" | "warn" | "bad" } {
  const changes =
    s.totalChanges > 0
      ? `${s.totalChanges} ${s.totalChanges === 1 ? "change" : "changes"}`
      : "your changes";
  // Said last, because it is the caveat on everything said before it.
  const couldnt =
    s.unverified > 0
      ? ` ${s.unverified} ${s.unverified === 1 ? "piece" : "pieces"} it couldn’t check on its own. See below.`
      : "";

  if (s.problems > 0) {
    return {
      headline: `${s.problems} ${s.problems === 1 ? "thing" : "things"} worth a look`,
      sub:
        "Have a look before you keep these changes. Each one could break something, or clashes with someone else's work." +
        couldnt,
      glyph: "⚠",
      tone: s.risk === "CRITICAL" ? "bad" : "warn",
    };
  }

  if (s.risk === "CRITICAL" || s.risk === "MODERATE") {
    // Nothing broke, but the engine still rates this change. Saying "safe"
    // over the top of its own label is how a reader learns to ignore both.
    return {
      headline: "Nothing broken, but it's a big change",
      sub:
        `Aura found nothing wrong across ${changes}, and still rates this ${String(
          s.risk,
        ).toLowerCase()}. Worth a second look before you keep it.` + couldnt,
      glyph: "⚠",
      tone: s.risk === "CRITICAL" ? "bad" : "warn",
    };
  }

  return {
    headline: "Nothing broken",
    sub: `Aura checked ${changes} and found nothing wrong.` + couldnt,
    glyph: "✓",
    tone: s.unverified > 0 ? "warn" : "good",
  };
}
