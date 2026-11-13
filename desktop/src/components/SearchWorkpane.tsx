// v0.2.28 — Project-wide search + replace workpane (⌘⇧F).
//
// An overlay above the work surface, drawn from the shared page parts. Left
// column: query input, optional replace input, regex / case / whole-word
// toggles, include / exclude glob inputs. Right column: matches grouped by
// file, with per-match jump, per-file Replace, and Replace all.
//
// Backed by the Tauri `fs_grep_content` + `fs_replace_in_files` commands
// in `src-tauri/src/cmd_search.rs`. The replace path runs in-process via
// the `regex` crate (atomic tmp + rename) so it's safe to run on dirty
// trees — git diff afterwards shows exactly what changed.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Search as SearchIcon, X } from "lucide-react";
import { api, type GrepHit, type GrepOpts, type ReplaceReport } from "../lib/api";
import { Alert, AlertDescription } from "./ui/alert";
import { AsciiSpinner } from "./ui/ascii-spinner";
import { askConfirm } from "./ui/ask";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";
import { EmptyState } from "./ui/state";
import { Toggle } from "./ui/toggle";
import { TraceList, TraceGroup } from "./ui/trace-list";
import { TraceHeader } from "./ui/trace-page";
import "./ui/repo-search.css";

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
      <mark className="ui-repo-search-mark">
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
  const tally =
    `${totalHits} ${totalHits === 1 ? "match" : "matches"} in ` +
    `${totalFiles} ${totalFiles === 1 ? "file" : "files"}`;

  return (
    <div className="ui-repo-search">
      <TraceHeader
        leading={<SearchIcon size={16} className="ui-repo-search-glyph" />}
        title="Search this repository"
        actions={
          <>
            <span className="ui-repo-search-root" title={repoRoot}>
              {shortPath(repoRoot)}
            </span>
            <Toggle
              size="sm"
              pressed={showReplace}
              onPressedChange={setShowReplace}
              title="Show the replace field"
            >
              Replace
            </Toggle>
            <Button
              variant="ghost"
              size="iconSm"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close search"
            >
              <X size={14} />
            </Button>
          </>
        }
      />

      {error && (
        <Alert variant="destructive" className="ui-repo-search-alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* A finished replace is a receipt, not an alarm — it reads on the
          neutral alert; only the failure above carries colour. */}
      {report && (
        <Alert className="ui-repo-search-alert">
          <AlertDescription>
            Replaced {report.total_replacements} occurrence
            {report.total_replacements === 1 ? "" : "s"} across {report.files_changed} file
            {report.files_changed === 1 ? "" : "s"}.
          </AlertDescription>
        </Alert>
      )}

      <div className="ui-repo-search-body">
        {/* What to look for, and where. */}
        <aside className="ui-repo-search-side">
          <div className="ui-repo-search-section">
            <Input
              ref={queryRef}
              type="text"
              size="small"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search for"
              className="ui-repo-search-query"
              suffix={
                <span className="ui-repo-search-flags">
                  <Toggle
                    size="sm"
                    pressed={caseSensitive}
                    onPressedChange={setCaseSensitive}
                    title="Match case"
                    aria-label="Match case"
                  >
                    Aa
                  </Toggle>
                  <Toggle
                    size="sm"
                    pressed={wholeWord}
                    onPressedChange={setWholeWord}
                    title="Whole word"
                    aria-label="Whole word"
                  >
                    ab
                  </Toggle>
                  <Toggle
                    size="sm"
                    pressed={regex}
                    onPressedChange={setRegex}
                    title="Regular expression"
                    aria-label="Regular expression"
                  >
                    .*
                  </Toggle>
                </span>
              }
            />

            {showReplace && (
              <div className="ui-repo-search-replace">
                <Input
                  type="text"
                  size="small"
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  placeholder="Replace"
                  aria-label="Replace with"
                  className="ui-repo-search-query"
                />
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={!canReplace || replacing}
                  onClick={() => replaceInFiles(groups.map((g) => g.path))}
                  title="Replace in every file that matches"
                >
                  Replace all
                </Button>
              </div>
            )}
          </div>

          <div className="ui-repo-search-section">
            <Field label="Files to include" htmlFor="repo-search-include">
              <Input
                id="repo-search-include"
                type="text"
                size="small"
                value={include}
                onChange={(e) => setInclude(e.target.value)}
                placeholder="src/**/*.ts, *.md"
                className="ui-repo-search-query"
              />
            </Field>
            <Field label="Files to exclude" htmlFor="repo-search-exclude">
              <Input
                id="repo-search-exclude"
                type="text"
                size="small"
                value={exclude}
                onChange={(e) => setExclude(e.target.value)}
                placeholder="**/dist/**, **/*.lock"
                className="ui-repo-search-query"
              />
            </Field>
          </div>

          <div className="ui-repo-search-status" aria-live="polite">
            {searching ? (
              <>
                <AsciiSpinner />
                Searching…
              </>
            ) : query.trim() ? (
              <>
                {tally}
                {truncated && " · showing the first 2,000"}
              </>
            ) : null}
          </div>
        </aside>

        {/* What it found, by file. */}
        <div className="ui-repo-search-results">
          {groups.length === 0 && !searching ? (
            query.trim() ? (
              <EmptyState
                icon={SearchIcon}
                title={`Nothing matches “${query.trim()}”.`}
                body="Try fewer letters, or turn off the match filters."
              />
            ) : (
              <EmptyState
                icon={SearchIcon}
                title="Search across every file in this repository."
                body={
                  <>
                    Type to begin. Press <Kbd>⌘⇧F</Kbd> any time to come back.
                  </>
                }
              />
            )
          ) : (
            <TraceList label="Matches by file">
              {groups.map((group) => {
                const { dir, base } = splitRelPath(group.path);
                return (
                  <TraceGroup
                    key={group.path}
                    label={
                      <span className="ui-repo-search-file" title={group.path}>
                        <FileText size={13} />
                        <span className="ui-repo-search-base">{base}</span>
                        {dir && <span className="ui-repo-search-dir">{dir}</span>}
                      </span>
                    }
                    count={group.hits.length}
                    collapsed={collapsed.has(group.path)}
                    onToggle={() => toggleGroup(group.path)}
                    actions={
                      canReplace ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={replacing}
                          onClick={() => replaceInFiles([group.path])}
                          title={`Replace in ${group.path}`}
                        >
                          Replace
                        </Button>
                      ) : undefined
                    }
                  >
                    {group.hits.map((hit, idx) => (
                      <div role="listitem" key={`${hit.path}:${hit.line}:${hit.column}:${idx}`}>
                        <button
                          type="button"
                          className="ui-repo-search-hit"
                          onClick={() => openHit(hit)}
                          title={`${group.path}:${hit.line}`}
                        >
                          <span className="ui-repo-search-line">{hit.line}</span>
                          <span className="ui-repo-search-text">
                            <MatchLine
                              text={hit.preview}
                              query={query}
                              regex={regex}
                              caseSensitive={caseSensitive}
                            />
                          </span>
                        </button>
                      </div>
                    ))}
                  </TraceGroup>
                );
              })}
            </TraceList>
          )}
        </div>
      </div>
    </div>
  );
}
