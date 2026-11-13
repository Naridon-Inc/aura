// Per-kind result rows for the ⌘K palette.
//
// Each result kind carries different information, so each gets its own row
// content inside the shared command item:
//
//   • Action          — icon · what it does · keyboard shortcut
//   • Command (slash)  — /name in mono · one-line description
//   • File             — file glyph · filename · dimmed folder path
//   • Definition       — kind glyph (ƒ / {} / =) · name · kind · where it lives
//   • In your code     — the matching line, match highlighted · file:line under it
//   • Agent            — agent logo · name · "→ prompt" preview / focus hint
//
// Selection, hover, Enter and scrolling the selected row into view all come
// from the shared command list; only the content differs per kind.

import {
  Braces,
  CornerDownLeft,
  Equal,
  FileText,
  FunctionSquare,
  Hash,
  History,
  MessageSquareText,
  TextSearch,
  Zap,
} from "lucide-react";

import type { PaletteEntry } from "../CommandPalette";
import { ProjectAvatar } from "../ProjectAvatar";
import { AgentIcon } from "../agent/AgentIcon";
import { Badge } from "../ui/badge";
import { CommandItem, CommandShortcut } from "../ui/command";

// Accelerator hints ("⌘K", "⌘⇧I") render as the item's shortcut; descriptions
// stay text.
function looksLikeAccelerator(s: string): boolean {
  return /^[⌘⌃⌥⇧]+/.test(s.trim());
}

/** The command-list value of one row. Unique per row, so the list's selection
 *  and the palette's Tab handling address the same thing. */
export function paletteKey(entry: PaletteEntry): string {
  return `${entry.kind}:${entry.id}`;
}

function Detail({ children }: { children: React.ReactNode }) {
  return <span className="ui-command-palette-detail">{children}</span>;
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
export function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const at = lower.indexOf(ql);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="ui-command-palette-hit">{text.slice(at, at + q.length)}</mark>
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
  onPick,
}: {
  entry: PaletteEntry;
  query: string;
  onPick: () => void;
}) {
  const content = rowContent(entry, query);
  if (!content) return null;
  return (
    <CommandItem value={paletteKey(entry)} onSelect={onPick}>
      {content}
    </CommandItem>
  );
}

function Label({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <span className={mono ? "ui-command-palette-label ui-command-palette-mono" : "ui-command-palette-label"}>
      {children}
    </span>
  );
}

function rowContent(entry: PaletteEntry, query: string): React.ReactNode {
  switch (entry.kind) {
    case "action":
      return (
        <>
          <Zap />
          <Label>{entry.label}</Label>
          {entry.hint &&
            (looksLikeAccelerator(entry.hint) ? (
              <CommandShortcut>{entry.hint}</CommandShortcut>
            ) : (
              <Detail>{entry.hint}</Detail>
            ))}
        </>
      );

    case "slash":
      return (
        <>
          <span className="ui-command-palette-glyph" aria-hidden>
            /
          </span>
          <Label mono>{entry.label}</Label>
          {entry.hint && <Detail>{entry.hint}</Detail>}
        </>
      );

    case "file": {
      const rel = entry.hint ?? entry.label;
      const { dir, base } = splitPath(rel);
      return (
        <>
          <FileText />
          <Label>{base}</Label>
          {dir && <Detail>{dir}</Detail>}
        </>
      );
    }

    case "symbol": {
      const loc = entry.hint?.split("·").pop()?.trim() ?? "";
      return (
        <>
          <SymbolGlyph kind={entry.symbolKind} />
          <Label mono>{entry.label}</Label>
          <Badge variant="secondary">{entry.symbolKind}</Badge>
          {loc && <Detail>{loc}</Detail>}
        </>
      );
    }

    case "match": {
      const where = entry.hint ?? `${entry.path}:${entry.line}`;
      return (
        <>
          <TextSearch />
          <span className="ui-command-palette-label ui-command-palette-mono">
            <Highlighted text={entry.label} query={query} />
            <small>{where}</small>
          </span>
        </>
      );
    }

    case "intent":
      return (
        <>
          <History />
          <Label>
            <Highlighted text={entry.label} query={query} />
          </Label>
          {entry.hint && <Detail>{entry.hint}</Detail>}
        </>
      );

    case "workspace":
      return (
        <>
          <ProjectAvatar root={entry.root} name={entry.label} />
          <Label>
            <Highlighted text={entry.label} query={query} />
          </Label>
          {entry.hint && <Detail>{entry.hint}</Detail>}
        </>
      );

    case "chat":
      return (
        <>
          <MessageSquareText />
          <Label>
            <Highlighted text={entry.label} query={query} />
          </Label>
          {entry.hint && <Detail>{entry.hint}</Detail>}
        </>
      );

    case "agent":
      return (
        <>
          <AgentIcon agentId={entry.id} size={16} />
          <Label>{entry.label}</Label>
          {entry.hint && (
            <Detail>
              {entry.prompt ? <CornerDownLeft size={11} /> : null}
              {entry.hint}
            </Detail>
          )}
        </>
      );

    default:
      return null;
  }
}
