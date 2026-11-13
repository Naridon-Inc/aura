// One moment's changed files in the Time machine: each file is a review row
// that opens to the pieces you can bring back, what leans on each piece, the
// file's recent saved versions, and the change itself as the shared file diff.
//
// The pieces are the symbols that actually changed at that moment (from
// `aura change-note <sha>`), never a guess. When a moment recorded none for a
// file, a by-name field stands in, because `aura rewind <name> <file>` really
// does resolve a symbol by name.

import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import {
  api,
  type ChangedSymbol,
  type FileChangeNote,
  type IntentChangesetFile,
  type SnapshotEntry,
  type SymbolImpact,
} from "../../lib/api";
import { fetchChangeNoteReport } from "../../lib/changeNoteCache";
import { relativeAgeFromDelta } from "../../lib/relativeTime";
import { parseUnifiedDiff } from "../../lib/diff";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DiffCount } from "../ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { TraceMark } from "../ui/trace-list";
import { TraceLine } from "../ui/trace-report";
import { FileDiff } from "../ui/workspace-patterns";
import "./time-machine.css";

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
    const ms = Number(stem.slice(encoded.length + 2));
    if (!Number.isFinite(ms) || ms <= 0) continue;
    out.push({ id: stem, ts: ms });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

/** The changed symbols for a moment, resolved lazily from the change-note of
 *  every distinct commit its changeset touched. Real symbols only: a file with
 *  no committed sha simply has none (the by-name field covers it). */
export function useMomentSymbols(repoRoot: string, files: IntentChangesetFile[]) {
  const [symbolsByPath, setSymbolsByPath] = useState<Map<string, ChangedSymbol[]>>(new Map());
  const [resolving, setResolving] = useState(false);
  useEffect(() => {
    let alive = true;
    const shas = Array.from(new Set(files.map((f) => f.commit).filter((c): c is string => !!c)));
    if (shas.length === 0) {
      setSymbolsByPath(new Map());
      return;
    }
    setResolving(true);
    // Through changeNoteCache — the Changes and Summary tabs read these same
    // per-commit reports. A report that fails is dropped from the map, not
    // allowed to fail the whole resolve.
    Promise.all(shas.map((sha) => fetchChangeNoteReport(repoRoot, sha).catch(() => null)))
      .then((reports) => {
        if (!alive) return;
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
        if (alive) setResolving(false);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, files]);
  return { symbolsByPath, resolving };
}

// Exact path first, then a suffix match for path-root differences.
export function lookupSymbols(map: Map<string, ChangedSymbol[]>, path: string): ChangedSymbol[] {
  const exact = map.get(path);
  if (exact) return exact;
  for (const [k, v] of map) {
    if (k.endsWith("/" + path) || path.endsWith("/" + k)) return v;
  }
  return [];
}

// Before you bring a piece back, what leans on it: the same reverse call graph
// the delete guard walks (`aura impact <symbol> <file>`), said plainly. It is
// information, not a gate — Aura saves a copy first, so a bring-back is undoable.
function SymbolDependents({ repoRoot, symbol, relFile }: { repoRoot: string; symbol: string; relFile: string }) {
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
        // "none" means there was no graph to walk; say so rather than claim
        // that nothing depends on it.
        setState(r.graphSource === "none" ? "unavailable" : "ok");
      })
      .catch(() => {
        if (alive) setState("unavailable");
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, symbol, relFile]);

  if (state === "loading") return <TraceLine tone="note">Checking what depends on this…</TraceLine>;
  if (state === "unavailable" || !impact) {
    return (
      <TraceLine tone="note">
        Couldn’t check what depends on this. Bring-back is still safe (Aura saves a copy first).
      </TraceLine>
    );
  }
  const total = Math.max(impact.directCallers.length, impact.transitiveCallerCount);
  if (impact.directCallers.length === 0 && impact.features.length === 0) {
    return <TraceLine>Nothing else uses this. Safe to bring back.</TraceLine>;
  }
  const callerNames = impact.directCallers.slice(0, 3).map((c) => c.symbol);
  const moreCallers = total - callerNames.length;
  const featureNames = impact.features.slice(0, 3).map((f) => f.name);
  return (
    <>
      <TraceLine tone="warn">
        {total} {total === 1 ? "thing depends" : "things depend"} on this. Bringing it back changes
        what they see.
      </TraceLine>
      {callerNames.length > 0 && (
        <TraceLine tone="note">
          Used by <code className="ui-tm-code">{callerNames.join(", ")}</code>
          {moreCallers > 0 ? ` +${moreCallers} more` : ""}
        </TraceLine>
      )}
      {featureNames.length > 0 && <TraceLine tone="note">Affects: {featureNames.join(", ")}</TraceLine>}
    </>
  );
}

// Forty 20px lines is about one screen of this column: enough to read a hunk
// whole, short enough that the next file stays in reach.
const DIFF_FOLD = 40;

/** What git recorded for this file in this moment's commit, not the working
 *  tree, so it stays true long after the change landed. */
