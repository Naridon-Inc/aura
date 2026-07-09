// Code Atlas → Monaco hover. The point, for our non-engineer audience: hover
// any function and read what it MEANS in the real world — pulled from the
// Code Atlas (`aura atlas` → `.aura/atlas.json`), a plain-English directory of
// every symbol. And when AI edits a function and its meaning shifts, the hover
// says so ("Meaning changed: was X, now Y"), tying every change to its own why.
//
// This module owns three things:
//   1. a per-repo, in-memory cache of the atlas (one IPC read per repo);
//   2. a name→entry index for fast, file-aware lookup at hover time;
//   3. the calm markdown rendering of one entry into a hover.
//
// The Monaco provider itself lives in MonacoEditor (it needs the monaco
// instance), but it delegates all lookup + rendering here so the logic is
// testable and reused across split panes.

import { api, type AtlasHover, type AtlasHoverEntry } from "./api";

// repoRoot → loaded atlas index (or a sentinel "unavailable" entry). Module
// scope so every editor pane shares one read per repo.
const cache = new Map<string, AtlasIndex>();
// repoRoot → in-flight load, so concurrent panes don't double-fetch.
const inflight = new Map<string, Promise<AtlasIndex>>();

/** A repo's atlas, indexed for hover lookup. */
export type AtlasIndex = {
  available: boolean;
  /** Lowercased raw symbol name → entries with that name (often just one). */
  byName: Map<string, AtlasHoverEntry[]>;
};

const EMPTY_INDEX: AtlasIndex = { available: false, byName: new Map() };

function buildIndex(atlas: AtlasHover): AtlasIndex {
  const byName = new Map<string, AtlasHoverEntry[]>();
  if (atlas.available) {
    for (const entry of atlas.entries) {
      const key = entry.name.toLowerCase();
      const bucket = byName.get(key);
      if (bucket) bucket.push(entry);
      else byName.set(key, [entry]);
    }
  }
  return { available: atlas.available, byName };
}

/** Load (and cache) the atlas index for a repo. Never throws — a missing or
 *  malformed atlas resolves to an unavailable index so the editor degrades to
 *  a plain editor. */
export async function loadAtlasIndex(repoRoot: string): Promise<AtlasIndex> {
  const cached = cache.get(repoRoot);
  if (cached) return cached;
  const pending = inflight.get(repoRoot);
  if (pending) return pending;

  const promise = api
    .readAtlas(repoRoot)
    .then((atlas) => {
      const index = buildIndex(atlas);
      cache.set(repoRoot, index);
      inflight.delete(repoRoot);
      return index;
    })
    .catch(() => {
      cache.set(repoRoot, EMPTY_INDEX);
      inflight.delete(repoRoot);
      return EMPTY_INDEX;
    });
  inflight.set(repoRoot, promise);
  return promise;
}

/** Synchronous peek at an already-loaded index (the hover provider is sync). */
export function peekAtlasIndex(repoRoot: string): AtlasIndex | undefined {
  return cache.get(repoRoot);
}

/** Drop a repo's cached atlas so the next hover re-reads it (e.g. after an
 *  `aura atlas` regen). */
export function invalidateAtlas(repoRoot: string): void {
  cache.delete(repoRoot);
  inflight.delete(repoRoot);
}

/** Resolve the best atlas entry for a hovered word in a given file.
 *
 *  When several symbols share a name across the repo, prefer the one defined in
 *  the file under the cursor; otherwise fall back to the single most-meaningful
 *  match (features beat components beat atoms). Returns undefined when the word
 *  isn't a tracked symbol — the hover then shows nothing. */
export function lookupEntry(
  index: AtlasIndex,
  word: string,
  filePath: string | undefined,
): AtlasHoverEntry | undefined {
  if (!index.available) return undefined;
  const bucket = index.byName.get(word.toLowerCase());
  if (!bucket || bucket.length === 0) return undefined;
  if (bucket.length === 1) return bucket[0];

  // Prefer a same-file definition. Atlas `file` is repo-relative; the editor's
  // path is absolute, so match by suffix.
  if (filePath) {
    const sameFile = bucket.filter(
      (e) => e.file && filePath.endsWith(e.file),
    );
    if (sameFile.length === 1) return sameFile[0];
    if (sameFile.length > 1) return pickByRole(sameFile);
  }
  return pickByRole(bucket);
}

const ROLE_RANK: Record<string, number> = { feature: 0, component: 1, atom: 2 };

function pickByRole(entries: AtlasHoverEntry[]): AtlasHoverEntry {
  return [...entries].sort(
    (a, b) => (ROLE_RANK[a.role] ?? 3) - (ROLE_RANK[b.role] ?? 3),
  )[0];
}

/** Plain-language label for a symbol's role — no jargon for non-engineers. */
function roleLabel(entry: AtlasHoverEntry): string {
  switch (entry.role) {
    case "feature":
      return entry.feature
        ? `Something people do here — the “${entry.feature}” feature`
        : "Something people do here";
    case "atom":
      return "A small building block";
    case "component":
    default:
      return "A building block of this app";
  }
}

/** Render one atlas entry as a calm markdown hover. Real-world title first,
 *  the one-line meaning, a subtle "what this is" line, and — when AI has
 *  shifted its meaning — a "Meaning changed" line carrying the why. */
export function renderHoverMarkdown(entry: AtlasHoverEntry): string {
  const lines: string[] = [];

  // Real-world title in plain words.
  lines.push(`**${escapeMd(entry.title)}**`);

  // The one-line meaning.
  if (entry.summary.trim()) {
    lines.push("");
    lines.push(escapeMd(entry.summary.trim()));
  }

  // A subtle "what this is" line.
  lines.push("");
  lines.push(`_${escapeMd(roleLabel(entry))} · ${escapeMd(entry.layer)}_`);

  // Meaning-change provenance — only when it actually changed.
  if (entry.meaningChange) {
    const { was, now } = entry.meaningChange;
    lines.push("");
    lines.push("---");
    lines.push(
      `**Meaning changed.** This used to mean: _${escapeMd(was.trim())}_`,
    );
    lines.push("");
    lines.push(`Now it means: _${escapeMd(now.trim())}_`);
  }

  return lines.join("\n");
}

// Monaco renders hover markdown as Markdown; escape the few characters that
// would otherwise break the layout or smuggle markup from a summary string.
function escapeMd(text: string): string {
  return text.replace(/([\\`*_{}[\]<>])/g, "\\$1");
}
