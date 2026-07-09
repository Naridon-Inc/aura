// PageDocSide — right-aside companion for the Pages detail surface.
//
// A calm icon rail on the right edge (Outline, Children, Backlinks,
// Info). In collapsed mode only the 40px icon rail is visible; clicking
// a tab expands the pane to 300px and lights the active icon with an
// accent bar. Re-clicking the active tab collapses it again.
//
// Panes:
//   - Outline    — h1/h2/h3 anchors parsed live from the markdown body
//   - Children   — pages whose parent_id === activeKey (localStorage
//                  parent map until backend ships the field)
//   - Backlinks  — pages that wikilink to the current title
//   - Info       — created/updated/author/scope/word count metadata
//
// The aside owns no editor state — body/title/backlinks/etc come in as
// props so the parent (NotesWorkpane) stays the single source of truth.

import { useEffect, useMemo, useState } from "react";
import {
  FileText,
  Plus,
  List,
  FolderTree,
  Link2,
  Info as InfoIcon,
  type LucideIcon,
} from "lucide-react";
import type { Note, NoteSummary } from "../../lib/api";
import { cn } from "../../lib/utils";

const PARENT_MAP_KEY = "aura.pages.tree.parents";
const COLLAPSED_KEY = "aura.pages.docside.collapsed";

type SideTab = "outline" | "children" | "backlinks" | "info";

type Props = {
  /** The note key (`scope|bucket|id`) currently in focus. Used to look
   *  up children in the localStorage parent map. */
  activeKey: string | null;
  activeNote: Note | null;
  /** Live markdown body — outline anchors + word count derive from it. */
  body: string;
  /** Live title — info pane echoes it; outline falls back to it if the
   *  body has no headings. */
  title: string;
  /** All summaries in scope, used to resolve children rows by key. */
  summaries: NoteSummary[];
  /** Backlinks computed by the parent (`api.notesBacklinks(title)`). */
  backlinks: NoteSummary[];
  /** Click a summary row — usually relays through the parent's
   *  `setActiveKey(keyFor(s))`. */
  onPick: (s: NoteSummary) => void;
};

function keyOf(s: NoteSummary): string {
  return `${s.scope}|${s.bucket}|${s.id}`;
}

function readParentMap(): Record<string, string | null> {
  try {
    const raw = localStorage.getItem(PARENT_MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return {};
  } catch {
    return {};
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeCollapsed(v: boolean) {
  try {
    localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

type Heading = { level: number; text: string; slug: string };

function parseHeadings(body: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (m) {
      const text = m[2].trim();
      const slug = text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-");
      out.push({ level: m[1].length, text, slug });
    }
  }
  return out;
}

function countWords(body: string): number {
  const cleaned = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/[#*_>~\-]/g, " ")
    .replace(/\[\[[^\]]+\]\]/g, " ");
  return cleaned.split(/\s+/).filter(Boolean).length;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PageDocSide({
  activeKey,
  activeNote,
  body,
  title,
  summaries,
  backlinks,
  onPick,
}: Props) {
  const [tab, setTab] = useState<SideTab>("outline");
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed());

  useEffect(() => {
    writeCollapsed(collapsed);
  }, [collapsed]);

  const headings = useMemo(() => parseHeadings(body), [body]);

  const children = useMemo(() => {
    if (!activeKey) return [] as NoteSummary[];
    const map = readParentMap();
    return summaries.filter((s) => map[keyOf(s)] === activeKey);
  }, [activeKey, summaries]);

  const words = useMemo(() => countWords(body), [body]);

  function handleTabClick(next: SideTab) {
    if (collapsed) {
      setCollapsed(false);
      setTab(next);
    } else if (next === tab) {
      // Click the active tab again to collapse — feels natural and
      // matches how most IDE side panels behave.
      setCollapsed(true);
    } else {
      setTab(next);
    }
  }

  const width = collapsed ? "w-10" : "w-[300px]";

  return (
    <aside
      className={cn(
        "flex-shrink-0 h-full border-l border-line-soft bg-bg-content transition-[width] duration-150 ease-out flex",
        width,
      )}
    >
      {/* Icon rail — always visible. Calm icon buttons replace the old
          rotated-text tabs; clicking a tab expands the pane (or collapses
          it again when the active tab is re-clicked). */}
      <div className="w-10 flex-shrink-0 flex flex-col items-stretch gap-0.5 py-1.5 border-r border-line-soft">
        <SideTabButton
          icon={List}
          label="Outline"
          active={!collapsed && tab === "outline"}
          onClick={() => handleTabClick("outline")}
        />
        <SideTabButton
          icon={FolderTree}
          label="Children"
          active={!collapsed && tab === "children"}
          onClick={() => handleTabClick("children")}
        />
        <SideTabButton
          icon={Link2}
          label="Backlinks"
          active={!collapsed && tab === "backlinks"}
          onClick={() => handleTabClick("backlinks")}
        />
        <SideTabButton
          icon={InfoIcon}
          label="Info"
          active={!collapsed && tab === "info"}
          onClick={() => handleTabClick("info")}
        />
      </div>

      {!collapsed && (
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {tab === "outline" && (
            <OutlinePane headings={headings} fallbackTitle={title} />
          )}
          {tab === "children" && (
            <ChildrenPane children={children} onPick={onPick} />
          )}
          {tab === "backlinks" && (
            <BacklinksPane links={backlinks} onPick={onPick} />
          )}
          {tab === "info" && (
            <InfoPane note={activeNote} title={title} words={words} />
          )}
        </div>
      )}
    </aside>
  );
}

function SideTabButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "relative mx-1 h-8 rounded-md grid place-items-center transition-colors",
        active
          ? "text-text-1 bg-bg-2"
          : "text-text-5 hover:text-text-2 hover:bg-bg-2/60",
      )}
    >
      {active && (
        <span
          className="absolute -left-1 inset-y-1.5 w-0.5 rounded-full bg-accent"
          aria-hidden
        />
      )}
      <Icon className="w-[15px] h-[15px]" strokeWidth={1.75} aria-hidden />
    </button>
  );
}

