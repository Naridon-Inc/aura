// Memory — "What Aura remembers about this project."
//
// One honest home for the project's long-term memory: the decisions,
// conventions, and gotchas Aura and your agents carry into every session so
// nobody has to repeat themselves. It reads the real Aura memory engine
// (`.aura/memory.json` via cmd_memory) — NOT any one agent's private notes —
// and lets you search it (ranked: file anchor + BM25 + embeddings +
// recency), see where each fact came from, and forget anything that's wrong.
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
//
// AUDIT-CTX-05: every mutation shells the CLI's reconciled write path (the
// backend does this), and the backend emits `memory:changed` after each one —
// this surface listens and reloads, so adds/edits/forgets from ANY session
// (this dialog, an agent, the terminal) appear without a restart. Entries are
// Ed25519-signed at mint and verified at view time (the `signed` verdict),
// carry a confidence weight and a scope manifest, and can be shared to the
// team explicitly — memory stays on this machine until you do.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
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
type WhyInfo = {
  stale: boolean;
  reason?: string;
  /** When this entry replaced one that had already been shared, the day that
   *  older wording went out. The team still has it; this correction did not. */
  supersedesSharedAt?: string;
};

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

/** Sections a person may write into. `decisions` and `architecture` are
 *  maintained by Aura itself (they hold structured shapes, not free-text
 *  facts) — offering them in the composer used to corrupt the store. */
const WRITABLE_SECTIONS = ["conventions", "gotchas", "context", "active_work"] as const;

function sectionLabel(name: string): string {
  return SECTIONS[name]?.label ?? name;
}

