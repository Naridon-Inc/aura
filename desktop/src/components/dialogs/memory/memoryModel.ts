// What the Memory surface knows without asking the engine: the plain names
// of each category, which ones a person may write into, and how to read the
// CLI's loose JSON replies back into something the list can draw. Pure, so
// the wording and the parsing are tested without a window.

import type { ClaudeImportReport, MemoryEntry } from "../../../lib/api";

/** Read-time verdict from `aura memory why <id> --json`, cached per id.
 *  Only `stale === true` renders a mark; fresh/unverifiable stay quiet. */
export type WhyInfo = {
  stale: boolean;
  reason?: string;
  /** When this entry replaced one that had already been shared, the day that
   *  older wording went out. The team still has it; this correction did not. */
  supersedesSharedAt?: string;
};

/** One ranked hit from `aura memory search <q> --json`. The CLI returns a
 *  loose JSON array; only the fields we draw are read, and the full entry is
 *  looked back up by id for fidelity (forget, provenance). */
export type SearchHit = {
  section: string;
  id: string;
  content: string;
  score?: number;
};

/** A stored fact with the category it lives in. */
export type MemoryRow = { entry: MemoryEntry; section: string };

/** The "every category" filter value. */
export const ALL = "__all__";

/** Plain-language names + one-line "what this is" for each memory category.
 *  The raw section keys (architecture/decisions/…) are engine terms; a
 *  vibecoder never sees them. */
export const SECTIONS: Record<string, { label: string; blurb: string }> = {
  decisions: {
    label: "Decisions",
    blurb: "Choices made and why — so they're never re-litigated.",
  },
  conventions: {
    label: "Conventions",
    blurb: "How things are done here — the style and patterns to follow.",
  },
  gotchas: {
    label: "Gotchas",
    blurb: "Traps and surprises worth remembering before they bite again.",
  },
  architecture: {
    label: "Architecture",
    blurb: "How the repository is put together at a high level.",
  },
  context: {
    label: "Context",
    blurb: "Background the AI should carry into every session.",
  },
  active_work: {
    label: "Active work",
    blurb: "What's in flight right now.",
  },
};

/** Sections a person may write into. `decisions` and `architecture` are
 *  maintained by Aura itself (they hold structured shapes, not free-text
 *  facts) — offering them in the composer used to corrupt the store. */
export const WRITABLE_SECTIONS = ["conventions", "gotchas", "context", "active_work"] as const;

export function sectionLabel(name: string): string {
  return SECTIONS[name]?.label ?? name;
}

export function isWritableSection(name: string): boolean {
  return (WRITABLE_SECTIONS as readonly string[]).includes(name);
}

/** Order sections the way the filter lists them: the friendly order above,
 *  anything unknown after. */
export function sectionRank(name: string): number {
  const i = Object.keys(SECTIONS).indexOf(name);
  return i < 0 ? 99 : i;
}

/** Comma-separated tags as typed → the tag list the CLI stores. */
export function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** `aura memory search --json` stdout → hits. Anything unreadable is no
 *  hits, never an error: search is a convenience over a list that's already
 *  on screen. */
