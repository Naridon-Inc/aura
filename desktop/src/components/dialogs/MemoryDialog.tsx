// Memory — "What Aura remembers about this project."
//
// One honest home for the project's long-term memory: the decisions,
// conventions, and gotchas Aura and your agents carry into every session so
// nobody has to repeat themselves. It reads the real Aura memory engine
// (`.aura/memory.json` via cmd_memory) — NOT any one agent's private notes —
// and lets you search it (ranked: BM25 + embeddings + recency), see where each
// fact came from, and forget anything that's wrong.
//
// Design intent (non-engineer first): lead with plain language, not CRUD.
// A vibecoder's question is "what does my AI think it knows, and can I fix it
// if it's wrong?" — so the surface answers that, with Forget as the primary
// act of control and "Add a fact" as the quiet secondary. Recent sessions used
// to live here too; they have their own home now ("My sessions" in Trace), so
// this surface is Memory and only Memory — every concept has exactly one home.
//
// W2 provenance: CLI-stamped entries carry source_commit / source_symbol /
// valid_from (passed through by cmd_memory.rs). Staleness is NOT stored — it's
// computed at read time by `aura memory why <id> --json` (a live code check),
// called lazily once per anchored entry and cached in component state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { StatusChip } from "../ui/statusChip";
import { api, type MemoryEntry, type MemoryView } from "../../lib/api";
import { agentDisplayLabel } from "../../lib/agentIdentity";

type MemoryDialogProps = {
  open: boolean;
  repoRoot: string;
  onClose: () => void;
  /** Render as a full-height Trace page instead of a centered modal. */
  inline?: boolean;
};

/** Read-time verdict from `aura memory why <id> --json`, cached per id.
 *  Only `stale === true` renders a badge; fresh/unverifiable stay quiet. */
type StaleInfo = { stale: boolean; reason?: string };

/** One ranked hit from `aura memory search <q> --json`. The CLI returns a
 *  loose JSON array; we read only the fields we render and look the full
 *  entry back up by id for fidelity (forget, provenance). */
type SearchHit = {
  section: string;
  id: string;
  content: string;
  score?: number;
};

const ALL = "__all__";

/** Plain-language names + one-line "what this is" for each memory category.
 *  The raw section keys (architecture/decisions/…) are engine terms; a
 *  vibecoder never sees them. */
