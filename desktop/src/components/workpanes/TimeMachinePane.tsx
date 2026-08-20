// TimeMachinePane — the "Time machine" Trace tool (replaces the old
// Rewind form).
//
// Meaning-first recovery for non-engineers. The left is a vertical timeline
// of every moment your code changed (newest at top), built entirely from the
// real intent log. Click a moment to *travel* to it: see when it was, who/which
// AI did it, the why in plain words, and exactly what changed around it — then
// bring back just one piece (one function/class) without disturbing the rest.
//
// No "type a function name" form on the happy path: the pieces you can bring
// back are the symbols that *actually* changed at that moment (from
// `aura change-note <sha>`). A bare by-name fallback stays for the rare case
// where a moment has no committed symbols.
//
// Honesty note: Aura's surgical restore (`aura rewind <symbol> <file>`) brings
// a symbol back to its previous saved version — so "Bring this back" is framed
// as "undo this change", and Aura snapshots the current state first so the undo
// is itself undoable. Whole-repo time travel (`aura restore`, a hard git reset
// that nukes uncommitted work) is deliberately NOT surfaced here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ChangedSymbol,
  type ClaudeSession,
  type FileChangeNote,
  type IntentChangesetFile,
  type SnapshotEntry,
  type SymbolImpact,
} from "../../lib/api";
import { fetchSessions } from "../../lib/sessionsCache";
import { fetchIntentRows } from "../../lib/intentCache";
import { fetchChangeNoteReport } from "../../lib/changeNoteCache";
import { AgentBadge } from "../agent/AgentBadge";
import { relativeAgeFromDelta } from "../../lib/relativeTime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import {
  collapseAutoStubSessions,
  provenanceLabel,
  provenanceNote,
  provenanceTag,
  sessionDisplayTitle,
  titleProvenance,
  type SessionDisplayRow,
} from "../../lib/sessionMeta";
import { ErrorState, LoadingState } from "../ui/state";
import { useBringBack, BringBackResult } from "./useBringBack";

// ── time helpers ───────────────────────────────────────────────────────

function relTime(secsAgo: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  // Its rungs carried the 45-to-60-second hole — the third copy of it.
  return relativeAgeFromDelta(secsAgo);
}

