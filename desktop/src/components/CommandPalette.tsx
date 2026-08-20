// ⌘K palette — overlay search box that lists every slash command, every
// app action, and recent files. Navigation is plain arrow keys; ↵ runs;
// esc dismisses. Renders on top of everything via a fixed-position
// backdrop. The host decides what each entry does by routing through
// `onPick(id)`.
//
// Prefix scoping (Linear/Raycast pattern):
//   >  — Aura semantic verbs only (prove, intent, rewind, snapshot…)
//   @  — agent picker; pick + free text → dispatch prompt to that agent
//   /  — slash commands only
//   (no prefix) — everything

import { useEffect, useMemo, useRef, useState } from "react";
import { SLASH_COMMANDS } from "../lib/slashCommands";
import type { AppActionId } from "../lib/keymap";
import { api } from "../lib/api";
import { fetchIntentRows } from "../lib/intentCache";
import { relativeAge } from "../lib/relativeTime";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { useExtCommands } from "../lib/vscodeExt/extCommandStore";
import { groupHits } from "./palette/paletteGroups";
import { PaletteResultRow } from "./palette/PaletteRows";
import { AsciiSpinner } from "./ui/ascii-spinner";

export type PaletteEntry =
  | { kind: "action"; id: AppActionId; label: string; hint?: string }
  | { kind: "slash"; id: string; label: string; hint?: string }
  | { kind: "file"; id: string; label: string; hint?: string }
  | {
      kind: "extCommand";
      id: string;
      label: string;
      hint?: string;
      /** The VS Code command id to run in the web-extension host. */
      command: string;
    }
  | { kind: "agent"; id: string; label: string; hint?: string; prompt: string }
  | {
      kind: "match";
      id: string;
      label: string;
      hint?: string;
      /** Absolute file path the editor should open. */
      path: string;
      /** 1-based line number to scroll to. */
      line: number;
      column?: number;
    }
  | {
      kind: "symbol";
      id: string;
      label: string;
      hint?: string;
      path: string;
      line: number;
      column?: number;
      symbolKind: string;
    }
  | {
      kind: "intent";
      id: string;
      label: string;
      hint?: string;
      /** Epoch-ms the reason was logged — drives the "open this reason" jump. */
      timestamp: number;
      /** First file the reason touched, absolute path — the click target.
       *  Absent when the changeset is empty (open the reason editor instead). */
      path?: string;
      line?: number;
    }
  | {
      kind: "chat";
      id: string;
      label: string;
      hint?: string;
      sessionId: string;
      repoRoot: string | null;
      turnIndex: number | null;
    }
  | {
      kind: "workspace";
      id: string;
      label: string;
      hint?: string;
      /** Absolute workspace root the app switches to via loadProjectAt. */
      root: string;
      /** Epoch-ms this project was last opened — drives recency ordering. */
      lastOpened: number;
    };

export type PaletteAgent = {
  id: string;
  label: string;
  available?: boolean;
};

// Pre-normalized reason-log row used by the intent search lane.
type PaletteIntentRow = {
  id: string;
  intent: string;
  timestamp: number;
  agent: string;
  /** First touched file (absolute) — the jump target. */
  path?: string;
  fileCount: number;
};

// Compact "2h ago" / "3d ago" stamp for reason rows.
function relativeTime(ts: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAge(ts);
}

// Trim the agent id to a readable label for the reason row hint.
function shortAgent(id: string): string {
  if (!id) return "";
  const s = id.replace(/^cli:/, "");
  return s.length > 18 ? `${s.slice(0, 18)}…` : s;
}