const SECTIONS: Record<string, { label: string; blurb: string }> = {
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
    blurb: "How the project is put together at a high level.",
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

function sectionLabel(name: string): string {
  return SECTIONS[name]?.label ?? name;
}

export function MemoryDialog({ open, repoRoot, onClose, inline = false }: MemoryDialogProps) {
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-entry-id staleness verdicts; `whyRequested` dedupes in-flight and
  // failed checks so each entry shells out to the CLI at most once per load.
  const [staleness, setStaleness] = useState<Record<string, StaleInfo>>({});
  const whyRequested = useRef<Set<string>>(new Set());

  // Active category filter ("__all__" = everything, newest-first).
  const [activeSection, setActiveSection] = useState<string>(ALL);
  // "Add a fact" inline composer.
  const [adding, setAdding] = useState(false);

  // Search — ranked recall over the whole memory.
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  // "Import from Claude Code" — pulls what Claude Code remembered about this
  // project into Aura's memory. Calm one-line result, no jargon.
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Refresh re-verifies: staleness is a live code check, not stored state.
    whyRequested.current = new Set();
    setStaleness({});
    try {
      const mem = await api.auraMemoryView(repoRoot);
      setMemory(mem);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  const requestStaleness = useCallback(
    (id: string) => {
      if (whyRequested.current.has(id)) return;
      whyRequested.current.add(id);
      api
        .auraCli(repoRoot, ["memory", "why", id, "--json"])
        .then((r) => {
          if (r.status !== 0) return; // CLI failure → no badge
          const v = JSON.parse(r.stdout) as { stale?: boolean; stale_reason?: string };
          if (typeof v?.stale !== "boolean") return; // unverifiable → quiet
          setStaleness((prev) => ({
            ...prev,
            [id]: { stale: v.stale === true, reason: v.stale_reason },
          }));
        })
        .catch(() => {
          // Passthrough failures = no badge, never an error state.
        });
    },
    [repoRoot],
  );

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    setSearching(true);
    try {
      const r = await api.auraCli(repoRoot, ["memory", "search", q, "--json"]);
      if (r.status !== 0) {
        setHits([]);
        return;
      }
      const raw = JSON.parse(r.stdout) as unknown[];
      const parsed: SearchHit[] = (Array.isArray(raw) ? raw : [])
        .map((row) => {
          const o = row as Record<string, unknown>;
          const content =
            (o.content as string) ??
            (o.description as string) ??
            (o.title as string) ??
            "";
          return {
            section: typeof o.section === "string" ? o.section : "",
            id: typeof o.id === "string" ? o.id : "",
            content,
            score: typeof o.score === "number" ? o.score : undefined,
          };
        })
        .filter((h) => h.content);
      setHits(parsed);
    } catch {
      setHits([]);
    } finally {
      setSearching(false);
    }
  }, [query, repoRoot]);

  const clearSearch = useCallback(() => {
    setQuery("");
    setHits(null);
  }, []);

  const forget = useCallback(
    async (id: string) => {
      await api.auraMemoryForgetEntry(repoRoot, id);
      await reload();
    },
    [repoRoot, reload],
  );

  const importFromClaudeCode = useCallback(async () => {
    setImporting(true);
    setImportResult(null);
    try {
      const r = await api.auraMemoryImportClaudeCode(repoRoot, false);
      if (r.found === false) {
        setImportResult(
          r.message ?? "Claude Code hasn't remembered anything about this project yet.",
        );
        return;
      }
      if (r.total === 0) {
        setImportResult("Claude Code's memory for this project was empty — nothing to bring in.");
        return;
      }
      const broughtIn = r.imported + r.updated;
      const parts: string[] = [];
      if (broughtIn > 0) {
        parts.push(
          `Brought in ${broughtIn} ${broughtIn === 1 ? "fact" : "facts"} Claude Code remembered about this project.`,
        );
      }
      if (r.deduped > 0) {
        parts.push(`${r.deduped} ${r.deduped === 1 ? "was" : "were"} already here.`);
      }
      setImportResult(
        parts.length ? parts.join(" ") : "Everything Claude Code remembered was already here.",
      );
      await reload();
    } catch (e) {
      setImportResult(`Couldn't import from Claude Code: ${String(e)}`);
    } finally {
      setImporting(false);
    }
  }, [repoRoot, reload]);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  // Flatten every entry once, tagging its section, newest-first — the spine of
  // both the "Everything" view and the per-id lookup that backs search.
  const allEntries = useMemo(() => {
    if (!memory) return [];
    const rows = memory.sections.flatMap((s) =>
      s.entries.map((e) => ({ entry: e, section: s.name })),
    );
    rows.sort((a, b) => b.entry.added_at - a.entry.added_at);
    return rows;
  }, [memory]);

  const byId = useMemo(() => {
    const m = new Map<string, { entry: MemoryEntry; section: string }>();
    for (const r of allEntries) m.set(r.entry.id, r);
    return m;
  }, [allEntries]);

  const totalCount = allEntries.length;

  const visible = useMemo(() => {
    if (activeSection === ALL) return allEntries;
    return allEntries.filter((r) => r.section === activeSection);
  }, [allEntries, activeSection]);

  // Sections that actually carry entries, in the friendly order above.
  const liveSections = useMemo(() => {
    if (!memory) return [];
    const order = Object.keys(SECTIONS);
    return memory.sections
      .filter((s) => s.entries.length > 0)
      .sort((a, b) => {
        const ia = order.indexOf(a.name);
        const ib = order.indexOf(b.name);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
  }, [memory]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      inline={inline}
      fill={inline}
      title="Memory"
      width={920}
      footer={
        <>
          <Button variant="ghost" size="xs" onClick={() => setAdding(true)}>
            + Add a fact
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={importFromClaudeCode}
            disabled={importing}
            title="Bring in what Claude Code has remembered about this project"
          >
            {importing ? "Importing…" : "Import from Claude Code"}
          </Button>
          <Button variant="ghost" size="xs" onClick={reload} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </Button>
          <Button variant="default" size="xs" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className={`flex flex-col ${inline ? "h-full min-h-0" : "max-h-[68vh]"}`}>
        {/* Plain-language masthead — what memory IS, before any list. */}
        <Masthead memory={memory} count={totalCount} />

        {importResult && (
          <div className="mx-1 mt-2 flex items-start gap-2 rounded-md border border-line-soft bg-bg-1 px-3 py-2 text-[12px] text-text-2">
            <span className="mt-0.5 text-[var(--color-accent)]">✓</span>
            <span className="flex-1 leading-relaxed">{importResult}</span>
            <button
              type="button"
              onClick={() => setImportResult(null)}
              className="text-text-4 hover:text-text-1"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        {error ? (
          <div className="text-red text-[12px] px-1 py-4">{error}</div>
        ) : !memory && loading ? (
          <div className="text-text-4 text-[12px] py-10 text-center">
            Reading what Aura remembers…
          </div>
        ) : !memory ? (
          <div className="text-text-4 text-[12px] py-10 text-center">
            Memory isn't set up for this project yet.
          </div>
        ) : (
          <>
            <SearchBar
              value={query}
              onChange={setQuery}
              onSubmit={runSearch}
              onClear={clearSearch}
              searching={searching}
              hasResults={hits !== null}
            />

            <div className="mt-2 min-h-0 flex-1 overflow-auto pr-1">
              {hits !== null ? (
                <SearchResults
                  hits={hits}
                  byId={byId}
                  query={query}
                  staleness={staleness}
                  onCheckStaleness={requestStaleness}
                  onForget={forget}
                />
              ) : totalCount === 0 ? (
                <EmptyMemory onAdd={() => setAdding(true)} />
              ) : (
                <>
                  <CategoryChips
                    sections={liveSections}
                    active={activeSection}
                    total={totalCount}
                    onSelect={setActiveSection}
                  />
                  {adding && (
                    <div className="mt-3">
                      <NewEntryForm
                        defaultSection={activeSection === ALL ? "decisions" : activeSection}
                        onCancel={() => setAdding(false)}
                        onSubmit={async (section, content, tags) => {
                          await api.auraMemoryWriteEntry(repoRoot, section, content, tags);
                          setAdding(false);
                          setActiveSection(section);
                          await reload();
                        }}
                      />
                    </div>
                  )}
                  <div className="mt-3 flex flex-col gap-2">
                    {visible.map(({ entry }) => (
                      <EntryCard
                        key={entry.id}
                        entry={entry}
                        stale={staleness[entry.id]}
                        onCheckStaleness={requestStaleness}
                        onForget={() => forget(entry.id)}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ── Masthead ────────────────────────────────────────────────────────────────

function Masthead({ memory, count }: { memory: MemoryView | null; count: number }) {
  const identity = memory?.identity?.trim();
  const stack = (memory?.stack ?? []).filter(Boolean);
  // One tight line, not a paragraph. New projects get the full teach-in from
  // the EmptyMemory state below; a returning vibecoder who already has facts
  // doesn't need the same four-line explainer re-read at the top every visit.
  return (
    <div className="px-1 pb-3 border-b border-line-soft">
      <p className="text-[12.5px] leading-relaxed text-text-2 max-w-[640px]">
        What Aura remembers about this project — the decisions, conventions, and
        gotchas it carries into every session, so nobody repeats themselves.
      </p>
      {(identity || stack.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-text-4">
          <span>Aura sees this as</span>
          {identity && (
            <span className="px-1.5 py-0.5 rounded bg-bg-2 text-text-2">{identity}</span>
          )}
          {stack.slice(0, 6).map((s) => (
            <span key={s} className="px-1.5 py-0.5 rounded bg-bg-2 text-text-3">
              {s}
            </span>
          ))}
          <span className="ml-1 text-text-4">
            · {count} {count === 1 ? "fact" : "facts"} remembered
          </span>
        </div>
      )}
    </div>
  );
}

// ── Search ──────────────────────────────────────────────────────────────────

function SearchBar({
  value,
  onChange,
  onSubmit,
  onClear,
  searching,
  hasResults,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  searching: boolean;
  hasResults: boolean;
}) {
  return (
    <div className="mt-3 flex items-center gap-2">
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          if (e.key === "Escape" && hasResults) onClear();
        }}
        placeholder="Ask what Aura knows…  e.g. how does auth work"
        prefix={<SearchGlyph />}
        className="flex-1"
      />
      {hasResults ? (
        <Button variant="ghost" size="xs" onClick={onClear}>
          Clear
        </Button>
      ) : (
        <Button variant="default" size="xs" onClick={onSubmit} disabled={searching || !value.trim()}>
          {searching ? "Searching…" : "Search"}
        </Button>
      )}
    </div>
  );
}

function SearchResults({
  hits,
  byId,
  query,
  staleness,
  onCheckStaleness,
  onForget,
}: {
  hits: SearchHit[];
  byId: Map<string, { entry: MemoryEntry; section: string }>;
  query: string;
  staleness: Record<string, StaleInfo>;
  onCheckStaleness: (id: string) => void;
  onForget: (id: string) => void;
}) {
  if (hits.length === 0) {
    return (
      <div className="text-[12px] text-text-4 py-8 text-center">
        Nothing remembered matches “{query.trim()}”.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] text-text-4">
        {hits.length} {hits.length === 1 ? "match" : "matches"}, best first
      </div>
      {hits.map((h, i) => {
        const found = h.id ? byId.get(h.id) : undefined;
        if (found) {
          return (
            <EntryCard
              key={`${h.id}-${i}`}
              entry={found.entry}
              section={found.section}
              stale={staleness[found.entry.id]}
              onCheckStaleness={onCheckStaleness}
              onForget={() => onForget(found.entry.id)}
            />
          );
        }
        // Legacy/identity matches that carry no stored entry — show the text.
        return (
          <div key={`hit-${i}`} className="rounded-md border border-line-soft bg-bg-1 px-3 py-2">
            {h.section && <CategoryTag name={h.section} />}
            <div className="mt-1 text-[12.5px] text-text-1 whitespace-pre-wrap break-words">
              {h.content}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Category filter ───────────────────────────────────────────────────────────

function CategoryChips({
  sections,
  active,
  total,
  onSelect,
}: {
  sections: { name: string; entries: MemoryEntry[] }[];
  active: string;
  total: number;
  onSelect: (s: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <FilterChip
        label="Everything"
        count={total}
        active={active === ALL}
        onClick={() => onSelect(ALL)}
      />
      {sections.map((s) => (
        <FilterChip
          key={s.name}
          label={sectionLabel(s.name)}
          count={s.entries.length}
          title={SECTIONS[s.name]?.blurb}
          active={active === s.name}
          onClick={() => onSelect(s.name)}
        />
      ))}
    </div>
  );
}

function FilterChip({
  label,
  count,
  title,
  active,
  onClick,
}: {
  label: string;
  count: number;
  title?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${
        active
          ? "border-transparent"
          : "border-line-soft text-text-3 hover:text-text-1 hover:bg-bg-2"
      }`}
      style={active ? { background: "var(--color-accent)", color: "#05140b" } : undefined}
    >
      <span>{label}</span>
      <span className={active ? "opacity-70" : "text-text-4"}>{count}</span>
    </button>
  );
}

function CategoryTag({ name }: { name: string }) {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-2 text-text-3">
      {sectionLabel(name)}
    </span>
  );
}

// ── Empty state — teach what memory is ────────────────────────────────────────

function EmptyMemory({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="py-10 px-6 text-center max-w-[520px] mx-auto">
      <div className="text-[15px] font-medium text-text-1">
        Aura hasn't remembered anything yet
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-text-3">
        As you and your agents work, the decisions and conventions worth keeping
        get recorded here — and travel into every future session, so the AI stops
        re-asking and re-breaking the same things. You can also add a fact by hand.
      </p>
      <div className="mt-4">
        <Button variant="default" size="xs" onClick={onAdd}>
          Add the first fact
        </Button>
      </div>
    </div>
  );
}

// ── Entry card ────────────────────────────────────────────────────────────────

function EntryCard({
  entry,
  section,
  stale,
  onCheckStaleness,
  onForget,
}: {
  entry: MemoryEntry;
  section?: string;
  stale: StaleInfo | undefined;
  onCheckStaleness: (id: string) => void;
  onForget: () => void;
}) {
  // Lazy read-time verification: only anchored entries can go stale, and the
  // parent caches per id, so rendering at most triggers one `memory why` call.
  useEffect(() => {
    if (entry.source_symbol) onCheckStaleness(entry.id);
  }, [entry.id, entry.source_symbol, onCheckStaleness]);

  const hasProvenance = !!(entry.source_commit || entry.source_symbol);
  // Humanize the author the same way Sessions does: a fact written over MCP
  // is stamped "MCP Agent", which is jargon to a vibecoder ("what's MCP?").
  // Resolve it to the real agent ("Claude Code"); human names pass through.
  const whoRaw = entry.added_by?.trim();
  const who = whoRaw ? agentDisplayLabel(whoRaw) : undefined;
  return (
    <div className="group rounded-md border border-line-soft bg-bg-1 px-3 py-2.5">
      {/* Content leads — it's the fact, not the metadata. */}
      <div className="text-[12.5px] leading-relaxed text-text-1 whitespace-pre-wrap break-words">
        {entry.content}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {section && <CategoryTag name={section} />}
        {entry.tags.map((t) => (
          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-bg-2 text-text-3">
            #{t}
          </span>
        ))}
        {entry.source_commit && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-bg-2 text-text-4 font-mono"
            title={`Learned at commit ${entry.source_commit}`}
          >
            {entry.source_commit.slice(0, 8)}
          </span>
        )}
        {entry.source_symbol && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-bg-2 text-text-3 font-mono max-w-[240px] truncate"
            title={`Anchored to ${entry.source_symbol}`}
          >
            {shortSymbol(entry.source_symbol)}
          </span>
        )}
        {stale?.stale && (
          <StatusChip
            tone="amber"
            dense
            title={stale.reason ?? "The code this fact referenced has changed since it was written."}
          >
            may be out of date
          </StatusChip>
        )}

        {/* Quiet provenance line + Forget, pushed to the right. */}
        <span className="ml-auto flex items-center gap-2 text-[10.5px] text-text-4">
          {who && <span title={`Remembered by ${who}`}>{who}</span>}
          {entry.added_at > 0 && <span>{fmtTs(entry.added_at)}</span>}
          <button
            type="button"
            onClick={onForget}
            className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-red"
            title="Forget this — Aura will stop carrying it into sessions"
          >
            Forget
          </button>
        </span>
      </div>
      {!hasProvenance && !who && entry.added_at === 0 && null}
    </div>
  );
}

/** `src/auth.rs#verify_token` → `auth.rs#verify_token` for the chip;
 *  the full anchor stays in the tooltip. */
function shortSymbol(anchor: string): string {
  const hash = anchor.indexOf("#");
  if (hash < 0) return anchor;
  const file = anchor.slice(0, hash);
  const base = file.split("/").pop() ?? file;
  return `${base}${anchor.slice(hash)}`;
}

// ── Add a fact ────────────────────────────────────────────────────────────────

function NewEntryForm({
  defaultSection,
  onSubmit,
  onCancel,
}: {
  defaultSection: string;
  onSubmit: (section: string, content: string, tags: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [section, setSection] = useState(
    SECTIONS[defaultSection] ? defaultSection : "decisions",
  );
  const [content, setContent] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const sections = useMemo(() => Object.entries(SECTIONS), []);

  const submit = async () => {
    if (!content.trim()) return;
    setSubmitting(true);
    try {
      const tags = tagsRaw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await onSubmit(section, content.trim(), tags);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-md border border-line-soft bg-bg-1 p-3 flex flex-col gap-2.5">
      <div className="text-[12px] font-medium text-text-1">Add a fact to memory</div>
      <label className="flex flex-col gap-1">
        <span className="text-[10.5px] text-text-3">Category</span>
        <Select
          value={section}
          onChange={setSection}
          options={sections.map(([id, meta]) => ({ value: id, label: meta.label }))}
          aria-label="Category"
        />
        <span className="text-[10.5px] text-text-4">{SECTIONS[section]?.blurb}</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10.5px] text-text-3">What should every future session know?</span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
          placeholder="e.g. We use the arctic-blue accent for primary buttons; green is status-only."
          className="px-2 py-1.5 rounded bg-bg-0 border border-line-soft text-text-1 text-[12px] resize-y"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10.5px] text-text-3">Tags (optional, comma-separated)</span>
        <Input
          value={tagsRaw}
          onChange={(e) => setTagsRaw(e.target.value)}
          placeholder="auth, perf, p0"
        />
      </label>
      <div className="flex items-center gap-2 mt-0.5">
        <Button variant="default" size="xs" onClick={submit} disabled={submitting || !content.trim()}>
          {submitting ? "Saving…" : "Remember this"}
        </Button>
        <Button variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ── Glyphs + time ─────────────────────────────────────────────────────────────

function SearchGlyph() {
  return (
    <svg
      className="pointer-events-none text-text-4"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

function fmtTs(unix: number): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const now = Date.now();
  const diffMs = now - d.getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}
