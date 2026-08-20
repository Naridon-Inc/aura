// Per-kind result rows for the ⌘K palette.
//
// Each result kind carries different information, so each gets its own row IA
// instead of the old one-size badge+label+hint line:
//
//   • Action          — icon · what it does · keyboard shortcut pill
//   • Command (slash)  — /name in mono · one-line description
//   • Extension cmd    — puzzle icon · title · which extension it came from
//   • File             — file glyph · filename (bold) · dimmed folder path
//   • Definition       — kind glyph (ƒ / {} / =) · name · kind · where it lives
//   • In your code     — file:line header · the matching line, match highlighted
//   • Agent            — agent logo · name · "→ prompt" preview / focus hint
//
// Rows share one selectable shell (keyboard + hover + click + auto-scroll);
// only the inner content differs.

import { useEffect, useRef } from "react";
import {
  Braces,
  CornerDownLeft,
  Equal,
  FileText,
  FolderGit2,
  FunctionSquare,
  Hash,
  History,
  MessageSquareText,
  Puzzle,
  Zap,
} from "lucide-react";

import type { PaletteEntry } from "../CommandPalette";
import { AgentIcon } from "../agent/AgentIcon";
import { Kbd } from "../ui/kbd";

// Accelerator hints ("⌘K", "⌘⇧I") render as a kbd pill; descriptions stay text.
function looksLikeAccelerator(s: string): boolean {
  return /^[⌘⌃⌥⇧]+/.test(s.trim());
}

// ── selectable shell ──────────────────────────────────────────────────────
function Row({
  active,
  onHover,
  onPick,
  children,
}: {
  active: boolean;
  onHover: () => void;
  onPick: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <li
      ref={ref}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={`mx-1.5 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 cursor-pointer ${
        active ? "bg-accent/12 text-text-1" : "text-text-2 hover:bg-state-hover"
      }`}
    >
      {children}
    </li>
  );
}

// Leading icon tile — keeps every row's glyph on the same optical column.
function Lead({
  children,
  active,
}: {
  children: React.ReactNode;
  active: boolean;
}) {
  return (
    <span
      className={`grid h-6 w-6 shrink-0 place-items-center rounded-md ${
        active ? "text-accent" : "text-text-4"
      } [&_svg]:h-[15px] [&_svg]:w-[15px]`}
    >
      {children}
    </span>
  );
}

// ── definitions: a glyph per symbol kind ──────────────────────────────────
function SymbolGlyph({ kind }: { kind: string }) {
  const k = kind.toLowerCase();
  if (/(function|method|constructor)/.test(k)) return <FunctionSquare />;
  if (/(class|struct|interface|enum|trait|module|namespace)/.test(k))
    return <Braces />;
  if (/(const|variable|field|property|let|static)/.test(k)) return <Equal />;
  return <Hash />;
}

// Highlight the matched substring inside a longer line of text.
function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const at = lower.indexOf(ql);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="rounded-[3px] bg-accent/20 px-0.5 text-accent">
        {text.slice(at, at + q.length)}
      </span>
      {text.slice(at + q.length)}
    </>
  );
}

// Split "path:line" → { dir, base } so the filename leads and folders dim.
function splitPath(p: string): { dir: string; base: string } {
  const segs = p.split("/");
  const base = segs.pop() ?? p;
  return { dir: segs.join("/"), base };
}

