// v0.2.28 — Project-wide search + replace workpane (⌘⇧F).
//
// VSCode-style overlay above the work surface. Left column: query input,
// optional replace input, regex / case / whole-word toggles, include /
// exclude glob inputs. Right column: file-grouped result tree with
// per-match jump, per-file Replace, and global Replace-All.
//
// Backed by the Tauri `fs_grep_content` + `fs_replace_in_files` commands
// in `src-tauri/src/cmd_search.rs`. The replace path runs in-process via
// the `regex` crate (atomic tmp + rename) so it's safe to run on dirty
// trees — git diff afterwards shows exactly what changed.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Search as SearchIcon } from "lucide-react";
import { api, type GrepHit, type GrepOpts, type ReplaceReport } from "../lib/api";
import { AsciiSpinner } from "./ui/ascii-spinner";
import { Kbd } from "./ui/kbd";
import { Input } from "./ui/input";
import { askConfirm } from "./ui/ask";

type Props = {
  repoRoot: string;
  open: boolean;
  onClose: () => void;
};

const STORAGE_KEY = "aura.search.workpane.v1";

type Persisted = {
  query: string;
  replacement: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
};

const DEFAULTS: Persisted = {
  query: "",
  replacement: "",
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  include: "",
  exclude: "",
};

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

function savePersisted(p: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore quota */
  }
}

type FileGroup = {
  path: string;
  hits: GrepHit[];
};