const APP_ACTIONS: PaletteEntry[] = [
  { kind: "action", id: "open_aura", label: "Open Aura: your command centre", hint: "⌘⌥A" },
  { kind: "action", id: "toggle_sidebar", label: "Toggle Sidebar", hint: "⌘B" },
  { kind: "action", id: "toggle_terminal", label: "Toggle Terminal", hint: "⌘J" },
  { kind: "action", id: "run_project", label: "Run this project", hint: "⌘R" },
  { kind: "action", id: "toggle_review", label: "Toggle Review Panel", hint: "⌘⌥R" },
  { kind: "action", id: "save", label: "Save File", hint: "⌘S" },
  { kind: "action", id: "close_tab", label: "Close Tab", hint: "⌘W" },
  { kind: "action", id: "settings", label: "Open Settings", hint: "⌘," },
  { kind: "action", id: "shortcuts", label: "Keyboard Shortcuts", hint: "⌘/" },
  { kind: "action", id: "extensions", label: "Extensions: Add Themes & Languages…" },
  { kind: "action", id: "mobile_waitlist", label: "Aura on your phone: Join the waitlist…" },
  { kind: "action", id: "time_machine", label: "Time machine: Travel back & recover…", hint: "⌘⌥T" },
  { kind: "action", id: "project_timeline", label: "Project timeline: Relive how it was built…" },
  { kind: "action", id: "workspaces", label: "Workspaces: See every parallel copy…", hint: "⌘⇧W" },
  { kind: "action", id: "tasks_board", label: "Open Tasks Board", hint: "⌘T" },
  { kind: "action", id: "orchestrate", label: "Orchestrate Multi-Step Session…" },
  { kind: "action", id: "notes", label: "Open Team Notes" },
  { kind: "action", id: "open_prs", label: "Open Pull Requests" },
  { kind: "action", id: "aura_ask", label: "Ask Aura about your project…" },
  { kind: "action", id: "aura_status", label: "Aura: Project Status" },
  { kind: "action", id: "aura_doctor", label: "Aura: Project Health Check" },
  { kind: "action", id: "aura_impacts", label: "Aura: Changes That Touch Your Work" },
  { kind: "action", id: "aura_snapshot", label: "Aura: Save a Point…" },
  { kind: "action", id: "aura_rewind", label: "Aura: Time Machine…" },
  { kind: "action", id: "aura_log_intent", label: "Aura: Add a Reason…", hint: "⌘⇧I" },
  { kind: "action", id: "aura_handover", label: "Aura: Hand Off to a New Chat" },
  { kind: "action", id: "aura_pr_review", label: "Aura: Review PR" },
  { kind: "action", id: "aura_prove", label: "Aura: Check It's Built…" },
];

const SLASH_ENTRIES: PaletteEntry[] = SLASH_COMMANDS.map((c) => ({
  kind: "slash",
  id: c.name,
  label: c.name,
  hint: c.description,
}));

type CommandPaletteProps = {
  open: boolean;
  recentFiles?: Array<{ path: string; name: string }>;
  /** Available agents — palette uses these for `@` dispatch. */
  agents?: PaletteAgent[];
  /** When set, palette indexes the workspace via `fs_find_files` and
   *  surfaces matching files alongside actions/slash commands. The
   *  `:` prefix scopes results to files only. */
  repoRoot?: string;
  onClose: () => void;
  onPick: (entry: PaletteEntry) => void;
};

type Scope = "all" | "aura" | "agent" | "slash" | "file" | "code";

function scopeForQuery(q: string): { scope: Scope; rest: string } {
  if (q.startsWith(">")) return { scope: "aura", rest: q.slice(1).trimStart() };
  if (q.startsWith("@")) return { scope: "agent", rest: q.slice(1).trimStart() };
  if (q.startsWith("/")) return { scope: "slash", rest: q.slice(1).trimStart() };
  if (q.startsWith(":")) return { scope: "file", rest: q.slice(1).trimStart() };
  // `?` forces content-grep scope (Linear pattern: question mark = "what
  // is this thing"). Default `all` scope ALSO runs content grep async
  // once the query is long enough — see useEffect below.
  if (q.startsWith("?")) return { scope: "code", rest: q.slice(1).trimStart() };
  return { scope: "all", rest: q };
}

const FILE_RESULT_LIMIT = 40;

// Chat search matches raw message bodies, so a snippet can arrive carrying
// markdown (`**bold**`, `- ` bullets, `# ` headings, ``code``), pasted URLs,
// and hard line breaks. Rendered verbatim in a one-line palette row that reads
// as broken formatting — so flatten it to clean prose before display. Keeps
// alphanumerics intact so the query highlight still lands on the match.
function cleanChatText(
  raw: string | null | undefined,
  opts: { stripUrls?: boolean } = {},
): string {
  let s = raw ?? "";
  if (opts.stripUrls) s = s.replace(/https?:\/\/\S+/g, " ");
  return s
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/(^|\s)[*_]([^*_]+)[*_]/g, "$1$2") // italic
    .replace(/^\s*#{1,6}\s+/gm, "") // headings
    .replace(/^\s*[-*•>]\s+/gm, "") // bullets / blockquotes
    .replace(/\s+/g, " ") // collapse newlines + runs of space
    .trim();
}

