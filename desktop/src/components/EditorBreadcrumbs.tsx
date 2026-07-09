// Thin breadcrumb bar above the editor. Resolves the cursor line to the
// enclosing symbol from the existing `aura_semantic_outline` snapshot.
// Pure UI — refetches when the file or buffer's line count changes
// (matches OutlinePanel's heuristic) and listens to a "cursor:moved"
// custom event from the editor host so the crumb tracks live.
//
// Without symbol-range info from the backend we approximate "enclosing"
// as "the most recent symbol whose line ≤ cursor." Good enough for
// scanning where you are; refine to true nesting once outline returns
// end-lines.

import { type ReactNode, useEffect, useState } from "react";
import { api, type BlameLine, type OutlineNode } from "../lib/api";
import { SymbolContextMenu } from "./SymbolContextMenu";

type Props = {
  repoRoot: string;
  filePath: string;
  /** Repo-relative crumb the user clicks to copy. Lets the leftmost
   *  segment double as a "copy file path" affordance. */
  fileLabel: string;
  /** Line count change is the cheap "did the symbol layout move?" heuristic. */
  buffer: string;
  /** 1-based cursor line emitted by the editor's update listener. */
  cursorLine: number;
  /** Right-aligned controls for this file (e.g. the markdown
   *  Raw/Rendered/Split toggle). Sits at the far end of the crumb bar,
   *  after the blame chip. */
  trailing?: ReactNode;
};

export function EditorBreadcrumbs({
  repoRoot,
  filePath,
  fileLabel,
  buffer,
  cursorLine,
  trailing,
}: Props) {
  const [nodes, setNodes] = useState<OutlineNode[]>([]);
  const [blame, setBlame] = useState<BlameLine[] | null>(null);
  const linesKey = buffer.split("\n").length;

  useEffect(() => {
    let cancelled = false;
    api
      .auraSemanticOutline(repoRoot, filePath)
      .then((n) => {
        if (!cancelled) setNodes(n);
      })
      .catch(() => {
        if (!cancelled) setNodes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, filePath, linesKey]);

  // Blame is heavier than outline (full git invocation). Debounce to
  // avoid hammering the repo on every keystroke while editing — 600ms
  // settle is below user-visible latency for cursor moves.
  useEffect(() => {
    let cancelled = false;
    const id = window.setTimeout(() => {
      api
        .gitBlameLines(repoRoot, filePath)
        .then((b) => {
          if (!cancelled) setBlame(b);
        })
        .catch(() => {
          if (!cancelled) setBlame(null);
        });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [repoRoot, filePath, linesKey]);

  const enclosing = mostRecentBefore(nodes, cursorLine);
  const lineBlame = blame?.find((b) => b.line === cursorLine) ?? null;
  // Split the file label into directory + basename so the crumb reads
  // "src/lib  /  api.ts  ›  fn  myFn" without overwhelming the bar.
  const lastSlash = fileLabel.lastIndexOf("/");
  const dir = lastSlash >= 0 ? fileLabel.slice(0, lastSlash) : "";
  const base = lastSlash >= 0 ? fileLabel.slice(lastSlash + 1) : fileLabel;

  return (
    <div className="flex items-center gap-1.5 px-3 h-6 text-[11px] bg-bg-chrome border-b border-line-soft text-text-3 flex-shrink-0">
      {dir && (
        <>
          <span className="truncate text-text-4 font-mono">{dir}</span>
          <Sep />
        </>
      )}
      <span className="text-text-2 font-mono">{base}</span>
      {enclosing && (
        <>
          <Sep />
          <KindBadge kind={enclosing.kind} />
          <SymbolContextMenu
            identifier={enclosing.name}
            filePath={filePath}
            kind={enclosing.kind}
          >
            <span
              className="text-text-1 font-mono truncate cursor-default hover:underline underline-offset-2 decoration-text-5"
              title="right-click for actions on this piece"
            >
              {enclosing.name}
            </span>
          </SymbolContextMenu>
        </>
      )}
      {(lineBlame || trailing) && (
        <div className="ml-auto flex items-center gap-2.5">
          {lineBlame && (
            <span
              className="flex items-center gap-1.5 text-text-4 truncate"
              title={`${lineBlame.summary}\n${lineBlame.sha}`}
            >
              <span className="text-text-3 truncate max-w-[160px]">{lineBlame.author}</span>
              <span className="text-text-5">·</span>
              <span className="tabular-nums">{relAge(lineBlame.ts)}</span>
            </span>
          )}
          {trailing}
        </div>
      )}
    </div>
  );
}

function relAge(ts: number): string {
  if (!ts) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}w`;
  return `${Math.floor(diff / 2592000)}mo`;
}

function Sep() {
  return <span className="text-text-5">›</span>;
}

function KindBadge({ kind }: { kind: string }) {
  const tone =
    kind === "fn"
      ? "text-accent-green"
      : kind === "class"
        ? "text-violet"
        : kind === "type"
          ? "text-amber"
          : "text-text-3";
  return (
    <span className={`text-[9px] uppercase tracking-wider ${tone}`}>{kind}</span>
  );
}

function mostRecentBefore(
  nodes: OutlineNode[],
  line: number,
): OutlineNode | null {
  let best: OutlineNode | null = null;
  for (const n of nodes) {
    if (n.line <= line && (!best || n.line > best.line)) best = n;
  }
  return best;
}