function MomentFileDiff({ repoRoot, sha, path }: { repoRoot: string; sha: string; path: string }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let alive = true;
    setDiff(null);
    setFailed(false);
    api
      .gitDiffAtCommit(repoRoot, sha, path)
      .then((text) => alive && setDiff(text))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [repoRoot, sha, path]);
  const lines = useMemo(() => (diff ? parseUnifiedDiff(diff) : []), [diff]);

  if (failed) return <TraceLine tone="note">Couldn’t read the change for this file.</TraceLine>;
  if (diff == null) return <TraceLine tone="note">Reading the change…</TraceLine>;
  if (lines.length === 0) {
    return (
      <TraceLine tone="note">
        No line changes recorded. This may be a rename, a mode change, or a binary file.
      </TraceLine>
    );
  }
  const folded = !showAll && lines.length > DIFF_FOLD;
  return (
    <div className="ui-tm-diff">
      <FileDiff name={path} lines={folded ? lines.slice(0, DIFF_FOLD) : lines} />
      {folded && (
        <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
          Show all {lines.length} lines
        </Button>
      )}
    </div>
  );
}

export function TimeMachineFile({
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
  const [byName, setByName] = useState("");
  const points = useMemo(
    () => matchSnapshotsForFile(snapshots, absFor(repoRoot, file.path)),
    [snapshots, file.path, repoRoot],
  );
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  // Symbols from a commit's change-note first; a moment with no per-change sha
  // (the squashed bundled sample) carries its own on the changeset.
  const effective = symbols.length > 0 ? symbols : file.symbols ?? [];
  // Only a changed or deleted piece has an earlier version to go back to.
  const restorable = effective.filter((s) => s.change !== "added");
  const Chevron = open ? ChevronDown : ChevronRight;
  const typed = byName.trim();

  return (
    <div className="ui-tm-file">
      <button
        type="button"
        className="ui-trace-file-row"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Chevron />
        <FileText />
        <span className="ui-trace-file-path">
          {dir && <span>{dir}</span>}
          {name}
        </span>
        {restorable.length > 0 && (
          <TraceMark>
            {restorable.length} {restorable.length === 1 ? "piece" : "pieces"}
          </TraceMark>
        )}
        {(file.additions ?? 0) + (file.deletions ?? 0) > 0 && (
          <DiffCount added={file.additions ?? 0} removed={file.deletions ?? 0} />
        )}
      </button>

      {open && (
        <div className="ui-tm-file-body">
          {restorable.length > 0 ? (
            restorable.map((s) => (
              <div key={`${s.identifier}-${s.kind}`} className="ui-tm-piece">
                <div className="ui-tm-piece-body">
                  <div className="ui-tm-piece-title">
                    <code className="ui-tm-code">{s.identifier}</code>
                    <TraceMark tone={s.change === "deleted" ? "danger" : undefined}>
                      {s.kind} · {s.change === "deleted" ? "was deleted here" : "changed here"}
                    </TraceMark>
                  </div>
                  {/* Deleted pieces aren't in the graph to trace. */}
                  {s.change !== "deleted" && (
                    <SymbolDependents repoRoot={repoRoot} symbol={s.identifier} relFile={file.path} />
                  )}
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busySymbol === s.identifier}
                      onClick={() => onBringBack(s.identifier, file.path)}
                    >
                      {busySymbol === s.identifier ? "Bringing back…" : "Bring this back"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-[240px]">
                    Puts {s.identifier} back to its previous saved version. Nothing else in the file
                    changes, and Aura saves a copy first so this is undoable.
                  </TooltipContent>
                </Tooltip>
              </div>
            ))
          ) : effective.length > 0 ? (
            <TraceLine tone="note">
              The pieces here were newly added, so there&apos;s no earlier version to bring back.
            </TraceLine>
          ) : (
            <div className="ui-tm-by-name">
              <TraceLine tone="note">
                Aura didn&apos;t track individual pieces for this file at this moment. If one part
                broke, a function or section you can name, type it and Aura puts just that part
                back to its last good version. The rest stays untouched.
              </TraceLine>
              <div className="ui-tm-by-name-row">
                <Input
                  value={byName}
                  onChange={(e) => setByName(e.target.value)}
                  placeholder="part name. E.g. handleSubmit"
                  spellCheck={false}
                  aria-label={`Part of ${name} to bring back`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && typed) onBringBack(typed, file.path);
                  }}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!typed || busySymbol === typed}
                  onClick={() => onBringBack(typed, file.path)}
                >
                  {typed && busySymbol === typed ? "Bringing back…" : "Bring back"}
                </Button>
              </div>
            </div>
          )}

          {file.commit && <MomentFileDiff repoRoot={repoRoot} sha={file.commit} path={file.path} />}

          {/* Read-only context, not a selector. */}
          {points.length > 0 && (
            <TraceLine tone="note">
              Recent saved versions:{" "}
              {points.slice(0, 6).map((p, i) => (
                <Fragment key={p.id}>
                  {i > 0 && " · "}
                  <time title={new Date(p.ts).toLocaleString()}>
                    {relativeAgeFromDelta(Math.floor((Date.now() - p.ts) / 1000))}
                  </time>
                </Fragment>
              ))}
              {points.length > 6 && ` · +${points.length - 6} more`}
            </TraceLine>
          )}
        </div>
      )}
    </div>
  );
}