export function MemoryDialog({ open, repoRoot, onClose, inline = false }: MemoryDialogProps) {
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-entry-id `memory why` verdicts — the read-time staleness check plus
  // whether the wording this one replaced had already left the machine.
  // `whyRequested` dedupes in-flight and failed checks so each entry shells
  // out to the CLI at most once per load.
  const [whyById, setWhyById] = useState<Record<string, WhyInfo>>({});
  const whyRequested = useRef<Set<string>>(new Set());

  // Active category filter ("__all__" = everything, newest-first).
  const [activeSection, setActiveSection] = useState<string>(ALL);
  // "Add a fact" inline composer.
  const [adding, setAdding] = useState(false);
  // Show closed rows too (superseded by an edit, or soft-forgotten) — the
  // audit trail behind "forget hides, it doesn't erase".
  const [showHistory, setShowHistory] = useState(false);
  // One calm line about what the last write actually did (reconcile may
  // update/supersede/no-op instead of appending) or how a share went.
  const [notice, setNotice] = useState<string | null>(null);

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
    // Refresh re-verifies: the verdict is a live check, not stored state.
    whyRequested.current = new Set();
    setWhyById({});
    try {
      const mem = await api.auraMemoryView(repoRoot, showHistory);
      setMemory(mem);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot, showHistory]);

  // Live updates: the backend emits `memory:changed` after every mutation
  // (from this dialog, another window, or any agent shelling the CLI), and
  // the fs watcher emits `fs:changed` when memory.json changes on disk.
  // Either way: reload, debounced, while the surface is open.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => reloadRef.current(), 250);
    };
    const unlistens = [
      listen<string>("memory:changed", (e) => {
        if (!e.payload || e.payload === repoRoot) bump();
      }),
      listen<string>("fs:changed", (e) => {
        if (typeof e.payload === "string" && e.payload.endsWith("memory.json")) bump();
      }),
    ];
    return () => {
      if (timer) clearTimeout(timer);
      for (const p of unlistens) p.then((u) => u()).catch(() => {});
    };
  }, [open, repoRoot]);

  const requestWhy = useCallback(
    (id: string) => {
      if (whyRequested.current.has(id)) return;
      whyRequested.current.add(id);
      api
        .auraCli(repoRoot, ["memory", "why", id, "--json"])
        .then((r) => {
          if (r.status !== 0) return; // CLI failure → no badge
          const v = JSON.parse(r.stdout) as {
            stale?: boolean;
            stale_reason?: string;
            supersedes_shared_at?: string;
          };
          if (typeof v?.stale !== "boolean") return; // unverifiable → quiet
          setWhyById((prev) => ({
            ...prev,
            [id]: {
              stale: v.stale === true,
              reason: v.stale_reason,
              supersedesSharedAt: v.supersedes_shared_at,
            },
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

  // Default forget is SOFT: the fact leaves recall but stays on disk as
  // audit trail (visible under "Show history"). `hard` is the privacy
  // path — the row is erased entirely.
  const forget = useCallback(
    async (id: string, hard = false) => {
      try {
        await api.auraMemoryForgetEntry(repoRoot, id, hard);
        setNotice(
          hard
            ? "Erased completely — no trace kept."
            : "Forgotten — Aura stops carrying it into sessions. It stays under “Show history” until you erase it.",
        );
      } catch (e) {
        setNotice(`Couldn't forget: ${String(e)}`);
      }
      await reload();
    },
    [repoRoot, reload],
  );

  // Edit = supersede: the old row closes, a fresh signed row lands with a
  // back-pointer. The CLI does all of it; we just narrate the outcome.
  const saveEdit = useCallback(
    async (id: string, content: string, tags: string[]) => {
      await api.auraMemoryUpdateEntry(repoRoot, id, content, tags);
      setNotice("Updated — the previous wording is kept under “Show history”.");
      await reload();
    },
    [repoRoot, reload],
  );

  // Explicit sharing: memory is local until this is pressed.
  //
  // Through `--entry-id`, which is the CLI's own recommendation and the
  // only path that carries the fact's signature in the fields the server
  // verifies. This used to hand-build an envelope and push it as `--body`
  // — documented as arriving unsigned, and carrying no entry id, so a
  // second Share added a near-duplicate org-wide instead of updating the
  // one already there. The dialog nevertheless told the user the fact was
  // "signed, so they can verify it came from you", which was the one
  // thing that path could not deliver.
  //
  // The verdict now comes from the server's reply rather than from
  // whether we happen to hold a local signature, and the push records
  // itself on the entry, so reopening this dialog still says what left.
  /** The other direction. Sharing was one-way until the CLI grew a retract
   *  verb: a fact you sent by mistake, or corrected afterwards, stayed with
   *  the team with no way to take it back from here. */
  const unshare = useCallback(
    async (entry: MemoryEntry) => {
      try {
        const r = await api.auraCli(repoRoot, [
          "memory-cloud",
          "retract",
          "--entry-id",
          entry.id,
          "--json",
        ]);
        if (r.status !== 0) {
          const why = r.stderr.trim() || r.stdout.trim() || "the withdrawal failed";
          setNotice(`Couldn't stop sharing: ${why}`);
          return;
        }
        // Said plainly, because the one thing a withdrawal cannot do is the
        // thing people assume it does.
        setNotice(
          "Withdrawn — your team can no longer read this through Aura. A copy someone already pulled onto their own machine isn't reached.",
        );
        await reload();
      } catch (e) {
        setNotice(`Couldn't stop sharing: ${String(e)}`);
      }
    },
    [repoRoot, reload],
  );

  const share = useCallback(
    async (entry: MemoryEntry, _section: string) => {
      const title = entry.content.length > 72 ? `${entry.content.slice(0, 72)}…` : entry.content;
      try {
        const r = await api.auraCli(repoRoot, [
          "memory-cloud",
          "push",
          "--entry-id",
          entry.id,
          "--title",
          title,
          "--json",
        ]);
        if (r.status !== 0) {
          const why = r.stderr.trim() || r.stdout.trim() || "the push failed";
          setNotice(`Couldn't share: ${why}`);
          return;
        }
        let verdict = "";
        let created = true;
        try {
          const body = JSON.parse(r.stdout) as { signature?: string; created?: boolean };
          verdict = body.signature ?? "";
          created = body.created ?? true;
        } catch {
          // A reply we can't read is not a reason to claim anything about
          // the signature; the share still happened.
        }
        setNotice(
          verdict === "signed"
            ? `${created ? "Shared with" : "Updated for"} your team — signed, so they can verify it came from you.`
            : `${created ? "Shared with" : "Updated for"} your team. Your team can read it, but not verify who wrote it${verdict ? ` (${verdict})` : ""}.`,
        );
        await reload();
      } catch (e) {
        setNotice(`Couldn't share: ${String(e)}`);
      }
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
            {loading ? "Refreshing…" : "Refresh"}
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
          <div className="mx-1 mt-2 flex items-start gap-2 rounded-md border border-line-soft bg-bg-1 px-3 py-2 text-sm text-text-2">
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

        {notice && (
          <div className="mx-1 mt-2 flex items-start gap-2 rounded-md border border-line-soft bg-bg-1 px-3 py-2 text-sm text-text-2">
            <span className="mt-0.5 text-[var(--color-accent)]">✓</span>
            <span className="flex-1 leading-relaxed">{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-text-4 hover:text-text-1"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        {error ? (
          <div role="alert" className="text-red text-sm px-1 py-4">{error}</div>
        ) : !memory && loading ? (
          <div className="text-text-4 text-sm py-10 text-center">
            Reading what Aura remembers…
          </div>
        ) : !memory ? (
          <div className="text-text-4 text-sm py-10 text-center">
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
              {/* The composer renders in EVERY state — including the empty
                  store, where "Add the first fact" used to press a button
                  that opened nothing. */}
              {adding && (
                <div className="mt-1">
                  <NewEntryForm
                    defaultSection={
                      activeSection !== ALL &&
                      (WRITABLE_SECTIONS as readonly string[]).includes(activeSection)
                        ? activeSection
                        : "context"
                    }
                    onCancel={() => setAdding(false)}
                    onSubmit={async (section, content, tags) => {
                      const out = await api.auraMemoryWriteEntry(repoRoot, section, content, tags);
                      setAdding(false);
                      setActiveSection(section);
                      if (out.op === "noop") {
                        setNotice("Aura already knew that — nothing was added.");
                      } else if (out.op === "updated") {
                        setNotice("That refined an existing fact — the old wording is kept under “Show history”.");
                      } else if (out.op === "deleted") {
                        setNotice("That contradicted an old fact, which is now retired. Nothing new was added.");
                      } else {
                        setNotice(null);
                      }
                      await reload();
                    }}
                  />
                </div>
              )}
              {hits !== null ? (
                <SearchResults
                  hits={hits}
                  byId={byId}
                  query={query}
                  whyById={whyById}
                  onCheckWhy={requestWhy}
                  onForget={forget}
                  onSaveEdit={saveEdit}
                  onShare={share}
                  onUnshare={unshare}
                />
              ) : totalCount === 0 ? (
                adding ? null : <EmptyMemory onAdd={() => setAdding(true)} />
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <CategoryChips
                      sections={liveSections}
                      active={activeSection}
                      total={totalCount}
                      onSelect={setActiveSection}
                    />
                    <button
                      type="button"
                      onClick={() => setShowHistory((v) => !v)}
                      className={`ml-auto rounded-full border px-2.5 py-1 text-xs transition-colors ${
                        showHistory
                          ? "border-transparent bg-bg-2 text-text-1"
                          : "border-line-soft text-text-4 hover:text-text-1"
                      }`}
                      title="Also show facts that were edited away or forgotten — nothing is erased unless you say so"
                    >
                      {showHistory ? "Hiding nothing" : "Show history"}
                    </button>
                  </div>
                  <div className="mt-3 flex flex-col gap-2">
                    {visible.map(({ entry, section }) => (
                      <EntryCard
                        key={entry.id}
                        entry={entry}
                        why={whyById[entry.id]}
                        onCheckWhy={requestWhy}
                        onForget={(hard) => forget(entry.id, hard)}
                        onSaveEdit={(content, tags) => saveEdit(entry.id, content, tags)}
                        onShare={() => share(entry, section)}
                        onUnshare={() => unshare(entry)}
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
      <p className="text-base leading-relaxed text-text-2 max-w-[640px]">
        What Aura remembers about this project — the decisions, conventions, and
        gotchas it carries into every session, so nobody repeats themselves.
        <span className="text-text-4">
          {" "}
          Memory stays on this machine unless you share a fact with your team.
        </span>
      </p>
      {(identity || stack.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-text-4">
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
  whyById,
  onCheckWhy,
  onForget,
  onSaveEdit,
  onShare,
  onUnshare,
}: {
  hits: SearchHit[];
  byId: Map<string, { entry: MemoryEntry; section: string }>;
  query: string;
  whyById: Record<string, WhyInfo>;
  onCheckWhy: (id: string) => void;
  onForget: (id: string, hard?: boolean) => void;
  onSaveEdit: (id: string, content: string, tags: string[]) => Promise<void>;
  onShare: (entry: MemoryEntry, section: string) => void;
  onUnshare: (entry: MemoryEntry) => void;
}) {
  if (hits.length === 0) {
    return (
      <div className="text-sm text-text-4 py-8 text-center">
        Nothing remembered matches “{query.trim()}”.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs text-text-4">
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
              why={whyById[found.entry.id]}
              onCheckWhy={onCheckWhy}
              onForget={(hard) => onForget(found.entry.id, hard)}
              onSaveEdit={(content, tags) => onSaveEdit(found.entry.id, content, tags)}
              onShare={() => onShare(found.entry, found.section)}
              onUnshare={() => onUnshare(found.entry)}
            />
          );
        }
        // Legacy/identity matches that carry no stored entry — show the text.
        return (
          <div key={`hit-${i}`} className="rounded-md border border-line-soft bg-bg-1 px-3 py-2">
            {h.section && <CategoryTag name={h.section} />}
            <div className="mt-1 text-base text-text-1 whitespace-pre-wrap break-words">
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
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm transition-colors ${
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
    <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-2 text-text-3">
      {sectionLabel(name)}
    </span>
  );
}

// ── Empty state — teach what memory is ────────────────────────────────────────

function EmptyMemory({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="py-10 px-6 text-center max-w-[520px] mx-auto">
      <div className="text-lg font-medium text-text-1">
        Aura hasn't remembered anything yet
      </div>
      <p className="mt-2 text-base leading-relaxed text-text-3">
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
  why,
  onCheckWhy,
  onForget,
  onSaveEdit,
  onShare,
  onUnshare,
}: {
  entry: MemoryEntry;
  section?: string;
  why: WhyInfo | undefined;
  onCheckWhy: (id: string) => void;
  onForget: (hard?: boolean) => void;
  onSaveEdit: (content: string, tags: string[]) => Promise<void>;
  onShare: () => void;
  onUnshare: () => void;
}) {
  // Lazy read-time verification, for the two things only the engine knows:
  // whether an anchored fact has gone stale, and whether the wording this one
  // corrected had already been shared. The second cannot be answered from the
  // list — the replaced entry is only loaded under "Show history" — so it has
  // to come from `memory why`. The parent caches per id, so rendering at most
  // triggers one call per entry.
  useEffect(() => {
    if (entry.source_symbol || entry.supersedes) onCheckWhy(entry.id);
  }, [entry.id, entry.source_symbol, entry.supersedes, onCheckWhy]);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.content);
  const [draftTags, setDraftTags] = useState(entry.tags.join(", "));
  const [saving, setSaving] = useState(false);

  // Closed rows only show under "Show history": superseded by an edit, or
  // soft-forgotten. They are read-only audit trail (plus Erase).
  const closed = !!entry.valid_to;

  // Humanize the author the same way Sessions does: a fact written over MCP
  // is stamped "MCP Agent", which is jargon to a vibecoder ("what's MCP?").
  // Resolve it to the real agent ("Claude Code"); human names pass through.
  const whoRaw = entry.added_by?.trim();
  const who = whoRaw ? agentDisplayLabel(whoRaw) : undefined;

  const confidence = confidenceLabel(entry.importance);
  const scopeTip = scopeTooltip(entry.scope);

  const startEdit = () => {
    setDraft(entry.content);
    setDraftTags(entry.tags.join(", "));
    setEditing(true);
  };
  const submitEdit = async () => {
    const content = draft.trim();
    if (!content) return;
    setSaving(true);
    try {
      const tags = draftTags.split(",").map((t) => t.trim()).filter(Boolean);
      await onSaveEdit(content, tags);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`group rounded-md border border-line-soft bg-bg-1 px-3 py-2.5 ${
        closed ? "opacity-60" : ""
      }`}
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className="px-2 py-1.5 rounded bg-bg-0 border border-line-soft text-text-1 text-sm resize-y"
            aria-label="Edit this fact"
          />
          <Input
            value={draftTags}
            onChange={(e) => setDraftTags(e.target.value)}
            placeholder="tags, comma-separated"
            aria-label="Tags"
          />
          <div className="flex items-center gap-2">
            <Button variant="default" size="xs" onClick={submitEdit} disabled={saving || !draft.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <span className="text-xs text-text-4">
              The previous wording is kept — nothing is silently rewritten.
            </span>
          </div>
        </div>
      ) : (
        /* Content leads — it's the fact, not the metadata. */
        <div className="text-base leading-relaxed text-text-1 whitespace-pre-wrap break-words">
          {entry.content}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {section && <CategoryTag name={section} />}
        {entry.tags.map((t) => (
          <span key={t} className="text-2xs px-1.5 py-0.5 rounded bg-bg-2 text-text-3">
            #{t}
          </span>
        ))}
        {entry.source_commit && (
          <span
            className="text-2xs px-1.5 py-0.5 rounded bg-bg-2 text-text-4 font-mono"
            title={`Learned at commit ${entry.source_commit}`}
          >
            {entry.source_commit.slice(0, 8)}
          </span>
        )}
        {entry.source_symbol && (
          <span
            className="text-2xs px-1.5 py-0.5 rounded bg-bg-2 text-text-3 font-mono max-w-[240px] truncate"
            title={`Anchored to ${entry.source_symbol}`}
          >
            {shortSymbol(entry.source_symbol)}
          </span>
        )}
        {closed && (
          <StatusChip
            tone="neutral"
            dense
            title={
              entry.supersedes
                ? "This wording was replaced by an edit; kept as history."
                : "Forgotten — kept as history until erased."
            }
          >
            {entry.supersedes ? "replaced" : "forgotten"}
          </StatusChip>
        )}
        {entry.signed === "valid" && (
          <StatusChip
            tone="neutral"
            dense
            title={`Signed by ${entry.sig_key_id ?? "a verified identity"} — the signature checks out.`}
          >
            signed
          </StatusChip>
        )}
        {entry.signed === "invalid" && (
          <StatusChip
            tone="amber"
            dense
            title="This fact carries a signature that does NOT verify — it may have been altered since it was written."
          >
            signature broken
          </StatusChip>
        )}
        {confidence && (
          <span
            className="text-2xs px-1.5 py-0.5 rounded bg-bg-2 text-text-4"
            title="How strongly Aura weighs this fact when recalling memory."
          >
            {confidence}
          </span>
        )}
        {scopeTip && (
          <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-2 text-text-4" title={scopeTip}>
            scoped
          </span>
        )}
        {/* What has left this machine. The promise above the list — memory
            stays here until you share it — is only worth something if you
            can see which ones you shared, and the fact looked identical
            before and after until it recorded the push. */}
        {entry.shared_at && (
          <StatusChip
            tone="neutral"
            dense
            title={
              `Shared with your team on ${fmtDate(entry.shared_at)}` +
              (entry.shared_signature === "signed"
                ? " — signed, so they can verify it came from you."
                : " — your team can read it, but not verify who wrote it.")
            }
          >
            shared
          </StatusChip>
        )}
        {!entry.shared_at && entry.shared_retracted_at && (
          <StatusChip
            tone="neutral"
            dense
            title={`Withdrawn on ${fmtDate(entry.shared_retracted_at)} — your team can no longer read it through Aura, but a copy someone already pulled isn't reached.`}
          >
            withdrawn
          </StatusChip>
        )}
        {!entry.shared_at && why?.supersedesSharedAt && (
          <StatusChip
            tone="amber"
            dense
            title={`You corrected this here, but the wording it replaced was shared on ${fmtDate(why.supersedesSharedAt)} and is still what your team has.`}
          >
            correction not shared
          </StatusChip>
        )}
        {why?.stale && (
          <StatusChip
            tone="amber"
            dense
            title={why.reason ?? "The code this fact referenced has changed since it was written."}
          >
            may be out of date
          </StatusChip>
        )}

        {/* Quiet provenance line + controls, pushed to the right. */}
        <span className="ml-auto flex items-center gap-2 text-xs text-text-4">
          {who && <span title={`Remembered by ${who}`}>{who}</span>}
          {entry.added_at > 0 && <span>{fmtTs(entry.added_at)}</span>}
          {!closed && !editing && (
            <>
              <button
                type="button"
                onClick={onShare}
                className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-text-1"
                title={
                  entry.shared_at
                    ? `Already shared on ${fmtDate(entry.shared_at)} — sending again replaces your team's copy with this wording`
                    : "Share this fact with your team — memory stays on this machine until you do"
                }
              >
                {entry.shared_at ? "Share again" : "Share"}
              </button>
              {entry.shared_at && (
                <button
                  type="button"
                  onClick={onUnshare}
                  className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-text-1"
                  title="Take this back from your team — Aura stops serving it. A copy someone already pulled isn't reached."
                >
                  Stop sharing
                </button>
              )}
              <button
                type="button"
                onClick={startEdit}
                className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-text-1"
                title="Fix the wording — the old version is kept as history"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => onForget(false)}
                className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-red"
                title="Forget this — Aura stops carrying it into sessions; kept under Show history until erased"
              >
                Forget
              </button>
            </>
          )}
          {closed && (
            <button
              type="button"
              onClick={() => onForget(true)}
              className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-red"
              title="Erase completely — removes even the history copy. This is the privacy switch."
            >
              Erase
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

/** Plain-language confidence from the CLI's importance weight in [0, 1].
 *  0.3 is the engine default, so treat it as the quiet baseline. */
function confidenceLabel(importance?: number): string | null {
  if (typeof importance !== "number" || Number.isNaN(importance)) return null;
  if (importance >= 0.7) return "high confidence";
  if (importance > 0.35) return "medium confidence";
  return null; // baseline/low — stay quiet rather than nag
}

/** One-line tooltip for the scope manifest (which repo/checkout/session the
 *  fact was recorded in). Opaque fields; we only narrate what's present. */
function scopeTooltip(scope?: Record<string, unknown>): string | null {
  if (!scope) return null;
  const parts: string[] = [];
  if (typeof scope.checkout_id === "string" && scope.checkout_id) {
    parts.push(`checkout ${String(scope.checkout_id).slice(0, 12)}`);
  }
  if (typeof scope.agent === "string" && scope.agent) {
    parts.push(`by ${scope.agent}`);
  }
  if (typeof scope.session_id === "string" && scope.session_id) {
    parts.push(`session ${String(scope.session_id).slice(0, 12)}`);
  }
  if (parts.length === 0) return "Recorded with a scope manifest.";
  return `Recorded in ${parts.join(", ")} — this fact is bound to where it was written.`;
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
  // Only entry-shaped sections are writable: `decisions` and `architecture`
  // are maintained by Aura itself, and hand-written entries there used to
  // corrupt the store.
  const [section, setSection] = useState(
    (WRITABLE_SECTIONS as readonly string[]).includes(defaultSection)
      ? defaultSection
      : "context",
  );
  const [content, setContent] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const sections = useMemo(
    () => WRITABLE_SECTIONS.map((id) => [id, SECTIONS[id]] as const),
    [],
  );

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
      <div className="text-sm font-medium text-text-1">Add a fact to memory</div>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-text-3">Category</span>
        <Select
          value={section}
          onChange={setSection}
          options={sections.map(([id, meta]) => ({ value: id, label: meta.label }))}
          aria-label="Category"
        />
        <span className="text-xs text-text-4">{SECTIONS[section]?.blurb}</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-text-3">What should every future session know?</span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
          placeholder="e.g. We use the arctic-blue accent for primary buttons; green is status-only."
          className="px-2 py-1.5 rounded bg-bg-0 border border-line-soft text-text-1 text-sm resize-y"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-text-3">Tags (optional, comma-separated)</span>
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

/** RFC3339 → a date a person reads. Empty for anything unparseable, so a
 *  malformed stamp never renders as "Invalid Date" next to a real claim. */
function fmtDate(rfc3339?: string): string {
  if (!rfc3339) return "";
  const d = new Date(rfc3339);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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