export function PaletteResultRow({
  entry,
  query,
  active,
  onHover,
  onPick,
}: {
  entry: PaletteEntry;
  query: string;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const shell = (children: React.ReactNode) => (
    <Row active={active} onHover={onHover} onPick={onPick}>
      {children}
    </Row>
  );

  switch (entry.kind) {
    case "action":
      return shell(
        <>
          <Lead active={active}>
            <Zap />
          </Lead>
          <span className="truncate text-base font-medium">{entry.label}</span>
          {entry.hint && (
            <span className="ml-auto shrink-0 text-xs text-text-4">
              {looksLikeAccelerator(entry.hint) ? (
                <Kbd>{entry.hint}</Kbd>
              ) : (
                entry.hint
              )}
            </span>
          )}
        </>,
      );

    case "slash":
      return shell(
        <>
          <Lead active={active}>
            <span className="font-mono text-md leading-none">/</span>
          </Lead>
          <span className="truncate font-mono text-base text-text-1">
            {entry.label}
          </span>
          {entry.hint && (
            <span className="ml-auto truncate text-sm text-text-4" style={{ maxWidth: 320 }}>
              {entry.hint}
            </span>
          )}
        </>,
      );

    case "extCommand":
      return shell(
        <>
          <Lead active={active}>
            <Puzzle />
          </Lead>
          <span className="truncate text-base">{entry.label}</span>
          {entry.hint && (
            <span className="ml-auto shrink-0 rounded-full bg-bg-2 px-2 py-0.5 text-xs text-text-3">
              {entry.hint}
            </span>
          )}
        </>,
      );

    case "file": {
      const rel = entry.hint ?? entry.label;
      const { dir, base } = splitPath(rel);
      return shell(
        <>
          <Lead active={active}>
            <FileText />
          </Lead>
          <span className="truncate text-base text-text-1">{base}</span>
          {dir && (
            <span className="ml-auto truncate text-xs text-text-4" style={{ maxWidth: 320 }}>
              {dir}
            </span>
          )}
        </>,
      );
    }

    case "symbol": {
      const loc = entry.hint?.split("·").pop()?.trim() ?? "";
      return shell(
        <>
          <Lead active={active}>
            <SymbolGlyph kind={entry.symbolKind} />
          </Lead>
          <span className="truncate font-mono text-base text-text-1">
            {entry.label}
          </span>
          <span className="meta-tag">
            {entry.symbolKind}
          </span>
          {loc && (
            <span className="ml-auto truncate text-xs text-text-4" style={{ maxWidth: 260 }}>
              {loc}
            </span>
          )}
        </>,
      );
    }

    case "match": {
      const where = entry.hint ?? `${entry.path}:${entry.line}`;
      return shell(
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-xs text-text-4">{where}</span>
          <span className="truncate font-mono text-sm text-text-2">
            <Highlighted text={entry.label} query={query} />
          </span>
        </div>,
      );
    }

    case "intent":
      return shell(
        <>
          <Lead active={active}>
            <History />
          </Lead>
          <span className="truncate text-base text-text-1">
            <Highlighted text={entry.label} query={query} />
          </span>
          {entry.hint && (
            <span className="ml-auto shrink-0 truncate text-xs text-text-4" style={{ maxWidth: 220 }}>
              {entry.hint}
            </span>
          )}
        </>,
      );

    case "workspace":
      return shell(
        <>
          <Lead active={active}>
            <FolderGit2 />
          </Lead>
          <span className="truncate text-base text-text-1">
            <Highlighted text={entry.label} query={query} />
          </span>
          {entry.hint && (
            <span className="ml-auto shrink-0 text-xs text-text-4">
              {entry.hint}
            </span>
          )}
        </>,
      );

    case "chat":
      return shell(
        <>
          <Lead active={active}>
            <MessageSquareText />
          </Lead>
          <span className="truncate text-base text-text-1">
            <Highlighted text={entry.label} query={query} />
          </span>
          {entry.hint && (
            <span className="ml-auto shrink-0 truncate text-xs text-text-4" style={{ maxWidth: 240 }}>
              {entry.hint}
            </span>
          )}
        </>,
      );

    case "agent":
      return shell(
        <>
          <span className="grid h-6 w-6 shrink-0 place-items-center">
            <AgentIcon agentId={entry.id} size={16} />
          </span>
          <span className="truncate text-base text-text-1">{entry.label}</span>
          {entry.hint && (
            <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-text-4">
              {entry.prompt ? <CornerDownLeft size={11} /> : null}
              <span className="truncate" style={{ maxWidth: 260 }}>
                {entry.hint}
              </span>
            </span>
          )}
        </>,
      );

    default:
      return null;
  }
}