function groupByFile(hits: GrepHit[]): FileGroup[] {
  const map = new Map<string, GrepHit[]>();
  for (const h of hits) {
    const bucket = map.get(h.path) ?? [];
    bucket.push(h);
    map.set(h.path, bucket);
  }
  return Array.from(map.entries())
    .map(([path, group]) => ({ path, hits: group }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function shortPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  return parts.slice(-3).join("/");
}

// Split a path into a leading folder (dimmed) and the filename (leads). The
// filename is what the eye scans for; the folder is supporting context.
function splitRelPath(path: string): { dir: string; base: string } {
  const segs = path.split("/");
  const base = segs.pop() ?? path;
  return { dir: segs.join("/"), base };
}

// Highlight the matched run inside a result line. Literal queries get an exact
// case-insensitive highlight; regex queries (where the literal won't appear)
// just render plain — we never fake a highlight that isn't really the match.
function MatchLine({
  text,
  query,
  regex,
  caseSensitive,
}: {
  text: string;
  query: string;
  regex: boolean;
  caseSensitive: boolean;
}) {
  const q = query.trim();
  if (!q || regex) return <>{text}</>;
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? q : q.toLowerCase();
  const at = hay.indexOf(needle);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-accent/20 px-0.5 text-accent">
        {text.slice(at, at + q.length)}
      </mark>
      {text.slice(at + q.length)}
    </>
  );
}

export function SearchWorkpane({ repoRoot, open, onClose }: Props) {
  const persisted = useRef<Persisted>(loadPersisted());
  const [query, setQuery] = useState(persisted.current.query);
  const [replacement, setReplacement] = useState(persisted.current.replacement);
  const [regex, setRegex] = useState(persisted.current.regex);
  const [caseSensitive, setCaseSensitive] = useState(persisted.current.caseSensitive);
  const [wholeWord, setWholeWord] = useState(persisted.current.wholeWord);
  const [include, setInclude] = useState(persisted.current.include);
  const [exclude, setExclude] = useState(persisted.current.exclude);
  const [showReplace, setShowReplace] = useState(false);

  const [hits, setHits] = useState<GrepHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [report, setReport] = useState<ReplaceReport | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const queryRef = useRef<HTMLInputElement>(null);

  // Persist controls.
  useEffect(() => {
    const snapshot: Persisted = {
      query,
      replacement,
      regex,
      caseSensitive,
      wholeWord,
      include,
      exclude,
    };
    savePersisted(snapshot);
  }, [query, replacement, regex, caseSensitive, wholeWord, include, exclude]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !replacing) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, replacing]);

  // Autofocus query input + select-on-open. If a selection was bounced
  // via `aura:open-search` with a `query` detail, prefill it.
  useEffect(() => {
    if (!open) return;
    queryRef.current?.focus();
    queryRef.current?.select();
  }, [open]);

  useEffect(() => {
    function onPrefill(e: Event) {
      const detail = (
        e as CustomEvent<{
          query?: string;
          regex?: boolean;
          caseSensitive?: boolean;
          wholeWord?: boolean;
        }>
      ).detail;
      if (!detail) return;
      if (detail.query) setQuery(detail.query);
      // Carry the match toggles from the caller (e.g. the Files-panel
      // search box). The debounced auto-run effect below reruns on these.
      if (typeof detail.regex === "boolean") setRegex(detail.regex);
      if (typeof detail.caseSensitive === "boolean")
        setCaseSensitive(detail.caseSensitive);
      if (typeof detail.wholeWord === "boolean") setWholeWord(detail.wholeWord);
    }
    window.addEventListener("aura:prefill-search", onPrefill);
    return () => window.removeEventListener("aura:prefill-search", onPrefill);
  }, []);

  const runSearch = useCallback(async () => {
    if (!query.trim()) {
      setHits([]);
      setTruncated(false);
      setError(null);
      return;
    }
    setSearching(true);
    setError(null);
    setReport(null);
    try {
      const opts: GrepOpts = {
        regex,
        case_sensitive: caseSensitive,
        whole_word: wholeWord,
        include: splitCsv(include),
        exclude: splitCsv(exclude),
      };
      const result = await api.fsGrepContent(repoRoot, query, opts);
      setHits(result.hits);
      setTruncated(result.truncated);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setHits([]);
      setTruncated(false);
    } finally {
      setSearching(false);
    }
  }, [query, regex, caseSensitive, wholeWord, include, exclude, repoRoot]);

  // Debounced auto-search on input.
  useEffect(() => {
    if (!open) return;
    if (!query.trim()) {
      setHits([]);
      setTruncated(false);
      return;
    }
    const handle = window.setTimeout(() => {
      void runSearch();
    }, 220);
    return () => window.clearTimeout(handle);
  }, [open, query, regex, caseSensitive, wholeWord, include, exclude, runSearch]);

  const groups = useMemo(() => groupByFile(hits), [hits]);

  function toggleGroup(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function openHit(hit: GrepHit) {
    const fullPath = hit.path.startsWith("/") ? hit.path : `${repoRoot}/${hit.path}`;
    window.dispatchEvent(
      new CustomEvent("aura:open-file", {
        detail: { path: fullPath, line: hit.line },
      }),
    );
  }

  async function replaceInFiles(paths: string[]) {
    if (!query.trim()) return;
    if (paths.length === 0) return;
    const one = paths.length === 1;
    const ok = await askConfirm({
      title: one
        ? `Replace in ${shortPath(paths[0])}?`
        : `Replace across ${paths.length} files?`,
      body: one
        ? "The file is rewritten on disk."
        : "Those files are rewritten on disk.",
      confirmLabel: "Replace",
      tone: "danger",
    });
    if (!ok) return;
    setReplacing(true);
    setError(null);
    try {
      const opts: GrepOpts = {
        regex,
        case_sensitive: caseSensitive,
        whole_word: wholeWord,
        include: splitCsv(include),
        exclude: splitCsv(exclude),
      };
      const result = await api.fsReplaceInFiles(
        repoRoot,
        paths,
        query,
        replacement,
        opts,
      );
      setReport(result);
      // Re-run grep so the result tree updates.
      await runSearch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setReplacing(false);
    }
  }

  if (!open) return null;

  const totalHits = hits.length;
  const totalFiles = groups.length;
  const canReplace = showReplace && query.trim().length > 0 && totalHits > 0;

  return (
    <div className="absolute inset-0 z-40 bg-bg-content flex flex-col">
      {/* Header */}
      <div className="h-11 px-4 border-b border-line-soft flex items-center gap-2.5 flex-shrink-0">
        <SearchIcon size={14} className="text-text-4 shrink-0" />
        <div className="text-base font-medium text-text-1">
          Search this project
        </div>
        <div className="text-xs text-text-5 font-mono truncate">
          {shortPath(repoRoot)}
        </div>
        <div className="flex-1" />
        {!searching && query.trim() && totalHits > 0 && (
          <div className="text-xs text-text-4">
            {totalHits} {totalHits === 1 ? "match" : "matches"} ·{" "}
            {totalFiles} {totalFiles === 1 ? "file" : "files"}
          </div>
        )}
        <button
          type="button"
          onClick={() => setShowReplace((v) => !v)}
          className={`text-xs px-2 py-1 rounded ${
            showReplace
              ? "bg-bg-2 text-text-1"
              : "text-text-4 hover:text-text-1"
          }`}
          title="Toggle replace input"
        >
          Replace
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          className="text-sm text-text-4 hover:text-text-1 px-1.5 py-0.5 rounded hover:bg-state-hover"
        >
          ×
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 text-sm text-red bg-red/10 border-b border-line-soft">
          {error}
        </div>
      )}

      {/* A finished replace is a receipt, not an alarm — it reads on the
          neutral ramp; only the failure banner above carries colour. */}
      {report && (
        <div className="px-4 py-2 text-sm text-text-2 bg-bg-2 border-b border-line-soft">
          Replaced {report.total_replacements} occurrence
          {report.total_replacements === 1 ? "" : "s"} across{" "}
          {report.files_changed} file{report.files_changed === 1 ? "" : "s"}.
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {/* Left column: query + filters */}
        <div className="w-[320px] flex-shrink-0 border-r border-line-soft bg-bg-chrome flex flex-col overflow-y-auto">
          <div className="p-3 flex flex-col gap-2 border-b border-line-soft">
            <div className="flex items-center gap-1">
              <Input
                ref={queryRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                className="flex-1 min-w-0 h-7 text-sm font-mono"
              />
              <button
                type="button"
                onClick={() => setCaseSensitive((v) => !v)}
                title="Match Case (Aa)"
                className={`text-xs font-mono px-1.5 py-1 rounded border ${
                  caseSensitive
                    ? "bg-accent/20 border-accent text-text-1"
                    : "border-transparent text-text-4 hover:text-text-1 hover:bg-state-hover"
                }`}
              >
                Aa
              </button>
              <button
                type="button"
                onClick={() => setWholeWord((v) => !v)}
                title="Whole Word"
                className={`text-xs font-mono px-1.5 py-1 rounded border ${
                  wholeWord
                    ? "bg-accent/20 border-accent text-text-1"
                    : "border-transparent text-text-4 hover:text-text-1 hover:bg-state-hover"
                }`}
              >
                ab
              </button>
              <button
                type="button"
                onClick={() => setRegex((v) => !v)}
                title="Regex"
                className={`text-xs font-mono px-1.5 py-1 rounded border ${
                  regex
                    ? "bg-accent/20 border-accent text-text-1"
                    : "border-transparent text-text-4 hover:text-text-1 hover:bg-state-hover"
                }`}
              >
                .*
              </button>
            </div>

            {showReplace && (
              <div className="flex items-center gap-1">
                <Input
                  type="text"
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  placeholder="Replace"
                  className="flex-1 min-w-0 h-7 text-sm font-mono"
                />
                <button
                  type="button"
                  disabled={!canReplace || replacing}
                  onClick={() => replaceInFiles(groups.map((g) => g.path))}
                  title="Replace All"
                  className="text-xs px-2 py-1 rounded bg-accent/20 text-text-1 hover:bg-accent/30 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  All
                </button>
              </div>
            )}
          </div>

          <div className="p-3 flex flex-col gap-2 border-b border-line-soft">
            <label className="section-label">
              files to include
            </label>
            <Input
              type="text"
              value={include}
              onChange={(e) => setInclude(e.target.value)}
              placeholder="src/**/*.ts, *.md"
              className="h-7 text-sm font-mono"
            />
            <label className="section-label">
              files to exclude
            </label>
            <Input
              type="text"
              value={exclude}
              onChange={(e) => setExclude(e.target.value)}
              placeholder="**/dist/**, **/*.lock"
              className="h-7 text-sm font-mono"
            />
          </div>

          <div className="p-3 text-xs text-text-5 flex flex-col gap-1">
            {searching && (
              <div className="flex items-center gap-1.5 text-text-4">
                <AsciiSpinner />
                Searching…
              </div>
            )}
            {!searching && query.trim() && (
              <div>
                {totalHits} match{totalHits === 1 ? "" : "es"} in{" "}
                {totalFiles} file{totalFiles === 1 ? "" : "s"}
                {truncated && " · showing the first 2,000"}
              </div>
            )}
          </div>
        </div>

        {/* Right column: result tree */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {groups.length === 0 && !searching && (
            <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
              <SearchIcon size={22} className="text-text-5" />
              {query.trim() ? (
                <>
                  <div className="text-base text-text-2">
                    Nothing matches “{query.trim()}”.
                  </div>
                  <div className="text-sm text-text-5">
                    Try fewer letters, or turn off the match filters above.
                  </div>
                </>
              ) : (
                <>
                  <div className="text-base text-text-2">
                    Search across every file in this project.
                  </div>
                  <div className="text-sm text-text-5">
                    Type above to begin. Press{" "}
                    <Kbd>⌘⇧F</Kbd> any time to come back.
                  </div>
                </>
              )}
            </div>
          )}

          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.path);
            const { dir, base } = splitRelPath(group.path);
            return (
              <div key={group.path} className="border-b border-line-soft/60">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-chrome/40 hover:bg-bg-chrome cursor-pointer group">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.path)}
                    className="flex-1 min-w-0 flex items-center gap-2 text-left"
                  >
                    <span className="text-2xs text-text-5 w-2.5 shrink-0">
                      {isCollapsed ? "▸" : "▾"}
                    </span>
                    <FileText
                      size={13}
                      className="text-text-4 shrink-0"
                    />
                    <span className="text-base text-text-1 truncate shrink-0 max-w-[55%]">
                      {base}
                    </span>
                    {dir && (
                      <span className="text-xs text-text-5 font-mono truncate">
                        {dir}
                      </span>
                    )}
                  </button>
                  <span className="shrink-0 rounded-full bg-bg-2 px-1.5 py-px text-2xs text-text-4 tabular-nums">
                    {group.hits.length}
                  </span>
                  {canReplace && (
                    <button
                      type="button"
                      disabled={replacing}
                      onClick={() => replaceInFiles([group.path])}
                      title="Replace in this file"
                      className="opacity-0 group-hover:opacity-100 text-xs px-1.5 py-0.5 rounded bg-bg-2 text-text-3 hover:text-text-1 disabled:opacity-40"
                    >
                      Replace
                    </button>
                  )}
                </div>
                {!isCollapsed && (
                  <div className="pb-0.5">
                    {group.hits.map((hit, idx) => (
                      <button
                        type="button"
                        key={`${hit.path}:${hit.line}:${hit.column}:${idx}`}
                        onClick={() => openHit(hit)}
                        className="w-full flex items-baseline gap-3 pl-[34px] pr-4 py-[3px] text-left hover:bg-accent/[0.07] group/hit"
                      >
                        <span className="text-xs text-text-5 font-mono w-9 text-right shrink-0 tabular-nums group-hover/hit:text-accent">
                          {hit.line}
                        </span>
                        <span className="text-sm text-text-2 font-mono truncate flex-1">
                          <MatchLine
                            text={hit.preview}
                            query={query}
                            regex={regex}
                            caseSensitive={caseSensitive}
                          />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