export function CommandPalette({
  open,
  recentFiles = [],
  agents = [],
  repoRoot,
  onClose,
  onPick,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  // Async lanes — grep + symbol search land asynchronously and merge
  // into the result list. Both are scoped to `repoRoot` and reset when
  // the palette opens or the query changes.
  const [grepHits, setGrepHits] = useState<PaletteEntry[]>([]);
  const [grepTruncated, setGrepTruncated] = useState(false);
  const [symbolHits, setSymbolHits] = useState<PaletteEntry[]>([]);
  const [intentRows, setIntentRows] = useState<PaletteIntentRow[]>([]);
  const [chatHits, setChatHits] = useState<PaletteEntry[]>([]);
  const [chatSearching, setChatSearching] = useState(false);
  const [searching, setSearching] = useState(false);
  const [workspaceEntries, setWorkspaceEntries] = useState<PaletteEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Pull the project registry once per open so ⌘K doubles as a workspace
  // switcher — jump to any other project by name, most-recently-opened first.
  // The list is small (the machine's registered roots) and the current
  // workspace drops out, so this only ever offers a real switch.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .projectsList()
      .then((rows) => {
        if (cancelled) return;
        const entries = [...rows]
          .sort((a, b) => (b.last_opened_at ?? 0) - (a.last_opened_at ?? 0))
          .filter((r) => r.root && r.root !== repoRoot)
          .map<PaletteEntry>((r) => {
            const base = r.root.split("/").filter(Boolean).pop() ?? r.root;
            return {
              kind: "workspace",
              id: `ws:${r.root}`,
              label: r.label?.trim() || base,
              hint: r.last_opened_at ? relativeTime(r.last_opened_at) : undefined,
              root: r.root,
              lastOpened: r.last_opened_at ?? 0,
            };
          });
        setWorkspaceEntries(entries);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repoRoot]);

  // Index the workspace once per open. `git ls-files` is fast (sub-100ms
  // even on large repos) and respects .gitignore for free.
  useEffect(() => {
    if (!open || !repoRoot) return;
    let cancelled = false;
    api.fsFindFiles(repoRoot).then((rels) => {
      if (cancelled) return;
      setWorkspaceFiles(rels);
    });
    return () => {
      cancelled = true;
    };
  }, [open, repoRoot]);

  // Pull the recent reason log (`.aura/intent_log.jsonl`) once per open so a
  // query can search WHY things changed, not just files/code. The log is
  // small (hundreds of rows) and already strips autonomous tool-telemetry at
  // the api boundary, so we filter it client-side in the `hits` memo.
  useEffect(() => {
    if (!open || !repoRoot) {
      setIntentRows([]);
      return;
    }
    let cancelled = false;
    fetchIntentRows(repoRoot, 400)
      .then((rows) => {
        if (cancelled) return;
        setIntentRows(
          rows
            .filter((r) => r.intent && r.intent.trim().length > 0)
            .map((r) => {
              const first = r.changeset?.files?.[0]?.path;
              return {
                id: `intent:${r.timestamp}`,
                intent: r.intent.trim(),
                timestamp: r.timestamp,
                agent: r.agent_id || "",
                path: first ? `${repoRoot}/${first}` : undefined,
                fileCount: r.changeset?.files?.length ?? 0,
              };
            }),
        );
      })
      .catch(() => {
        if (!cancelled) setIntentRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repoRoot]);

  // Async grep + symbol search. Fires when the query is ≥3 chars and
  // we're either in the explicit `?` scope or the default `all` scope
  // (so a user typing "fromPersistence" sees code matches even without
  // a prefix). Debounce keeps git from forking on every keystroke.
  const { scope: liveScope, rest: liveRest } = useMemo(
    () => scopeForQuery(query),
    [query],
  );
  const debouncedQuery = useDebouncedValue(liveRest, 140);
  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!open || liveScope !== "all" || q.length < 2) {
      setChatHits([]);
      setChatSearching(false);
      return;
    }
    let cancelled = false;
    setChatSearching(true);
    api
      .managerSearch(q, 40)
      .then((rows) => {
        if (cancelled) return;
        setChatHits(
          rows.map((row) => ({
            kind: "chat" as const,
            id: `chat:${row.session_id}:${row.turn_index ?? "title"}`,
            label: cleanChatText(row.snippet) || "(empty message)",
            hint: [
              cleanChatText(row.objective, { stripUrls: true }),
              row.role === "title" ? null : row.role,
              row.repo_root?.split("/").filter(Boolean).pop(),
            ]
              .filter(Boolean)
              .join(" · "),
            sessionId: row.session_id,
            repoRoot: row.repo_root,
            turnIndex: row.turn_index,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setChatHits([]);
      })
      .finally(() => {
        if (!cancelled) setChatSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debouncedQuery, liveScope]);

  useEffect(() => {
    if (!open || !repoRoot) {
      setGrepHits([]);
      setSymbolHits([]);
      setGrepTruncated(false);
      return;
    }
    const q = debouncedQuery.trim();
    const wantContent =
      q.length >= 3 && (liveScope === "all" || liveScope === "code");
    if (!wantContent) {
      setGrepHits([]);
      setSymbolHits([]);
      setGrepTruncated(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    // Symbol lookup: only worth firing for identifier-shaped queries
    // (letters / digits / underscore). Skip otherwise — it's a grep
    // pattern, not a name.
    const isIdent = /^[A-Za-z_][A-Za-z0-9_]*$/.test(q);
    Promise.all([
      api.fsGrepContent(repoRoot, q, { case_sensitive: false }).catch(() => ({
        hits: [],
        truncated: false,
      })),
      isIdent
        ? api.fsGrepSymbol(repoRoot, q).catch(() => [])
        : Promise.resolve([]),
    ]).then(([grep, syms]) => {
      if (cancelled) return;
      setGrepTruncated(grep.truncated);
      setGrepHits(
        grep.hits.map<PaletteEntry>((h) => ({
          kind: "match",
          id: `${h.path}:${h.line}:${h.column}`,
          label: h.preview.trim() || `${h.path}:${h.line}`,
          hint: `${h.path}:${h.line}`,
          path: `${repoRoot}/${h.path}`,
          line: h.line,
          column: h.column || 1,
        })),
      );
      setSymbolHits(
        syms.map<PaletteEntry>((s) => ({
          kind: "symbol",
          id: `sym:${s.path}:${s.line}:${s.name}`,
          label: s.name,
          hint: `${s.kind} · ${s.path}:${s.line}`,
          path: `${repoRoot}/${s.path}`,
          line: s.line,
          symbolKind: s.kind,
        })),
      );
      setSearching(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, repoRoot, debouncedQuery, liveScope]);

  const recentPathSet = useMemo(
    () => new Set(recentFiles.map((f) => f.path)),
    [recentFiles],
  );

  const fileEntries: PaletteEntry[] = useMemo(() => {
    if (!repoRoot) return [];
    return workspaceFiles
      .map((rel) => `${repoRoot}/${rel}`)
      .filter((abs) => !recentPathSet.has(abs))
      .map((abs) => {
        const segs = abs.split("/");
        return {
          kind: "file" as const,
          id: abs,
          label: segs[segs.length - 1] ?? abs,
          hint: abs.startsWith(repoRoot + "/")
            ? abs.slice(repoRoot.length + 1)
            : abs,
        };
      });
  }, [workspaceFiles, repoRoot, recentPathSet]);

  // Commands contributed by enabled VS Code web extensions — runnable straight
  // from the palette, just like a built-in action.
  const extCommands = useExtCommands();
  const extEntries: PaletteEntry[] = useMemo(
    () =>
      extCommands.map((c) => ({
        kind: "extCommand",
        id: `ext:${c.command}`,
        label: c.title,
        hint: c.extName,
        command: c.command,
      })),
    [extCommands],
  );

  const all: PaletteEntry[] = useMemo(
    () => [
      ...APP_ACTIONS,
      ...SLASH_ENTRIES,
      ...extEntries,
      ...recentFiles.map<PaletteEntry>((f) => ({
        kind: "file",
        id: f.path,
        label: f.name,
        hint: f.path,
      })),
      ...fileEntries,
    ],
    [recentFiles, fileEntries, extEntries],
  );

  const { scope, rest } = useMemo(() => scopeForQuery(query), [query]);
  // Re-use the same debounce as the async lane so the sync filter and
  // async fetch land on the same input snapshot.
  const debouncedRest = useDebouncedValue(rest, 60);

  const hits = useMemo(() => {
    const q = debouncedRest.toLowerCase().trim();

    if (scope === "agent") {
      // The `@` view is its own picker — list agents (filtered by name)
      // and let pick = "send the rest of the prompt to that agent".
      // If the user hasn't typed anything past the @, prompt is empty
      // and the host can decide whether to focus the agent's tab.
      const promptIdx = query.indexOf(" ");
      const namePart =
        promptIdx >= 0
          ? query.slice(1, promptIdx).trim().toLowerCase()
          : rest.toLowerCase();
      const promptText = promptIdx >= 0 ? query.slice(promptIdx + 1).trim() : "";
      return agents
        .filter((a) =>
          namePart ? a.id.includes(namePart) || a.label.toLowerCase().includes(namePart) : true,
        )
        .map<PaletteEntry>((a) => ({
          kind: "agent",
          id: a.id,
          label: a.label,
          hint: promptText
            ? `→ "${promptText.slice(0, 64)}${promptText.length > 64 ? "…" : ""}"`
            : "select to focus tab",
          prompt: promptText,
        }));
    }

    // Symbols rank highest (exact AST-level definitions), then content
    // matches, then files/actions. `code` scope shows only those.
    const codeLane: PaletteEntry[] = [...symbolHits, ...grepHits];

    // Reason-log lane: when there's a query, surface logged intents whose
    // text mentions it — "search through intents" straight from ⌘K.
    const intentLane: PaletteEntry[] =
      q && scope === "all"
        ? intentRows
            .filter((r) => r.intent.toLowerCase().includes(q))
            .slice(0, 6)
            .map<PaletteEntry>((r) => ({
              kind: "intent",
              id: r.id,
              label: r.intent,
              hint: [
                shortAgent(r.agent),
                relativeTime(r.timestamp),
                r.fileCount
                  ? `${r.fileCount} file${r.fileCount > 1 ? "s" : ""}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · "),
              timestamp: r.timestamp,
              path: r.path,
              line: r.path ? 1 : undefined,
            }))
        : [];

    // Workspace lane: other registered projects, most-recent first. With a
    // query, filter by name; with none, show a few recent so ⌘K opens as a
    // fast project switcher.
    const wsLane: PaletteEntry[] =
      scope === "all"
        ? q
          ? workspaceEntries.filter(
              (e) =>
                e.label.toLowerCase().includes(q) ||
                e.hint?.toLowerCase().includes(q),
            )
          : workspaceEntries.slice(0, 5)
        : [];

    if (scope === "code") {
      // Pure content view — filter by query against the preview text
      // for relevance ordering; backend already did the heavy lift.
      if (!q) return codeLane.slice(0, 200);
      return codeLane.filter(
        (e) =>
          e.label.toLowerCase().includes(q) ||
          e.hint?.toLowerCase().includes(q),
      );
    }

    let pool = all;
    if (scope === "aura") {
      pool = pool.filter(
        (e) =>
          (e.kind === "action" && (e.id.startsWith("aura_") || /^(Engine|Aura):/.test(e.label))) ||
          (e.kind === "slash" && /^aura_/.test(e.id)),
      );
    } else if (scope === "slash") {
      pool = pool.filter((e) => e.kind === "slash");
    } else if (scope === "file") {
      pool = pool.filter((e) => e.kind === "file");
    }
    if (!q) {
      // No-query view: clip the file lane so we don't drown the user
      // in 4k workspace paths the moment they hit ⌘K.
      if (scope === "all") {
        const nonFile = pool.filter((e) => e.kind !== "file");
        const file = pool.filter((e) => e.kind === "file").slice(0, 6);
        return [...nonFile, ...wsLane, ...file];
      }
      if (scope === "file") return pool.slice(0, FILE_RESULT_LIMIT);
      return pool;
    }
    // Score so a filename match outranks a path-only hit; depth penalty
    // breaks ties between several `index.ts` candidates.
    const scored: Array<{ e: PaletteEntry; score: number }> = [];
    for (const e of pool) {
      const lbl = e.label.toLowerCase();
      const hint = e.hint?.toLowerCase() ?? "";
      let score = 0;
      if (lbl === q) score = 1000;
      else if (lbl.startsWith(q)) score = 600;
      else if (lbl.includes(q)) score = 400;
      else if (hint.includes(q)) score = 200;
      else continue;
      if (e.kind === "file" && hint) {
        score -= hint.split("/").length;
      }
      scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const sortedPool = scored.map((s) => s.e);
    if (scope === "all") {
      const nonFile = sortedPool.filter((e) => e.kind !== "file");
      const file = sortedPool.filter((e) => e.kind === "file").slice(0, 12);
      // Code lane sandwiched between sync hits (actions/files) and any
      // remaining file matches — symbols + content matches are usually
      // what the user wants when they typed a non-prefixed query, but
      // keeping action/slash hits on top preserves muscle memory for
      // existing palette users.
      const symLane = symbolHits.slice(0, 8);
      const grepLane = grepHits.slice(0, 30);
      return [...chatHits, ...symLane, ...nonFile, ...wsLane, ...grepLane, ...intentLane, ...file];
    }
    return sortedPool.slice(0, scope === "file" ? FILE_RESULT_LIMIT : 200);
  }, [all, agents, scope, debouncedRest, query, symbolHits, grepHits, intentRows, chatHits, workspaceEntries]);

  // Group the ranked hits into plain-language sections; `flat` is the same
  // rows concatenated in display order so arrow keys walk every row.
  const { sections, flat } = useMemo(() => groupHits(hits), [hits]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIdx(0);
      // Defer focus so the dialog actually mounts first.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep the cursor in range as the grouped result set shrinks/grows.
  useEffect(() => {
    setIdx((i) => (i >= flat.length ? Math.max(0, flat.length - 1) : i));
  }, [flat.length]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      // Down / Tab move forward, Up / Shift-Tab back — both wrap at the ends
      // so the cursor rolls bottom-to-top instead of dead-ending, and Tab is a
      // reliable alias for the arrows (Conductor parity).
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        setIdx((i) => (flat.length ? (i + 1) % flat.length : 0));
        return;
      }
      if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        setIdx((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const hit = flat[idx];
        if (hit) onPick(hit);
        return;
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, flat, idx, onClose, onPick]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 flex items-start justify-center pt-[14vh] z-50"
      style={{
        background: "color-mix(in srgb, var(--color-bg-0) 72%, transparent)",
        backdropFilter: "blur(4px)",
      }}
      onMouseDown={onClose}
    >
      <div
        className="w-full overflow-hidden rounded-lg border border-line-soft bg-bg-1 text-text-1 shadow-[var(--shadow-flyout)]"
        style={{ maxWidth: 640 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-3 py-2 border-b border-line-soft">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-text-4">
            <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" fill="none" />
            <line x1="10" y1="10" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          {scope !== "all" && (
            // One chip, one look. Five scopes wearing violet / blue / green /
            // amber taught the user nothing the WORD in the chip doesn't
            // already say, and two of those hues were off-token hex fallbacks.
            <span className="meta-tag ml-3">
              {scope === "aura"
                ? "Aura"
                : scope === "agent"
                  ? "Agent"
                  : scope === "file"
                    ? "File"
                    : scope === "code"
                      ? "Code"
                      : "Slash"}
            </span>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIdx(0);
            }}
            placeholder="Search conversations, actions, files, code…  ·  @ agent  /  command  :  file"
            className="flex-1 bg-transparent outline-none ml-3 text-text-1 text-base placeholder:text-text-4"
          />
          {(searching || chatSearching) && (
            <AsciiSpinner className="mr-2 text-xs" />
          )}
          <span className="text-2xs text-text-5 tracking-wider">esc</span>
        </div>

        <ul className="max-h-[58vh] overflow-y-auto py-1.5">
          {flat.length === 0 ? (
            <li className="px-4 py-6 text-center text-text-4 text-sm">
              {searching ? (
                <AsciiSpinner className="text-sm" />
              ) : (
                "No matches"
              )}
            </li>
          ) : (
            sections.map((section, si) => {
              const offset = sections
                .slice(0, si)
                .reduce((n, s) => n + s.items.length, 0);
              return (
                <li key={section.key}>
                  <div className="flex items-center gap-2 px-3.5 pb-1 pt-2.5">
                    <span className="section-label">
                      {section.label}
                    </span>
                    <span className="text-2xs text-text-5/60">
                      {section.items.length}
                    </span>
                  </div>
                  <ul>
                    {section.items.map((e, j) => {
                      const i = offset + j;
                      return (
                        <PaletteResultRow
                          key={`${e.kind}:${e.id}`}
                          entry={e}
                          query={rest}
                          active={i === idx}
                          onHover={() => setIdx(i)}
                          onPick={() => onPick(e)}
                        />
                      );
                    })}
                  </ul>
                </li>
              );
            })
          )}
          {grepTruncated && (
            <li className="mt-1 border-t border-line-soft px-3.5 py-1.5 text-xs text-text-5">
              Showing the first matches. Type a bit more to narrow it down.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