export function parseSearchHits(stdout: string): SearchHit[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  return (Array.isArray(raw) ? raw : [])
    .map((row) => {
      const o = (row ?? {}) as Record<string, unknown>;
      const content = [o.content, o.description, o.title].find(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      return {
        section: typeof o.section === "string" ? o.section : "",
        id: typeof o.id === "string" ? o.id : "",
        content: content ?? "",
        score: typeof o.score === "number" ? o.score : undefined,
      };
    })
    .filter((h) => h.content);
}

/** `aura memory why <id> --json` stdout → the verdict, or null when the
 *  engine couldn't say (no mark rather than a wrong one). */
export function parseWhy(stdout: string): WhyInfo | null {
  try {
    const v = JSON.parse(stdout) as {
      stale?: unknown;
      stale_reason?: string;
      supersedes_shared_at?: string;
    };
    if (typeof v?.stale !== "boolean") return null;
    return {
      stale: v.stale,
      reason: v.stale_reason,
      supersedesSharedAt: v.supersedes_shared_at,
    };
  } catch {
    return null;
  }
}

/** What one write actually did. Reconcile may refine, retire or ignore
 *  instead of appending, and the person should hear which. */
export function writeNotice(op: string): string | null {
  if (op === "noop") return "Aura already knew that — nothing was added.";
  if (op === "updated") {
    return "That refined an existing fact — the old wording is kept under “Show history”.";
  }
  if (op === "deleted") {
    return "That contradicted an old fact, which is now retired. Nothing new was added.";
  }
  return null;
}

/** `memory-cloud push --json` stdout → the sentence the person reads. The
 *  signature verdict comes from the server's reply, never from whether we
 *  happen to hold a local signature. */
export function shareNotice(stdout: string): string {
  let verdict = "";
  let created = true;
  try {
    const body = JSON.parse(stdout) as { signature?: string; created?: boolean };
    verdict = body.signature ?? "";
    created = body.created ?? true;
  } catch {
    // A reply we can't read is not a reason to claim anything about the
    // signature; the share still happened.
  }
  const lead = created ? "Shared with" : "Updated for";
  return verdict === "signed"
    ? `${lead} your team — signed, so they can verify it came from you.`
    : `${lead} your team. Your team can read it, but not verify who wrote it${verdict ? ` (${verdict})` : ""}.`;
}

/** The title a shared fact goes out under. */
export function shareTitle(content: string): string {
  return content.length > 72 ? `${content.slice(0, 72)}…` : content;
}

/** One calm line about an import from Claude Code. */
export function importSummary(r: ClaudeImportReport): string {
  if (r.found === false) {
    return r.message ?? "Claude Code hasn't remembered anything about this repository yet.";
  }
  if (r.total === 0) {
    return "Claude Code's memory for this repository was empty — nothing to bring in.";
  }
  const broughtIn = r.imported + r.updated;
  const parts: string[] = [];
  if (broughtIn > 0) {
    parts.push(
      `Brought in ${broughtIn} ${broughtIn === 1 ? "fact" : "facts"} Claude Code remembered about this repository.`,
    );
  }
  if (r.deduped > 0) {
    parts.push(`${r.deduped} ${r.deduped === 1 ? "was" : "were"} already here.`);
  }
  return parts.length ? parts.join(" ") : "Everything Claude Code remembered was already here.";
}

/** Plain-language confidence from the CLI's importance weight in [0, 1].
 *  0.3 is the engine default, so treat it as the quiet baseline. */
export function confidenceLabel(importance?: number): string | null {
  if (typeof importance !== "number" || Number.isNaN(importance)) return null;
  if (importance >= 0.7) return "High confidence";
  if (importance > 0.35) return "Medium confidence";
  return null; // baseline/low — stay quiet rather than nag
}

/** One-line tooltip for the scope manifest (which repo/checkout/session the
 *  fact was recorded in). Opaque fields; we only narrate what's present. */
export function scopeTooltip(scope?: Record<string, unknown>): string | null {
  if (!scope) return null;
  const parts: string[] = [];
  if (typeof scope.checkout_id === "string" && scope.checkout_id) {
    parts.push(`in checkout ${scope.checkout_id.slice(0, 12)}`);
  }
  if (typeof scope.agent === "string" && scope.agent) {
    parts.push(`by ${scope.agent}`);
  }
  if (typeof scope.session_id === "string" && scope.session_id) {
    parts.push(`during session ${scope.session_id.slice(0, 12)}`);
  }
  if (parts.length === 0) return "Recorded with a scope manifest.";
  return `Recorded ${parts.join(", ")} — this fact is bound to where it was written.`;
}

/** `src/auth.rs#verify_token` → `auth.rs#verify_token`; the full anchor
 *  stays in the tooltip. */
export function shortSymbol(anchor: string): string {
  const hash = anchor.indexOf("#");
  if (hash < 0) return anchor;
  const file = anchor.slice(0, hash);
  const base = file.split("/").pop() ?? file;
  return `${base}${anchor.slice(hash)}`;
}

/** RFC3339 → a date a person reads. Empty for anything unparseable, so a
 *  malformed stamp never renders as "Invalid Date" next to a real claim. */
export function fmtDate(rfc3339?: string): string {
  if (!rfc3339) return "";
  const d = new Date(rfc3339);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Unix seconds → "just now" / "5m ago" / "3h ago" / a short date. */
export function fmtTs(unix: number, now = Date.now()): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = now - d.getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}
