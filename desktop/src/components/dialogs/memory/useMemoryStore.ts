// Everything the Memory surface reads and does, behind one hook: the stored
// facts, the read-time checks on them, search, and the five writes (add,
// edit, forget, share, stop sharing) plus the import from Claude Code.
//
// Every write shells the CLI's reconciled path (the backend does this) and
// the backend emits `memory:changed` after each one — the hook listens and
// reloads, so a fact added or forgotten from ANY session (this surface, an
// agent, the terminal) appears without a restart.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { api, type MemoryEntry, type MemoryView } from "../../../lib/api";
import {
  importSummary,
  parseSearchHits,
  parseWhy,
  sectionRank,
  shareNotice,
  shareTitle,
  writeNotice,
  type MemoryRow,
  type SearchHit,
  type WhyInfo,
} from "./memoryModel";

export function useMemoryStore(repoRoot: string, open: boolean) {
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Show closed rows too (superseded by an edit, or soft-forgotten): the
  // audit trail behind "forget hides, it doesn't erase".
  const [showHistory, setShowHistory] = useState(false);
  // One calm line about what the last write actually did (reconcile may
  // update/supersede/no-op instead of appending), how a share went, or what
  // the import brought in.
  const [notice, setNotice] = useState<string | null>(null);

  // Per-entry `memory why` verdicts — the read-time staleness check plus
  // whether the wording an entry replaced had already left the machine.
  // `whyRequested` dedupes in-flight and failed checks so each entry shells
  // out to the CLI at most once per load.
  const [whyById, setWhyById] = useState<Record<string, WhyInfo>>({});
  const whyRequested = useRef<Set<string>>(new Set());

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  const [importing, setImporting] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Refresh re-verifies: the verdict is a live check, not stored state.
    whyRequested.current = new Set();
    setWhyById({});
    try {
      setMemory(await api.auraMemoryView(repoRoot, showHistory));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot, showHistory]);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  // Live updates: `memory:changed` after every mutation, `fs:changed` when
  // memory.json changes on disk. Either way reload, debounced, while open.
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
          if (r.status !== 0) return; // CLI failure → no mark
          const why = parseWhy(r.stdout);
          if (why) setWhyById((prev) => ({ ...prev, [id]: why }));
        })
        .catch(() => {
          // Passthrough failures = no mark, never an error state.
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
      setHits(r.status === 0 ? parseSearchHits(r.stdout) : []);
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

  /** Add a fact by hand. Returns the section it went into. */
  const addFact = useCallback(
    async (section: string, content: string, tags: string[]) => {
      const out = await api.auraMemoryWriteEntry(repoRoot, section, content, tags);
      setNotice(writeNotice(out.op));
      await reload();
    },
    [repoRoot, reload],
  );

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

  // Explicit sharing: memory is local until this is pressed. Through
  // `--entry-id`, the only path that carries the fact's signature in the
  // fields the server verifies and that updates the team's copy instead of
  // adding a near-duplicate. The push records itself on the entry, so
  // reopening still says what left.
  const share = useCallback(
    async (entry: MemoryEntry) => {
      try {
        const r = await api.auraCli(repoRoot, [
          "memory-cloud",
          "push",
          "--entry-id",
          entry.id,
          "--title",
          shareTitle(entry.content),
          "--json",
        ]);
        if (r.status !== 0) {
          setNotice(`Couldn't share: ${r.stderr.trim() || r.stdout.trim() || "the push failed"}`);
          return;
        }
        setNotice(shareNotice(r.stdout));
        await reload();
      } catch (e) {
        setNotice(`Couldn't share: ${String(e)}`);
      }
    },
    [repoRoot, reload],
  );

  // The other direction: a fact sent by mistake, or corrected afterwards,
  // can be taken back from the team.
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

  const importFromClaudeCode = useCallback(async () => {
    setImporting(true);
    setNotice(null);
    try {
      const r = await api.auraMemoryImportClaudeCode(repoRoot, false);
      setNotice(importSummary(r));
      if (r.found !== false && r.total > 0) await reload();
    } catch (e) {
      setNotice(`Couldn't import from Claude Code: ${String(e)}`);
    } finally {
      setImporting(false);
    }
  }, [repoRoot, reload]);

  // Every entry once, tagged with its section, newest-first — the spine of
  // the "Everything" view and the per-id lookup that backs search.
  const allEntries = useMemo<MemoryRow[]>(() => {
    if (!memory) return [];
    const rows = memory.sections.flatMap((s) =>
      s.entries.map((entry) => ({ entry, section: s.name })),
    );
    rows.sort((a, b) => b.entry.added_at - a.entry.added_at);
    return rows;
  }, [memory]);

  const byId = useMemo(() => {
    const m = new Map<string, MemoryRow>();
    for (const r of allEntries) m.set(r.entry.id, r);
    return m;
  }, [allEntries]);

  // Sections that actually carry entries, in the friendly order.
  const liveSections = useMemo(() => {
    if (!memory) return [];
    return memory.sections
      .filter((s) => s.entries.length > 0)
      .sort((a, b) => sectionRank(a.name) - sectionRank(b.name));
  }, [memory]);

  return {
    memory,
    loading,
    error,
    reload,
    showHistory,
    setShowHistory,
    notice,
    setNotice,
    whyById,
    requestWhy,
    query,
    setQuery,
    searching,
    hits,
    runSearch,
    clearSearch,
    addFact,
    forget,
    saveEdit,
    share,
    unshare,
    importing,
    importFromClaudeCode,
    allEntries,
    byId,
    liveSections,
  };
}

export type MemoryStore = ReturnType<typeof useMemoryStore>;