function OutlinePane({
  headings,
  fallbackTitle,
}: {
  headings: Heading[];
  fallbackTitle: string;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="text-[10.5px] uppercase tracking-wider text-text-5 font-medium mb-2">
        Outline
      </div>
      {headings.length === 0 ? (
        <div className="text-[11.5px] text-text-5 leading-relaxed">
          {fallbackTitle
            ? "Add headings (## / ###) to see the outline here."
            : "Type a title to start an outline."}
        </div>
      ) : (
        <ul className="space-y-0.5">
          {headings.map((h, i) => (
            <li key={`${i}:${h.slug}`}>
              <a
                href={`#${h.slug}`}
                className="block text-[12px] text-text-3 hover:text-text-1 truncate py-0.5"
                style={{ paddingLeft: (h.level - 1) * 10 }}
                title={h.text}
              >
                {h.text}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChildrenPane({
  children,
  onPick,
}: {
  children: NoteSummary[];
  onPick: (s: NoteSummary) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="text-[10.5px] uppercase tracking-wider text-text-5 font-medium mb-2">
        Children ({children.length})
      </div>
      {children.length === 0 ? (
        <div className="text-[11.5px] text-text-5 leading-relaxed">
          Drag pages onto this one in the left sidebar to nest them
          here.
        </div>
      ) : (
        <ul className="space-y-0.5">
          {children.map((c) => (
            <li key={keyOf(c)}>
              <button
                type="button"
                onClick={() => onPick(c)}
                className="w-full flex items-center gap-2 px-2 py-1 rounded text-[12px] text-text-2 hover:bg-bg-2 hover:text-text-1 text-left"
              >
                <FileText
                  className="w-3 h-3 text-text-5 flex-shrink-0"
                  strokeWidth={1.5}
                  aria-hidden
                />
                <span className="truncate">{c.title || "(untitled)"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled
        title="Use the +New page button in the sidebar"
        className="mt-2 w-full flex items-center gap-2 px-2 py-1 rounded text-[11.5px] text-text-5 hover:bg-bg-2"
      >
        <Plus className="w-3 h-3" strokeWidth={1.5} aria-hidden />
        Add a page
      </button>
    </div>
  );
}

function BacklinksPane({
  links,
  onPick,
}: {
  links: NoteSummary[];
  onPick: (s: NoteSummary) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="text-[10.5px] uppercase tracking-wider text-text-5 font-medium mb-2">
        Backlinks ({links.length})
      </div>
      {links.length === 0 ? (
        <div className="text-[11.5px] text-text-5 leading-relaxed">
          No pages link to this one yet. Use{" "}
          <span className="font-mono text-text-3">[[title]]</span> to link.
        </div>
      ) : (
        <ul className="space-y-0.5">
          {links.map((s) => (
            <li key={keyOf(s)}>
              <button
                type="button"
                onClick={() => onPick(s)}
                className="w-full flex items-center gap-2 px-2 py-1 rounded text-[12px] text-text-2 hover:bg-bg-2 hover:text-text-1 text-left"
              >
                <FileText
                  className="w-3 h-3 text-text-5 flex-shrink-0"
                  strokeWidth={1.5}
                  aria-hidden
                />
                <span className="truncate">{s.title || "(untitled)"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InfoPane({
  note,
  title,
  words,
}: {
  note: Note | null;
  title: string;
  words: number;
}) {
  const scopeText = note
    ? note.scope === "team"
      ? "Team"
      : note.scope === "channel"
        ? `#${note.bucket}`
        : `@${note.bucket}`
    : "—";
  const author = note?.frontmatter.author ?? "—";
  const created = formatDate(note?.frontmatter.created_at);
  const updated = formatDate(note?.frontmatter.updated_at);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
      <div className="text-[10.5px] uppercase tracking-wider text-text-5 font-medium">
        Info
      </div>
      <InfoRow label="Title" value={title || "Untitled"} />
      <InfoRow label="Scope" value={scopeText} />
      <InfoRow label="Author" value={author} />
      <InfoRow label="Created" value={created} />
      <InfoRow label="Last edit" value={updated} />
      <InfoRow
        label="Word count"
        value={`${words.toLocaleString()} word${words === 1 ? "" : "s"}`}
      />
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10.5px] text-text-5 uppercase tracking-wider mb-0.5">
        {label}
      </div>
      <div className="text-[12px] text-text-2 break-words">{value}</div>
    </div>
  );
}