function fullWhen(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── path / snapshot helpers (shared shape with the old Rewind form) ─────

function absFor(root: string, rel: string): string {
  if (!rel) return "";
  if (rel.startsWith("/")) return rel;
  return `${root.replace(/\/$/, "")}/${rel.replace(/^\//, "")}`;
}

type SnapshotPoint = { id: string; ts: number };

// Snapshot blobs are named `<abs path with / and . → __>__<epoch_ms>`.
function matchSnapshotsForFile(entries: SnapshotEntry[], absFile: string): SnapshotPoint[] {
  const encoded = absFile.replace(/[/.]/g, "__");
  const out: SnapshotPoint[] = [];
  for (const e of entries) {
    const stem = e.id;
    if (!stem.startsWith(encoded + "__")) continue;
    const tail = stem.slice(encoded.length + 2);
    const ms = Number(tail);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    out.push({ id: stem, ts: ms });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}


// ═══════════════════════════════════════════════════════════════════════

export function TimeMachinePane({
  repoRoot,
  defaultIdentifier,
  defaultFile,
  onExpand,
}: {
  repoRoot: string;
  defaultIdentifier?: string | null;
  defaultFile?: string | null;
  /** When set, a maximize affordance in the header opens the immersive
   *  full-screen Time machine. Omitted when the pane is *already* full-screen
   *  (the wizard renders it without this). */
  onExpand?: () => void;
}) {
  const [displayRows, setDisplayRows] = useState<SessionDisplayRow[]>([]);
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTs, setSelectedTs] = useState<number | null>(null);
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000));
  const aliveRef = useRef(true);
  // Mirror of the current selection so a refresh can keep the user on the
  // moment they were reading instead of snapping back to newest. Kept in a
  // ref so `load` doesn't have to depend on `selectedTs` (which would re-run
  // it on every click).
  const selectedTsRef = useRef<number | null>(null);
  useEffect(() => {
    selectedTsRef.current = selectedTs;
  }, [selectedTs]);
  // The prefill we last steered the selection to. Lets us tell a plain
  // refresh (same prefill → keep the user's moment) apart from the tab being
  // re-opened on a different symbol/file (new prefill → jump to it).
  const lastPrefillRef = useRef<string | null>(null);

  const prefillFile = (defaultFile ?? "").trim();
  const prefillId = (defaultIdentifier ?? "").trim();

  const load = useCallback(async () => {
    if (!repoRoot) {
      setDisplayRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [data, cs, snaps] = await Promise.all([
        fetchIntentRows(repoRoot, 120),
        fetchSessions(repoRoot).catch(() => [] as ClaudeSession[]),
        api.auraListSnapshots(repoRoot).catch(() => [] as SnapshotEntry[]),
      ]);
      if (!aliveRef.current) return;
      const rows = Array.isArray(data) ? data : [];
      const claude = Array.isArray(cs) ? cs : [];
      const sorted = [...rows].sort((a, b) => b.timestamp - a.timestamp);
      // Only moments that actually touched files belong on a recovery
      // timeline — telemetry / empty intents would be dead ends.
      const display = collapseAutoStubSessions(sorted, claude).filter(
        (d) => (d.row.changeset?.files?.length ?? 0) > 0,
      );
      setDisplayRows(display);
      setSessions(claude);
      setSnapshots(Array.isArray(snaps) ? snaps : []);
      setNowSecs(Math.floor(Date.now() / 1000));
      // A fresh prefill (tab opened on a new symbol/file) wins; a plain
      // refresh keeps the user on the moment they were reading if it still
      // exists; otherwise fall back to the prefill match, else the newest.
      const prefillChanged = prefillFile !== "" && prefillFile !== lastPrefillRef.current;
      lastPrefillRef.current = prefillFile;
      const prefMatch = prefillFile
        ? display.find((d) =>
            (d.row.changeset?.files ?? []).some(
              (f) => f.path === prefillFile || f.path.endsWith("/" + prefillFile) || prefillFile.endsWith("/" + f.path),
            ),
          )
        : undefined;
      const prevSel = selectedTsRef.current;
      const keepPrev =
        !prefillChanged && prevSel != null && display.some((d) => d.row.timestamp === prevSel);
      setSelectedTs(keepPrev ? prevSel : ((prefMatch ?? display[0])?.row.timestamp ?? null));
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setDisplayRows([]);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [repoRoot, prefillFile]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  const selected = useMemo(
    () => displayRows.find((d) => d.row.timestamp === selectedTs) ?? null,
    [displayRows, selectedTs],
  );
  const selectedIndex = useMemo(
    () => displayRows.findIndex((d) => d.row.timestamp === selectedTs),
    [displayRows, selectedTs],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-content">
      {/* ── Header ─────────────────────────────────────────────────────
          What this place is FOR, and nothing else. It used to lead with a
          tinted clock tile and "Time machine" in 14px semibold — the same
          glyph and the same two words as the tab directly above it, and as
          the sidebar row above that. The sentence underneath was the only
          line doing work, and on a destination this frightening ("can I undo
          what the agent did without losing my own work?") it is the line that
          matters, so it is now the header. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-line-soft px-4 py-2">
        <div className="min-w-0 text-xs text-text-4">
          Travel back to any moment and bring back just one piece. The rest of your work stays put.
        </div>
        <div className="ml-auto flex items-center gap-1">
          {onExpand && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onExpand}
              className="text-text-3 hover:text-text-1"
              title="Open full screen"
              aria-label="Open the Time machine full screen"
            >
              <ExpandGlyph />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void load()}
            disabled={loading}
            className="text-text-3 hover:text-text-1"
            title="Refresh timeline"
            aria-label="Refresh timeline"
          >
            <RefreshGlyph />
          </Button>
        </div>
      </div>

      {/* Body */}
      {error ? (
        // Both of these were hand-rolled — a sentence with the raw error in
        // mono beneath it and no way to try again, and a bare "Loading your
        // timeline…" with no block loader. Every other surface in the app
        // uses these two primitives, so a stall and a failure look the same
        // wherever you meet them.
        <ErrorState
          title="Couldn’t load your timeline"
          message={error}
          onRetry={() => void load()}
        />
      ) : loading && displayRows.length === 0 ? (
        <LoadingState label="Reading your timeline…" />
      ) : displayRows.length === 0 ? (
        <EmptyTimeline />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Timeline rail */}
          <div className="w-[300px] shrink-0 overflow-y-auto border-r border-line-soft py-2">
            {displayRows.map((d, i) => (
              <MomentNode
                key={`${d.row.timestamp}-${d.row.agent_id}-${i}`}
                display={d}
                sessions={sessions}
                nowSecs={nowSecs}
                first={i === 0}
                last={i === displayRows.length - 1}
                selected={d.row.timestamp === selectedTs}
                onSelect={() => setSelectedTs(d.row.timestamp)}
              />
            ))}
          </div>

          {/* Detail */}
          <div className="min-w-0 flex-1 overflow-y-auto">
            {selected ? (
              <MomentDetail
                key={selected.row.timestamp}
                repoRoot={repoRoot}
                display={selected}
                sessions={sessions}
                snapshots={snapshots}
                nowSecs={nowSecs}
                stepsBack={selectedIndex}
                prefillId={prefillId}
                prefillFile={prefillFile}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

// ── timeline node ───────────────────────────────────────────────────────

function MomentNode({
  display,
  sessions,
  nowSecs,
  first,
  last,
  selected,
  onSelect,
}: {
  display: SessionDisplayRow;
  sessions: ClaudeSession[];
  nowSecs: number;
  first: boolean;
  last: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { row } = display;
  const title = sessionDisplayTitle(row, sessions);
  const provTag = provenanceTag(titleProvenance(row, sessions));
  const signed = !!row.signed_block_id;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group relative flex w-full items-start gap-2.5 px-3 py-2 text-left ${
        selected ? "bg-state-selected" : "hover:bg-state-hover"
      }`}
    >
      {/* spine + dot */}
      <span className="relative mt-0.5 flex w-3 shrink-0 justify-center">
        {!first && <span className="absolute -top-2 bottom-1/2 w-px bg-line-soft" />}
        {!last && <span className="absolute top-1/2 -bottom-2 w-px bg-line-soft" />}
        <span
          className="relative mt-[3px] h-2.5 w-2.5 rounded-full border-2"
          style={{
            borderColor: selected ? "var(--color-accent)" : "var(--color-text-5)",
            background: selected ? "var(--color-accent)" : "var(--color-bg-content)",
          }}
        />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={`text-xs font-medium ${selected ? "text-text-1" : "text-text-2"}`}>
            {relTime(nowSecs - row.timestamp)}
          </span>
          {signed && (
            <span className="text-text-4" title="Genuine record. Sealed">
              <LockGlyph />
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-sm leading-snug text-text-1">{title}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-4">
          <AgentBadge agentId={row.agent_id} />
          {/* Nobody wrote a reason for this moment — the line above is Aura's
              model reading the diff. On a timeline you scan, that's the one
              thing about it worth a word. */}
          {provTag ? (
            <>
              <span>·</span>
              <span>{provTag}</span>
            </>
          ) : null}
          <span>·</span>
          <span>
            {display.files} {display.files === 1 ? "file" : "files"}
          </span>
        </span>
      </span>
    </button>
  );
}

// ── moment detail ────────────────────────────────────────────────────────

function MomentDetail({
  repoRoot,
  display,
  sessions,
  snapshots,
  nowSecs,
  stepsBack,
  prefillId,
  prefillFile,
}: {
  repoRoot: string;
  display: SessionDisplayRow;
  sessions: ClaudeSession[];
  snapshots: SnapshotEntry[];
  nowSecs: number;
  stepsBack: number;
  prefillId: string;
  prefillFile: string;
}) {
  const { row } = display;
  const files = useMemo(() => row.changeset?.files ?? [], [row]);
  const title = sessionDisplayTitle(row, sessions);
  const provenance = titleProvenance(row, sessions);
  const provNote = provenanceNote(provenance);
  const signed = !!row.signed_block_id;

  // Lazily resolve the changed symbols for this moment by fetching the
  // change-note of every distinct commit the changeset touched, then merge
  // into a path → symbols map. Real symbols only — no fabrication; files
  // with no committed sha simply have no symbol rows (snapshot restore +
  // by-name fallback cover them).
  const [symbolsByPath, setSymbolsByPath] = useState<Map<string, ChangedSymbol[]>>(new Map());
  const [resolving, setResolving] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const shas = Array.from(
      new Set(files.map((f) => f.commit).filter((c): c is string => !!c)),
    );
    if (shas.length === 0) {
      setSymbolsByPath(new Map());
      return;
    }
    setResolving(true);
    // Through changeNoteCache — the Changes tab and the Summary tab already
    // read these same per-commit reports, and each one shells the engine. The
    // per-call catch stays: a report that fails is dropped from this map, not
    // allowed to fail the whole resolve.
    Promise.all(
      shas.map((sha) => fetchChangeNoteReport(repoRoot, sha).catch(() => null)),
    )
      .then((reports) => {
        if (!aliveRef.current) return;
        const map = new Map<string, ChangedSymbol[]>();
        for (const rep of reports) {
          if (!rep) continue;
          for (const fn of rep.files as FileChangeNote[]) {
            if (fn.symbols?.length) map.set(fn.file, fn.symbols);
          }
        }
        setSymbolsByPath(map);
      })
      .finally(() => {
        if (aliveRef.current) setResolving(false);
      });
    return () => {
      aliveRef.current = false;
    };
  }, [repoRoot, files]);

  const {
    state: bringBack,
    run: runBringBack,
    reset: resetBringBack,
    busySymbol,
  } = useBringBack(repoRoot);

  return (
    <div className="px-5 py-4">
      {/* "You're looking at …" header */}
      <div className="section-label mb-1">
        {stepsBack === 0 ? "Most recent moment" : `${stepsBack} ${stepsBack === 1 ? "moment" : "moments"} back`}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-lg font-semibold text-text-1">{relTime(nowSecs - row.timestamp)}</span>
        <span className="text-sm text-text-4">· {fullWhen(row.timestamp)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-3">
        <AgentBadge agentId={row.agent_id} />
        {signed && (
          <span className="inline-flex items-center gap-1 rounded-full border border-line-soft px-2 py-px text-text-3" title="A sealed, genuine record of this change">
            <LockGlyph /> sealed
          </span>
        )}
      </div>

      {/* The why — when there is one. "Why this happened" is the strongest
          claim any label in this app makes, and it was printed over all four
          origins: a stated reason, your session prompt, a line Aura's model
          wrote from the diff, and "Agent edited 3 files". It holds for the
          first. See lib/sessionMeta. */}
      <div className="mt-3 rounded-lg border border-line-soft bg-bg-1 px-3.5 py-3">
        <div className="section-label mb-1">
          {provenanceLabel(provenance, "Why this happened")}
        </div>
        <div className="text-base leading-relaxed text-text-1">{title}</div>
        {provNote ? (
          <div className="mt-2 text-sm leading-relaxed text-text-4">{provNote}</div>
        ) : null}
      </div>

      {/* Prefill hint — landed here from a symbol right-click. */}
      {prefillId && prefillFile && (
        <div className="mt-3 rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed" style={{ borderColor: "color-mix(in oklab, var(--color-accent) 40%, transparent)", background: "color-mix(in oklab, var(--color-accent) 8%, transparent)" }}>
          Looking for <span className="font-mono text-accent">{prefillId}</span>. Find it under{" "}
          <span className="font-mono text-text-2">{prefillFile.split("/").pop()}</span> below and press <span className="text-text-1">Bring this back</span>.
        </div>
      )}

      {/* Bring-back result */}
      {bringBack.kind !== "idle" && (
        <BringBackResult state={bringBack} onDismiss={resetBringBack} />
      )}

      {/* What changed here */}
      <div className="mt-4 mb-2 flex items-center gap-2">
        <span className="section-label">What changed here</span>
        <span className="text-xs text-text-4">
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        {resolving && <span className="text-xs text-text-4">· finding the pieces…</span>}
      </div>

      <div className="flex flex-col gap-2">
        {files.map((f) => (
          <FileChangeBlock
            key={f.path}
            repoRoot={repoRoot}
            file={f}
            symbols={lookupSymbols(symbolsByPath, f.path)}
            snapshots={snapshots}
            busySymbol={busySymbol}
            onBringBack={runBringBack}
          />
        ))}
      </div>
    </div>
  );
}

// Match a changeset file path against the change-note map (exact, then a
// suffix fallback for path-root differences).
function lookupSymbols(map: Map<string, ChangedSymbol[]>, path: string): ChangedSymbol[] {
  const exact = map.get(path);
  if (exact) return exact;
  for (const [k, v] of map) {
    if (k.endsWith("/" + path) || path.endsWith("/" + k)) return v;
  }
  return [];
}

// ── blast-radius pre-flight for one restorable piece ─────────────────────
// Before you bring a piece back, show what leans on it. Same reverse call
// graph the delete-guard uses (`aura impact <symbol> <file>`), framed in plain
// language: how many things use this, and which user-facing features a person
// would actually notice. Purely informational — Aura still snapshots first, so
// a bring-back is always undoable — but you make the call with eyes open. Loads
// lazily (this only mounts when its file block is expanded).
function SymbolDependents({
  repoRoot,
  symbol,
  relFile,
}: {
  repoRoot: string;
  symbol: string;
  relFile: string;
}) {
  const [impact, setImpact] = useState<SymbolImpact | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "unavailable">("loading");

  useEffect(() => {
    let alive = true;
    setState("loading");
    api
      .auraSymbolImpact(repoRoot, symbol, relFile)
      .then((r) => {
        if (!alive) return;
        setImpact(r);
        // graphSource "none" means we had no graph to walk — say so plainly
        // rather than pretending "nothing depends on it".
        setState(r.graphSource === "none" ? "unavailable" : "ok");
      })
      .catch(() => {
        if (alive) setState("unavailable");
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, symbol, relFile]);

  if (state === "loading") {
    return <div className="mt-1 text-2xs text-text-4">Checking what depends on this…</div>;
  }
  if (state === "unavailable" || !impact) {
    return (
      <div className="mt-1 text-2xs text-text-4">
        Couldn’t check what depends on this. Bring-back is still safe (Aura saves a copy first).
      </div>
    );
  }

  const total = Math.max(impact.directCallers.length, impact.transitiveCallerCount);
  const hasDeps = impact.directCallers.length > 0 || impact.features.length > 0;

  if (!hasDeps) {
    return (
      <div className="mt-1 text-2xs text-accent-green">
        Nothing else uses this. Safe to bring back.
      </div>
    );
  }

  const callerNames = impact.directCallers.slice(0, 3).map((c) => c.symbol);
  const moreCallers = total - callerNames.length;
  const featureNames = impact.features.slice(0, 3).map((f) => f.name);

  return (
    <div className="mt-1 flex flex-col gap-0.5">
      <div className="text-2xs text-amber">
        {total} {total === 1 ? "thing depends" : "things depend"} on this. Bringing it back
        changes what they see.
      </div>
      {callerNames.length > 0 && (
        <div className="text-2xs text-text-4">
          Used by <span className="font-mono text-text-3">{callerNames.join(", ")}</span>
          {moreCallers > 0 ? ` +${moreCallers} more` : ""}
        </div>
      )}
      {featureNames.length > 0 && (
        <div className="text-2xs text-text-4">
          Affects: <span className="text-text-3">{featureNames.join(", ")}</span>
        </div>
      )}
    </div>
  );
}

// ── one changed file ─────────────────────────────────────────────────────

function FileChangeBlock({
  repoRoot,
  file,
  symbols,
  snapshots,
  busySymbol,
  onBringBack,
}: {
  repoRoot: string;
  file: IntentChangesetFile;
  symbols: ChangedSymbol[];
  snapshots: SnapshotEntry[];
  busySymbol: string | null;
  onBringBack: (symbol: string, relFile: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // By-name fallback: only ever shown when the moment recorded no individual
  // pieces for this file, so there's no list to pick from. `aura rewind <name>
  // <file>` genuinely resolves by symbol name, so this is a real control — not
  // a promise we can't keep.
  const [byName, setByName] = useState("");
  const points = useMemo(
    () => matchSnapshotsForFile(snapshots, absFor(repoRoot, file.path)),
    [snapshots, file.path, repoRoot],
  );
  const name = file.path.split("/").pop() || file.path;
  const dir = file.path.slice(0, file.path.length - name.length);
  // Prefer the symbols resolved from a commit's change-note; when the moment
  // bound none (no per-change sha — e.g. the squashed bundled sample), fall
  // back to any symbols the changeset embedded, so the surgical "Bring this
  // back" button still renders instead of the type-a-name fallback.
  const effectiveSymbols = symbols.length > 0 ? symbols : file.symbols ?? [];
  // Only "modified" symbols can be brought back to a prior version; added
  // ones have no earlier state, deleted ones aren't in the file to surgery.
  const restorable = effectiveSymbols.filter((s) => s.change !== "added");

  return (
    <div className="rounded-lg border border-line-soft bg-bg-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Chevron open={open} />
        <FileGlyph />
        <span className="min-w-0 flex-1 truncate text-sm">
          {dir && <span className="text-text-4">{dir}</span>}
          <span className="text-text-1">{name}</span>
        </span>
        {restorable.length > 0 && (
          <span className="shrink-0 rounded-full bg-bg-3 px-2 py-px text-2xs text-text-3">
            {restorable.length} {restorable.length === 1 ? "piece" : "pieces"}
          </span>
        )}
        {typeof file.additions === "number" || typeof file.deletions === "number" ? (
          <span className="shrink-0 font-mono text-2xs">
            <span className="text-accent-green">+{file.additions ?? 0}</span>
            <span className="text-text-4"> / </span>
            <span className="text-text-3">−{file.deletions ?? 0}</span>
          </span>
        ) : null}
      </button>

      {open && (
        <div className="border-t border-line-soft px-3 py-2.5">
          {restorable.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {restorable.map((s) => (
                <div
                  key={`${s.identifier}-${s.kind}`}
                  className="flex items-start gap-2 rounded-md border border-line-soft bg-bg-content px-2.5 py-1.5"
                >
                  <span className="pt-0.5">
                    <SymbolKindDot change={s.change} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-sm text-text-1">{s.identifier}</span>
                    <span className="block text-2xs text-text-4">
                      {s.kind}
                      {s.change === "deleted" ? " · was deleted here" : " · changed here"}
                    </span>
                    {/* Blast-radius pre-flight: who leans on this piece, shown
                        before you bring it back. Deleted pieces aren't in the
                        graph to trace, so skip them. */}
                    {s.change !== "deleted" && (
                      <SymbolDependents repoRoot={repoRoot} symbol={s.identifier} relFile={file.path} />
                    )}
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busySymbol === s.identifier}
                        onClick={() => onBringBack(s.identifier, file.path)}
                      >
                        {busySymbol === s.identifier ? "Bringing back…" : "Bring this back"}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-[240px]">
                      Puts {s.identifier} back to its previous saved version. Nothing else in the
                      file changes, and Aura saves a copy first so this is undoable.
                    </TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </div>
          ) : effectiveSymbols.length > 0 ? (
            <div className="text-xs leading-relaxed text-text-4">
              The pieces here were newly added, so there's no earlier version to bring back.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="text-xs leading-relaxed text-text-4">
                Aura didn't track individual pieces for this file at this moment. If one
                part broke, a function or section you can name, type it and Aura puts just
                that part back to its last good version. The rest stays untouched.
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={byName}
                  onChange={(e) => setByName(e.target.value)}
                  placeholder="part name. E.g. handleSubmit"
                  spellCheck={false}
                  className="h-7 flex-1 font-mono text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && byName.trim()) {
                      onBringBack(byName.trim(), file.path);
                    }
                  }}
                />
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!byName.trim() || busySymbol === byName.trim()}
                  onClick={() => onBringBack(byName.trim(), file.path)}
                >
                  {byName.trim() && busySymbol === byName.trim()
                    ? "Bringing back…"
                    : "Bring back"}
                </Button>
              </div>
            </div>
          )}

          {/* Recent saved versions of this file — read-only context, not a
              selector. A bring-back lands on the newest one automatically. */}
          {points.length > 0 && (
            <div className="mt-2.5 border-t border-line-soft pt-2">
              <div className="section-label mb-1">Recent saved versions</div>
              <div className="flex flex-wrap gap-1.5">
                {points.slice(0, 6).map((p, i) => (
                  <span
                    key={p.id}
                    className={`rounded px-1.5 py-px text-2xs ${i === 0 ? "bg-accent-soft text-accent" : "bg-bg-3 text-text-4"}`}
                    title={new Date(p.ts).toLocaleString()}
                  >
                    {relTime(Math.floor((Date.now() - p.ts) / 1000))}
                  </span>
                ))}
                {points.length > 6 && (
                  <span className="text-2xs text-text-4">+{points.length - 6} more</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── bring-back result banner ─────────────────────────────────────────────

// ── empty state ──────────────────────────────────────────────────────────

function EmptyTimeline() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full" style={{ background: "color-mix(in oklab, var(--color-accent) 14%, transparent)" }}>
        <ClockGlyph large />
      </div>
      <div className="text-md font-semibold text-text-1">Your timeline is empty</div>
      <p className="mt-1.5 max-w-[380px] text-sm leading-relaxed text-text-3">
        Every time you or an AI changes your code, that moment shows up here, with the why and
        everything that changed around it. Once you start building, you&apos;ll be able to travel
        back and bring any single piece back, cleanly.
      </p>
    </div>
  );
}

// ── glyphs ────────────────────────────────────────────────────────────────

function ClockGlyph({ large }: { large?: boolean }) {
  const s = large ? 22 : 16;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
      <path d="M4.2 9.3 3 7.6M3 7.6l2.3-.6" />
    </svg>
  );
}

function ExpandGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  );
}

function RefreshGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 4v6h-6" />
      <path d="M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
      <path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-4" aria-hidden="true">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className={`shrink-0 text-text-4 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true">
      <path d="M4 2.5 8 6l-4 3.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function SymbolKindDot({ change }: { change: string }) {
  const color =
    change === "deleted"
      ? "var(--color-red)"
      : change === "modified"
        ? "var(--color-amber)"
        : "var(--color-accent-green)";
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />;
}
