// The ⌘K palette's search lanes over the open folder and your conversations:
// the folder's files (indexed once per open), the reason log, conversation
// search, and code search (text matches and definitions). Each lane fetches
// on its own and lands when it lands. A place with no folder here (the
// cloud) passes no `repoRoot` and no conversations, and the lanes stay empty.

import { useEffect, useState } from "react";

import { api } from "../../lib/api";
import { fetchIntentRows } from "../../lib/intentCache";
import { fsFindFiles } from "../../lib/place/workApi";
import type { PaletteEntry } from "../CommandPalette";

/** A logged reason, normalised for the reasons lane. */
export type PaletteIntentRow = {
  id: string;
  intent: string;
  /** Epoch seconds, as `.aura/intent_log.jsonl` stamps it. */
  timestamp: number;
  agent: string;
  /** First touched file (absolute) — the jump target. */
  path?: string;
  fileCount: number;
};

export type PaletteLaneScope = "all" | "aura" | "agent" | "slash" | "file" | "code";

// Chat search matches raw message bodies, so a snippet can arrive carrying
// markdown (`**bold**`, `- ` bullets, `# ` headings, ``code``), pasted URLs,
// and hard line breaks. Rendered verbatim in a one-line palette row that reads
// as broken formatting — so flatten it to clean prose before display. Keeps
// alphanumerics intact so the query highlight still lands on the match.
export function cleanChatText(
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

export function usePaletteLanes({
  open,
  repoRoot,
  lane,
  query,
  conversations,
}: {
  open: boolean;
  repoRoot?: string;
  lane: PaletteLaneScope;
  /** The debounced query, prefix removed. */
  query: string;
  /** Search your conversations too. */
  conversations: boolean;
}) {
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [grepHits, setGrepHits] = useState<PaletteEntry[]>([]);
  const [grepTruncated, setGrepTruncated] = useState(false);
  const [symbolHits, setSymbolHits] = useState<PaletteEntry[]>([]);
  const [intentRows, setIntentRows] = useState<PaletteIntentRow[]>([]);
  const [chatHits, setChatHits] = useState<PaletteEntry[]>([]);
  const [chatSearching, setChatSearching] = useState(false);
  const [searching, setSearching] = useState(false);

  // Index the workspace once per open. `git ls-files` is fast (sub-100ms
  // even on large repos) and respects .gitignore for free.
  useEffect(() => {
    if (!open || !repoRoot) {
      setWorkspaceFiles([]);
      return;
    }
    let cancelled = false;
    // Off the machine's checkout when the workspace is standing in one — the
    // index has to describe the tree the picks will open (AURA-1306).
    fsFindFiles(repoRoot).then((rels) => {
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
  // the api boundary, so it is filtered client-side.
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

  useEffect(() => {
    const q = query.trim();
    if (!open || !conversations || lane !== "all" || q.length < 2) {
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
  }, [open, conversations, query, lane]);

  // Code search fires when the query is ≥3 chars and we're either in the
  // explicit `?` scope or the default `all` scope (so a user typing
  // "fromPersistence" sees code matches even without a prefix).
  useEffect(() => {
    const q = query.trim();
    const wantContent = q.length >= 3 && (lane === "all" || lane === "code");
    if (!open || !repoRoot || !wantContent) {
      setGrepHits([]);
      setSymbolHits([]);
      setGrepTruncated(false);
      setSearching(false);
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
      isIdent ? api.fsGrepSymbol(repoRoot, q).catch(() => []) : Promise.resolve([]),
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
  }, [open, repoRoot, query, lane]);

  return {
    workspaceFiles,
    grepHits,
    grepTruncated,
    symbolHits,
    intentRows,
    chatHits,
    chatSearching,
    searching,
  };
}
