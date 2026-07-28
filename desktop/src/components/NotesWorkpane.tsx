// Pages workpane. Plane-style list (RR.8) + Tiptap editor (RR.7).
//
// Structure:
//   • List mode (no active page) — header with "Pages", search, +New page;
//     visibility tabs (Public / Private / Archived); flat list of rows with
//     icon + title + actor avatar + updated time + kebab. Mirrors
//     `docs/plane-app-examples.html` § Pages list (lines 5075–5134).
//   • Detail mode (active page) — page-doc-layout: main column with
//     sticky toolbar / canvas-bar / body, plus the PageDocSide right
//     aside (Outline / Children / Backlinks / Info).
//
// Backend (notes_* commands) is unchanged: storage stays sliced by
// scope (team / channel:<name> / member:<handle>). The old TEAM /
// CHANNELS / PEOPLE sidebar tree is gone — every page now appears in
// the flat list with a scope chip. Channel/member affiliation
// survives as metadata, not as IA.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  ArrowLeft,
  FileText,
  Lock,
  MoreHorizontal,
  Plus,
  Search,
} from "lucide-react";
import type { Editor as TiptapEditorInstance } from "@tiptap/react";
import { AsciiSpinner } from "./ui/ascii-spinner";
import { MonacoEditor as Editor } from "./MonacoEditor";
import { TiptapEditor } from "./notes/TiptapEditor";
import {
  createPagesProvider,
  hashHandleToColor,
  type PagesProvider,
} from "../lib/pages_collab";
import { PageActionBar } from "./pages/PageActionBar";
import { PageCover } from "./pages/PageCover";
import { PageDocSide } from "./pages/PageDocSide";
import { PageIcon } from "./pages/PageIcon";
import { PageShareDialog } from "./pages/PageShareDialog";
import { Button } from "./ui/button";
import { ListSkeleton } from "./ui/skeleton";
import { peekCache, writeCache } from "../lib/resourceCache";
import { colorForName, tintForName } from "../lib/identityColors";
import { cn } from "../lib/utils";
import { TiptapToolbarPill } from "./editor/TiptapToolbarPill";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  api,
  type Note,
  type NoteScope,
  type NoteSummary,
  type NoteSearchHit,
  type TeamManifest,
  type TeamIdentity,
} from "../lib/api";

// The composite Pages caches under `pages:${repoRoot}` so reopening
// paints instantly (resourceCache) instead of refetching every open.
type PagesBundle = {
  summaries: NoteSummary[];
  team: TeamManifest | null;
  identity: TeamIdentity | null;
};

type Props = {
  repoRoot: string;
  /** Modal-overlay mode. `open` gates render + Esc handler + the
   *  header × button. When `embedded` is true, `open` is ignored and
   *  the surface always renders inline (workpane tab path). */
  open?: boolean;
  onClose?: () => void;
  /** Workpane mode — render as a normal fill-parent surface (no z-40,
   *  no `absolute inset-0`, no × close button). The tab strip carries
   *  the close affordance. */
  embedded?: boolean;
};

// KK.2 — Inline remark plugin: rewrite `[[Title]]` text occurrences into
// link nodes with an `aura-wiki:` URL scheme. The ReactMarkdown `a`
// component override below detects that scheme and renders a clickable
// chip that navigates via the parent's `openByTitle` helper.
type MdAstNode = {
  type: string;
  value?: string;
  children?: MdAstNode[];
};

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

function remarkWikilinks() {
  return (tree: MdAstNode) => {
    function walk(node: MdAstNode) {
      if (!node.children) return;
      const next: MdAstNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || typeof child.value !== "string") {
          walk(child);
          next.push(child);
          continue;
        }
        const value = child.value;
        WIKILINK_RE.lastIndex = 0;
        let last = 0;
        let m: RegExpExecArray | null;
        let consumed = false;
        while ((m = WIKILINK_RE.exec(value)) !== null) {
          if (m.index > last) {
            next.push({ type: "text", value: value.slice(last, m.index) });
          }
          const target = m[1].trim();
          next.push({
            type: "link",
            url: `aura-wiki:${target}`,
            title: `Wiki link: ${target}`,
            children: [{ type: "text", value: target }],
          } as MdAstNode);
          last = m.index + m[0].length;
          consumed = true;
        }
        if (consumed) {
          if (last < value.length) {
            next.push({ type: "text", value: value.slice(last) });
          }
        } else {
          next.push(child);
        }
      }
      node.children = next;
    }
    walk(tree);
  };
}

type ViewMode = "blocks" | "source" | "preview";
type VisibilityTab = "public" | "private" | "archived";

export type NoteTemplate =
  | "blank"
  | "decision-log"
  | "rfc"
  | "design-doc"
  | "standup"
  | "postmortem";

type TemplateDef = {
  id: NoteTemplate;
  label: string;
  description: string;
};

const TEMPLATES: TemplateDef[] = [
  { id: "blank", label: "Blank", description: "Empty markdown note" },
  {
    id: "decision-log",
    label: "Decision Log",
    description: "Running table of decisions + context",
  },
  {
    id: "rfc",
    label: "RFC",
    description: "Status, motivation, design, alternatives",
  },
  {
    id: "design-doc",
    label: "Design Doc",
    description: "Goals, non-goals, architecture",
  },
  {
    id: "standup",
    label: "Standup notes",
    description: "Yesterday / Today / Blockers",
  },
  {
    id: "postmortem",
    label: "Postmortem",
    description: "Impact, root cause, timeline, action items",
  },
];

const VIEW_KEY = "aura.notes.view";
const TAB_KEY = "aura.notes.visibility";
const SAVE_DEBOUNCE_MS = 700;

export function NotesWorkpane({
  repoRoot,
  open = true,
  onClose,
  embedded = false,
}: Props) {
  const isOpen = embedded ? true : open;
  const [summaries, setSummaries] = useState<NoteSummary[]>([]);
  const [team, setTeam] = useState<TeamManifest | null>(null);
  const [identity, setIdentity] = useState<TeamIdentity | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [view, setView] = useState<ViewMode>(() => {
    try {
      const raw = localStorage.getItem(VIEW_KEY) as ViewMode | null;
      if (raw === "blocks" || raw === "source" || raw === "preview") return raw;
      return "blocks";
    } catch {
      return "blocks";
    }
  });
  const [tab, setTab] = useState<VisibilityTab>(() => {
    try {
      const raw = localStorage.getItem(TAB_KEY) as VisibilityTab | null;
      if (raw === "public" || raw === "private" || raw === "archived") return raw;
      return "public";
    } catch {
      return "public";
    }
  });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* ignore */
    }
  }, [view]);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* ignore */
    }
  }, [tab]);

  const refresh = useCallback(async () => {
    if (!repoRoot) return;
    const key = `pages:${repoRoot}`;
    // Cold load → skeleton; warm revalidate keeps the seeded list shown.
    if (!peekCache<PagesBundle>(key)) setLoading(true);
    setError(null);
    try {
      const [rows, t, ident] = await Promise.all([
        api.notesList({ repoRoot }),
        api.teamLoad(repoRoot).catch(() => null),
        api.teamIdentity(repoRoot).catch(() => null),
      ]);
      writeCache<PagesBundle>(key, { summaries: rows, team: t, identity: ident });
      setSummaries(rows);
      setTeam(t);
      setIdentity(ident);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    if (!isOpen || !repoRoot) return;
    // Warm open: paint the last load instantly, then revalidate so
    // reopening Pages never flashes empty or a skeleton.
    const cached = peekCache<PagesBundle>(`pages:${repoRoot}`);
    if (cached) {
      setSummaries(cached.summaries);
      setTeam(cached.team);
      setIdentity(cached.identity);
    }
    refresh();
  }, [isOpen, refresh, repoRoot]);

  // #219 — live-sync poll. Pull shared-page mutations teammates published on
  // the chat rail and LWW-merge them locally; refetch the list only when
  // something actually changed. Mirrors the Tasks board's 6s cadence. No-op
  // for solo repos (the backend gates on team-has-peers and returns idle).
  useEffect(() => {
    if (!isOpen || !repoRoot) return;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await api.pagesSyncPoll(repoRoot);
        if (res.changed) await refresh();
      } catch {
        /* transient rail/network error — next tick retries */
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(poll, 6000);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    void poll();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [isOpen, repoRoot, refresh]);

  // External sidebar coupling (Fix 1) — the app-level <PagesSidebar>
  // that mounts in App.tsx talks to us through window events instead
  // of a shared store, since editorStore has no pages state slice.
  //   • `aura:pages:open`   { key }   — set activeKey (open a page)
  //   • `aura:pages:close`             — clear activeKey (back to list)
  //   • `aura:pages:refresh`           — re-pull summaries (e.g. after
  //                                       the sidebar creates a page)
  // We also dispatch `aura:pages:summaries` whenever our `summaries`
  // state changes so the external sidebar can mirror the same list
  // without doing its own polling.
  useEffect(() => {
    if (!isOpen) return;
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<{ key?: string | null }>).detail;
      if (!detail || !detail.key) return;
      setActiveKey(detail.key);
    }
    function onClose() {
      setActiveKey(null);
    }
    function onRefresh() {
      refresh();
    }
    window.addEventListener("aura:pages:open", onOpen as EventListener);
    window.addEventListener("aura:pages:close", onClose);
    window.addEventListener("aura:pages:refresh", onRefresh);
    return () => {
      window.removeEventListener("aura:pages:open", onOpen as EventListener);
      window.removeEventListener("aura:pages:close", onClose);
      window.removeEventListener("aura:pages:refresh", onRefresh);
    };
  }, [isOpen, refresh]);

  // Mirror summaries to the sidebar (Fix 1) so the external rail
  // doesn't have to issue its own `api.notesList` poll. The detail
  // (activeKey) is also broadcast so the sidebar can highlight the
  // current row.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("aura:pages:summaries", {
        detail: { summaries, activeKey },
      }),
    );
  }, [summaries, activeKey]);

  // Esc closes — modal mode only.
  useEffect(() => {
    if (!isOpen || embedded || !onClose) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose!();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, embedded, onClose]);

  // Load full note when active key changes.
  useEffect(() => {
    if (!activeKey) {
      setActiveNote(null);
      setBody("");
      setTitle("");
      return;
    }
    const { scope, bucket, id } = parseKey(activeKey);
    let cancelled = false;
    api
      .notesRead(repoRoot, scope, bucket, id)
      .then((n) => {
        if (cancelled) return;
        setActiveNote(n);
        setBody(n.body);
        setTitle(n.frontmatter.title ?? "");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [activeKey, repoRoot]);

  // Debounced save on body/title change.
  useEffect(() => {
    if (!activeNote) return;
    if (
      body === activeNote.body &&
      title === (activeNote.frontmatter.title ?? "")
    ) {
      return;
    }
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      setSaving(true);
      try {
        const updated = await api.notesWrite({
          repoRoot,
          scope: activeNote.scope,
          bucket: activeNote.bucket,
          id: activeNote.id,
          body,
          title: title || undefined,
          author: identity?.handle ?? undefined,
        });
        setActiveNote(updated);
        setSummaries((prev) =>
          prev.map((s) =>
            keyFor(s) === activeKey
              ? {
                  ...s,
                  title: updated.frontmatter.title ?? s.title,
                  updated_at:
                    updated.frontmatter.updated_at ?? s.updated_at,
                }
              : s,
          ),
        );
      } catch (e) {
        setError(String(e));
      } finally {
        setSaving(false);
      }
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [body, title, activeNote, activeKey, identity, repoRoot]);

  const createPage = useCallback(
    async (scope: NoteScope, bucket: string, template: NoteTemplate) => {
      try {
        const scopeLabelText =
          scope === "team"
            ? "Team note"
            : scope === "channel"
              ? `#${bucket}`
              : `@${bucket}`;
        const seed = buildTemplateSeed(
          template,
          scopeLabelText,
          identity?.handle ?? null,
        );
        const note = await api.notesWrite({
          repoRoot,
          scope,
          bucket,
          body: seed.body,
          title: seed.title,
          author: identity?.handle ?? undefined,
          visibility: scope === "member" ? "private" : "shared",
        });
        await refresh();
        setActiveKey(keyFor({ scope, bucket, id: note.id }));
      } catch (e) {
        setError(String(e));
      }
    },
    [identity, refresh, repoRoot],
  );

  async function deleteNote() {
    if (!activeNote) return;
    if (!confirm(`Delete "${activeNote.frontmatter.title ?? activeNote.id}"?`)) {
      return;
    }
    try {
      await api.notesDelete(
        repoRoot,
        activeNote.scope,
        activeNote.bucket,
        activeNote.id,
      );
      setActiveKey(null);
      setActiveNote(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  // Lock / Publish toggles. Both are frontmatter mutations: we re-write the
  // note carrying the CURRENT body + title (a meta-only write would blank the
  // file) plus the changed flag. The Rust merge leaves untouched fields alone,
  // so `locked`/`visibility` flip without disturbing anything else. We refresh
  // activeNote (so the editor re-derives read-only) and the summary row (so the
  // Public/Private list tab follows a publish change).
  async function mutateMeta(patch: { locked?: boolean; visibility?: string }) {
    if (!activeNote) return;
    try {
      const updated = await api.notesWrite({
        repoRoot,
        scope: activeNote.scope,
        bucket: activeNote.bucket,
        id: activeNote.id,
        body,
        title: title || undefined,
        author: identity?.handle ?? undefined,
        locked: patch.locked,
        visibility: patch.visibility,
      });
      setActiveNote(updated);
      setSummaries((prev) =>
        prev.map((s) =>
          keyFor(s) === activeKey
            ? {
                ...s,
                title: updated.frontmatter.title ?? s.title,
                updated_at: updated.frontmatter.updated_at ?? s.updated_at,
                visibility: updated.frontmatter.visibility ?? s.visibility,
              }
            : s,
        ),
      );
    } catch (e) {
      setError(String(e));
    }
  }

  // KK.2 — title→summary map powers [[wikilink]] resolution.
  const summariesByTitle = useMemo(() => {
    const map = new Map<string, NoteSummary>();
    for (const s of summaries) map.set(s.title.toLowerCase(), s);
    return map;
  }, [summaries]);

  function openByTitle(rawTitle: string): boolean {
    const target = rawTitle.trim().toLowerCase();
    const hit = summariesByTitle.get(target);
    if (!hit) return false;
    setActiveKey(keyFor(hit));
    return true;
  }

  // Visibility classification: team + channel notes are Public; member
  // notes are Private (the on-disk visibility flag in frontmatter can
  // override member → shared, but the default mapping is by scope).
  const counts = useMemo(() => {
    let pub = 0;
    let priv = 0;
    for (const s of summaries) {
      if (s.scope === "member") priv++;
      else pub++;
    }
    return { pub, priv, archived: 0 };
  }, [summaries]);

  const visiblePages = useMemo(() => {
    const filtered = summaries.filter((s) => {
      const isPrivate = s.scope === "member";
      if (tab === "public" && isPrivate) return false;
      if (tab === "private" && !isPrivate) return false;
      if (tab === "archived") return false; // not modeled yet
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        const t = (s.title || "").toLowerCase();
        const b = (s.bucket || "").toLowerCase();
        if (!t.includes(q) && !b.includes(q)) return false;
      }
      return true;
    });
    return filtered.sort((a, b) =>
      (b.updated_at || "").localeCompare(a.updated_at || ""),
    );
  }, [summaries, tab, query]);

  // KK.2 — backlinks panel state.
  const [backlinks, setBacklinks] = useState<NoteSummary[]>([]);
  const activeTitle = activeNote?.frontmatter.title ?? title;
  useEffect(() => {
    if (!activeNote || !activeTitle) {
      setBacklinks([]);
      return;
    }
    let cancelled = false;
    api
      .notesBacklinks(repoRoot, activeTitle)
      .then((rows) => {
        if (!cancelled) setBacklinks(rows);
      })
      .catch(() => {
        if (!cancelled) setBacklinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeNote?.id, activeTitle, repoRoot]);

  // KK.2 — Cmd+Shift+F search overlay.
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "f" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSearchOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [isOpen]);

  if (!isOpen) return null;

  const inDetail = activeKey != null;

  return (
    <div
      className={
        embedded
          ? "h-full w-full bg-bg-content flex flex-col"
          : "absolute inset-0 z-40 bg-bg-content flex flex-col"
      }
    >
      {error && (
        <div className="px-4 py-2 text-[11.5px] text-red bg-red/10 border-b border-line-soft">
          {error}
        </div>
      )}

      {inDetail ? (
        // Fix 2 — page-doc-layout. Flex row with the main column on
        // the left (toolbar / canvas-bar / body) and the collapsible
        // PageDocSide aside on the right (Outline / Children /
        // Backlinks / Info). The internal PagesSidebar is gone —
        // navigation lives in the app-level rail now (Fix 1).
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 flex flex-col">
            <PageDetail
              repoRoot={repoRoot}
              activeNote={activeNote}
              title={title}
              body={body}
              view={view}
              saving={saving}
              identity={identity}
              summariesByTitle={summariesByTitle}
              onBack={() => setActiveKey(null)}
              onTitle={setTitle}
              onBody={setBody}
              onView={setView}
              onDelete={deleteNote}
              onMutateMeta={mutateMeta}
              onOpenByTitle={openByTitle}
              onCreateBlank={async (target) => {
                try {
                  const n = await api.notesWrite({
                    repoRoot,
                    scope: "team",
                    bucket: "",
                    body: `# ${target}\n\n`,
                    title: target,
                    author: identity?.handle ?? undefined,
                    visibility: "shared",
                  });
                  await refresh();
                  setActiveKey(keyFor({ scope: "team", bucket: "", id: n.id }));
                } catch (e) {
                  setError(String(e));
                }
              }}
              embedded={embedded}
              onClose={onClose}
            />
          </div>
          <PageDocSide
            activeKey={activeKey}
            activeNote={activeNote}
            body={body}
            title={title}
            summaries={summaries}
            backlinks={backlinks}
            onPick={(s) => setActiveKey(keyFor(s))}
          />
        </div>
      ) : (
        <PagesList
          repoRoot={repoRoot}
          pages={visiblePages}
          loading={loading}
          tab={tab}
          counts={counts}
          query={query}
          team={team}
          identity={identity}
          onTab={setTab}
          onQuery={setQuery}
          onPick={(s) => {
            setActiveKey(keyFor(s));
            // SS.2 — mirror PR/task detail open events so App.tsx can
            // auto-collapse the sidebar on narrow viewports (pages live
            // inside the Pages workpane, so they don't hit editorStore's
            // openX path that already fires this event).
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("aura:detail-tab-opened"));
            }
          }}
          onCreate={createPage}
          onOpenSearch={() => setSearchOpen(true)}
          embedded={embedded}
          onClose={onClose}
        />
      )}

      {searchOpen && (
        <NotesSearchDialog
          repoRoot={repoRoot}
          onClose={() => setSearchOpen(false)}
          onPick={(s) => {
            setActiveKey(keyFor(s));
            setSearchOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ─── Pages list (RR.8 — Plane Pages parity) ─────────────────────────────

function PagesList({
  repoRoot,
  pages,
  loading,
  tab,
  counts,
  query,
  team,
  identity,
  onTab,
  onQuery,
  onPick,
  onCreate,
  onOpenSearch,
  embedded,
  onClose,
}: {
  repoRoot: string;
  pages: NoteSummary[];
  loading: boolean;
  tab: VisibilityTab;
  counts: { pub: number; priv: number; archived: number };
  query: string;
  team: TeamManifest | null;
  identity: TeamIdentity | null;
  onTab: (t: VisibilityTab) => void;
  onQuery: (s: string) => void;
  onPick: (s: NoteSummary) => void;
  onCreate: (scope: NoteScope, bucket: string, template: NoteTemplate) => void;
  onOpenSearch: () => void;
  embedded: boolean;
  onClose?: () => void;
}) {
  return (
    <>
      {/* Page head — calm title band; the document set reads as a library,
       *  not a form. A large quiet title with a muted repo subtitle, then
       *  a row of low-emphasis controls (search · full-text · New page). */}
      <div className="px-8 pt-8 pb-4 flex items-start justify-between gap-4 flex-shrink-0">
        <div className="min-w-0">
          <h2 className="text-[20px] font-semibold text-text-1 leading-tight tracking-tight">
            Pages
          </h2>
          <div className="text-[12px] text-text-4 mt-1 truncate">
            {shortRepo(repoRoot)} · documents, RFCs &amp; runbooks
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative">
            <Search
              className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-4 pointer-events-none"
              strokeWidth={1.5}
            />
            <input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search pages…"
              className="w-[220px] h-8 pl-8 pr-2.5 bg-bg-2/40 rounded-md border border-line-soft text-[12px] text-text-1 placeholder:text-text-4 focus:outline-none focus:border-line focus:bg-bg-2/60 transition-colors"
            />
          </div>
          <button
            type="button"
            onClick={onOpenSearch}
            title="Full-text search (⌘⇧F)"
            className="h-8 px-2 text-[11px] text-text-4 hover:text-text-1 rounded-md hover:bg-bg-2 transition-colors"
          >
            ⌘⇧F
          </button>
          <NewPageButton
            team={team}
            identity={identity}
            onCreate={onCreate}
          />
          {!embedded && onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Close (Esc)"
              className="ml-0.5 w-7 h-7 grid place-items-center text-[14px] text-text-4 hover:text-text-1 rounded-md hover:bg-bg-2 transition-colors"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="px-8 flex items-center gap-1 border-b border-line-soft flex-shrink-0">
        <Tab
          label="Public"
          count={counts.pub}
          active={tab === "public"}
          onClick={() => onTab("public")}
        />
        <Tab
          label="Private"
          count={counts.priv}
          active={tab === "private"}
          onClick={() => onTab("private")}
        />
        <Tab
          label="Archived"
          count={counts.archived}
          active={tab === "archived"}
          onClick={() => onTab("archived")}
        />
      </div>

      {/* List — Linear/Notion-style: a quiet uppercase group header, then
       *  spacious rounded rows with a soft hover wash (no per-row rules).
       *  One calm line per page, scannable. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && pages.length === 0 && <ListSkeleton rows={8} />}
        {!loading && pages.length === 0 && (
          <PagesEmptyState
            tab={tab}
            hasQuery={query.trim().length > 0}
            onCreate={() => onCreate("team", "", "blank")}
          />
        )}
        {pages.length > 0 && (
          <div className="pb-6">
            <div className="px-5 pt-5 pb-2 text-[10.5px] uppercase tracking-wider text-text-5 font-medium">
              {TAB_LABEL[tab]}
              <span className="ml-1.5 text-text-5 tabular-nums">
                {pages.length}
              </span>
            </div>
            <div className="space-y-0.5">
              {pages.map((p) => (
                <PageRow
                  key={keyFor(p)}
                  summary={p}
                  onClick={() => onPick(p)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const TAB_LABEL: Record<VisibilityTab, string> = {
  public: "Public",
  private: "Private",
  archived: "Archived",
};

function Tab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative h-9 px-2.5 text-[12.5px] flex items-center gap-1.5 transition-colors ${
        active
          ? "text-text-1 after:absolute after:left-2.5 after:right-2.5 after:bottom-[-1px] after:h-[2px] after:rounded-full after:bg-accent"
          : "text-text-4 hover:text-text-2"
      }`}
    >
      {label}
      <span className="text-[10.5px] text-text-5 tabular-nums">{count}</span>
    </button>
  );
}

function PageRow({
  summary,
  onClick,
}: {
  summary: NoteSummary;
  onClick: () => void;
}) {
  const emoji = pageEmoji(keyFor(summary));
  return (
    <a
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="group mx-2 flex items-center gap-3 h-11 px-3 rounded-md hover:bg-bg-2/50 cursor-pointer transition-colors"
    >
      <span className="grid place-items-center w-5 flex-shrink-0 text-text-4">
        {emoji ? (
          <span className="text-[15px] leading-none" aria-hidden>
            {emoji}
          </span>
        ) : (
          <FileText className="w-[15px] h-[15px]" strokeWidth={1.5} />
        )}
      </span>
      <span className="flex-1 min-w-0 text-[13.5px] text-text-1 truncate">
        {summary.title || "(untitled)"}
      </span>
      <div className="flex items-center gap-2.5 flex-shrink-0">
        <ScopeChip summary={summary} />
        <span className="text-[11.5px] text-text-4 whitespace-nowrap tabular-nums">
          {relAge(summary.updated_at)}
        </span>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="opacity-0 group-hover:opacity-100 text-text-4 hover:text-text-1 w-6 h-6 grid place-items-center rounded-md hover:bg-bg-3 transition-colors"
          title="More"
        >
          <MoreHorizontal className="w-3.5 h-3.5" strokeWidth={1.5} />
        </button>
      </div>
    </a>
  );
}

// Per-page emoji icon for list rows — mirrors the PageIcon storage key
// (`aura.page.icon.<scope|bucket|id>`). Returns null when unset so the
// row falls back to the neutral FileText glyph.
function pageEmoji(pageKey: string): string | null {
  try {
    return localStorage.getItem(`aura.page.icon.${pageKey}`);
  } catch {
    return null;
  }
}

function ScopeChip({ summary }: { summary: NoteSummary }) {
  const label =
    summary.scope === "team"
      ? "team"
      : summary.scope === "channel"
        ? `#${summary.bucket}`
        : `@${summary.bucket}`;
  return (
    <span className="text-[10.5px] text-text-4 px-1.5 py-0.5 rounded bg-bg-2/60 whitespace-nowrap">
      {label}
    </span>
  );
}

function AvatarChip({ handle, size = 16 }: { handle: string; size?: number }) {
  const initials = handle
    .replace(/^@/, "")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  // Deterministic tint from the shared identity hash — the same one the Team
  // avatars use — so one person reads identically on every surface instead of
  // getting a second, unrelated colour wheel here.
  return (
    <span
      className="rounded-full flex items-center justify-center font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.53),
        background: tintForName(handle),
        color: colorForName(handle),
      }}
      aria-hidden
    >
      {initials || "?"}
    </span>
  );
}

// Slim provenance byline under the page title. Replaces the cramped
// inline scope chip that used to ride the title — metadata now reads as
// one calm dot-separated line (owner · edited · scope · visibility ·
// lock · live peers), Notion/Linear style. Only renders facts that
// exist; live-peer chip appears only while a collab room is connected.
function PagePropsRow({
  note,
  identity,
  locked,
  published,
  peers,
}: {
  note: Note;
  identity: TeamIdentity | null;
  locked: boolean;
  published: boolean;
  peers: PagesProvider | null;
}) {
  const ownerHandle =
    note.frontmatter.author?.replace(/^@/, "") ||
    identity?.handle?.replace(/^@/, "") ||
    null;
  const edited = note.frontmatter.updated_at
    ? relAge(note.frontmatter.updated_at)
    : "";
  const peerCount = usePeerCount(peers);

  return (
    <div className="mt-3 flex items-center flex-wrap gap-x-2 gap-y-1 text-[12px] text-text-4">
      {ownerHandle && (
        <span className="flex items-center gap-1.5">
          <AvatarChip handle={ownerHandle} size={14} />
          <span className="text-text-2">@{ownerHandle}</span>
        </span>
      )}
      {edited && (
        <>
          <Dot />
          <span>Edited {edited}</span>
        </>
      )}
      <Dot />
      <span>{scopeLabel(note)}</span>
      <Dot />
      <span>{published ? "Shared" : "Private"}</span>
      {locked && (
        <>
          <Dot />
          <span className="flex items-center gap-1 text-amber">
            <Lock className="w-3 h-3" strokeWidth={1.75} /> Locked
          </span>
        </>
      )}
      {peerCount > 0 && (
        <>
          <Dot />
          <span className="flex items-center gap-1 text-accent-green">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />
            {peerCount} editing
          </span>
        </>
      )}
    </div>
  );
}

function Dot() {
  return (
    <span className="text-text-5" aria-hidden>
      ·
    </span>
  );
}

// Live count of remote collaborators in the page's awareness room (self
// excluded). 0 when no room is mounted. Subscribes to awareness "change"
// so the byline reflects peers joining/leaving without a re-render of
// the whole pane.
function usePeerCount(peers: PagesProvider | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!peers) {
      setCount(0);
      return;
    }
    const aw = peers.awareness;
    const recompute = () => setCount(Math.max(0, aw.getStates().size - 1));
    recompute();
    aw.on("change", recompute);
    return () => aw.off("change", recompute);
  }, [peers]);
  return count;
}

function NewPageButton({
  team,
  identity,
  onCreate,
}: {
  team: TeamManifest | null;
  identity: TeamIdentity | null;
  onCreate: (scope: NoteScope, bucket: string, template: NoteTemplate) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="accentSoft" size="default">
          <Plus strokeWidth={2} />
          New page
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[260px] text-[12px]">
        <DropdownMenuLabel>Create in</DropdownMenuLabel>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-[12px]">
            Team
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-[240px] text-[12px]">
            <DropdownMenuLabel>Template</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {TEMPLATES.map((tpl) => (
              <DropdownMenuItem
                key={tpl.id}
                onSelect={() => onCreate("team", "", tpl.id)}
                className="flex-col items-start gap-0.5 py-1.5"
              >
                <span className="text-[12px] text-text-1">{tpl.label}</span>
                <span className="text-[10.5px] text-text-5">
                  {tpl.description}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {(team?.channels ?? []).length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Channel</DropdownMenuLabel>
            {(team?.channels ?? []).slice(0, 8).map((channel) => (
              <DropdownMenuSub key={channel}>
                <DropdownMenuSubTrigger className="text-[12px]">
                  #{channel}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[240px] text-[12px]">
                  <DropdownMenuLabel>Template</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {TEMPLATES.map((tpl) => (
                    <DropdownMenuItem
                      key={tpl.id}
                      onSelect={() => onCreate("channel", channel, tpl.id)}
                      className="flex-col items-start gap-0.5 py-1.5"
                    >
                      <span className="text-[12px] text-text-1">
                        {tpl.label}
                      </span>
                      <span className="text-[10.5px] text-text-5">
                        {tpl.description}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </>
        )}

        {identity?.handle && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Private</DropdownMenuLabel>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="text-[12px]">
                @{identity.handle} (you)
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[240px] text-[12px]">
                <DropdownMenuLabel>Template</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {TEMPLATES.map((tpl) => (
                  <DropdownMenuItem
                    key={tpl.id}
                    onSelect={() =>
                      onCreate("member", identity.handle ?? "", tpl.id)
                    }
                    className="flex-col items-start gap-0.5 py-1.5"
                  >
                    <span className="text-[12px] text-text-1">{tpl.label}</span>
                    <span className="text-[10.5px] text-text-5">
                      {tpl.description}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PagesEmptyState({
  tab,
  hasQuery,
  onCreate,
}: {
  tab: VisibilityTab;
  hasQuery: boolean;
  onCreate: () => void;
}) {
  if (hasQuery) {
    return (
      <div className="px-8 py-16 flex flex-col items-center justify-center text-center">
        <Search className="w-8 h-8 text-text-5 mb-3" strokeWidth={1.5} />
        <div className="text-[13px] text-text-3">No pages match your search.</div>
        <div className="text-[11.5px] text-text-5 mt-1">
          Try a shorter query, or browse the {tab} tab.
        </div>
      </div>
    );
  }
  const copy =
    tab === "public"
      ? {
          title: "No public pages yet",
          sub: "Team docs, RFCs, and runbooks live here. Create the first one to get started.",
        }
      : tab === "private"
        ? {
            title: "No private pages",
            sub: "Pages only you can see — drafts, notes-to-self, scratch work.",
          }
        : {
            title: "Nothing archived",
            sub: "Archived pages move here so the active list stays clean.",
          };
  return (
    <div className="px-8 py-16 flex flex-col items-center justify-center text-center">
      <div className="w-12 h-12 rounded-full bg-bg-2 flex items-center justify-center mb-4">
        <FileText className="w-6 h-6 text-text-4" strokeWidth={1.5} />
      </div>
      <div className="text-[14px] text-text-1 font-medium">{copy.title}</div>
      <div className="text-[12px] text-text-5 max-w-sm mt-1.5">{copy.sub}</div>
      {tab !== "archived" && (
        <Button
          variant="accentSoft"
          size="lg"
          onClick={onCreate}
          className="mt-5"
        >
          <Plus strokeWidth={2} />
          New page
        </Button>
      )}
      <div className="text-[11px] text-text-5 mt-3">
        Tip: inside a page, type <span className="text-text-3 font-mono">/</span>{" "}
        for the block menu.
      </div>
    </div>
  );
}

// ─── Page detail (RR.7 — Tiptap editor + sticky action bar) ────────────

function PageDetail({
  repoRoot,
  activeNote,
  title,
  body,
  view,
  saving,
  identity,
  summariesByTitle,
  onBack,
  onTitle,
  onBody,
  onView,
  onDelete,
  onMutateMeta,
  onOpenByTitle,
  onCreateBlank,
  embedded,
  onClose,
}: {
  repoRoot: string;
  activeNote: Note | null;
  title: string;
  body: string;
  view: ViewMode;
  saving: boolean;
  identity: TeamIdentity | null;
  summariesByTitle: Map<string, NoteSummary>;
  onBack: () => void;
  onTitle: (s: string) => void;
  onBody: (s: string) => void;
  onView: (v: ViewMode) => void;
  onDelete: () => void;
  onMutateMeta: (patch: { locked?: boolean; visibility?: string }) => void;
  onOpenByTitle: (t: string) => boolean;
  onCreateBlank: (target: string) => void;
  embedded: boolean;
  onClose?: () => void;
}) {
  // Hooks must run unconditionally — keep them above the early
  // return below.
  const tiptapRef = useRef<TiptapEditorInstance | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  // Pages collab provider — minted per (activeNote, identity) pair so remote
  // peers see this page's Y.Doc updates over the room WS.
  //
  // Minted SYNCHRONOUSLY during render (not in an effect) and cached in a ref
  // keyed by page identity, so the editor — whose key is the page id — binds
  // Collaboration to a stable Y.Doc on its FIRST mount. Effects run after paint,
  // so an effect-minted provider would arrive a render too late; the editor key
  // wouldn't change, so it'd never rebind and Collaboration would stay unbound
  // (the caret-jump + dropped-keystrokes bug). Construction is pure-local (no
  // network); the async room/device resolution + socket open happen in the
  // effect below via provider.connect(...). Local-only fallback (markSolo) when
  // identity/repoRoot is missing or there's no room.
  const pageCollabKey =
    activeNote && repoRoot && identity?.handle
      ? `${activeNote.scope}|${activeNote.bucket}|${activeNote.id}|${identity.handle}`
      : null;
  const collabCacheRef = useRef<{ key: string; provider: PagesProvider } | null>(
    null,
  );
  if (pageCollabKey !== (collabCacheRef.current?.key ?? null)) {
    if (collabCacheRef.current) collabCacheRef.current.provider.destroy();
    if (pageCollabKey && identity?.handle) {
      const handle = identity.handle;
      collabCacheRef.current = {
        key: pageCollabKey,
        provider: createPagesProvider({
          authorHandle: handle,
          authorColor: hashHandleToColor(handle),
        }),
      };
    } else {
      collabCacheRef.current = null;
    }
  }
  const pagesProvider = collabCacheRef.current?.provider ?? null;

  useEffect(() => {
    if (!pagesProvider || !activeNote || !repoRoot) return;
    let cancelled = false;
    (async () => {
      try {
        const [roomId, device] = await Promise.all([
          api.deviceRoomId(repoRoot),
          api.deviceIdentity(),
        ]);
        if (cancelled) return;
        if (!roomId) {
          pagesProvider.markSolo();
          return;
        }
        const pageId = `${activeNote.scope}|${activeNote.bucket}|${activeNote.id}`;
        await pagesProvider.connect({ roomId, pageId, deviceId: device.device_id });
      } catch (err) {
        console.warn("[NotesWorkpane] connect pages provider failed", err);
        if (!cancelled) pagesProvider.markSolo();
      }
    })();
    return () => {
      cancelled = true;
    };
    // Page identity drives a fresh provider (swapped synchronously above); this
    // effect connects it. identity changes are rare but follow the same path.
  }, [pagesProvider, activeNote?.id, activeNote?.scope, activeNote?.bucket, repoRoot]);

  // Destroy the last live provider on unmount (render-time swap handles
  // page-to-page teardown; this is the final teardown).
  useEffect(() => {
    return () => {
      if (collabCacheRef.current) {
        collabCacheRef.current.provider.destroy();
        collabCacheRef.current = null;
      }
    };
  }, []);
  // Force a re-render when the editor instance flips between
  // `null` and a value so TiptapToolbarPill can wire to it. We
  // bump a counter on mount; the ref itself doesn't trigger renders.
  const [, setEditorTick] = useState(0);
  useEffect(() => {
    if (!activeNote) return;
    // Two-frame nudge so the ref is populated before we toggle.
    const id = window.requestAnimationFrame(() => setEditorTick((n) => n + 1));
    return () => window.cancelAnimationFrame(id);
  }, [activeNote?.id]);
  // Re-read localStorage when the inline AddIconButton / AddCoverButton
  // write changes so the surrounding PageDocHead / PageIcon / PageCover
  // pick them up without requiring a remount.
  const [, setChromeTick] = useState(0);
  useEffect(() => {
    function bump() {
      setChromeTick((n) => n + 1);
    }
    window.addEventListener("aura:page:icon-changed", bump);
    window.addEventListener("aura:page:cover-changed", bump);
    return () => {
      window.removeEventListener("aura:page:icon-changed", bump);
      window.removeEventListener("aura:page:cover-changed", bump);
    };
  }, []);
  if (!activeNote) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-[12px] text-text-4">
        <AsciiSpinner />
        Loading…
      </div>
    );
  }
  const pageKey = `${activeNote.scope}|${activeNote.bucket}|${activeNote.id}`;
  const iconSet = hasIcon(pageKey);
  const coverSet = hasCover(pageKey);
  // Lock (read-only) + Publish (shared) state, derived from frontmatter.
  // Visibility defaults per scope when unset: member notes are private
  // drafts, team/channel notes are shared.
  const locked = !!activeNote.frontmatter.locked;
  const published =
    (activeNote.frontmatter.visibility ??
      (activeNote.scope === "member" ? "private" : "shared")) === "shared";
  const editedAge = activeNote.frontmatter.updated_at
    ? relAge(activeNote.frontmatter.updated_at)
    : "";
  return (
    <>
      {/* One calm top bar — the two stacked bars (breadcrumb + toolbar)
       *  collapse into a single light chrome strip so the canvas stays the
       *  star. Left: back-to-Pages breadcrumb. Right: edited stamp · page
       *  actions · a compact Blocks/Source/Preview segmented · close. The
       *  Tiptap formatting toolbar is no longer a persistent ribbon — it
       *  floats as a centered bottom pill over the canvas (Dropbox-Paper
       *  style) so the reading column is never crowded. */}
      <div className="h-11 px-4 border-b border-line-soft flex items-center gap-2 flex-shrink-0 bg-bg-content">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-[12px] text-text-4 hover:text-text-1 -ml-1 px-2 py-1 rounded-md hover:bg-bg-2 transition-colors"
          title="Back to pages"
        >
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.5} />
          <span>Pages</span>
        </button>
        <div className="flex-1" />
        <span className="text-[11.5px] text-text-4 tabular-nums whitespace-nowrap">
          {saving ? "Saving…" : editedAge ? `Edited ${editedAge}` : "Saved"}
        </span>
        <Sep />
        <PageActionBar
          pageKey={pageKey}
          published={published}
          onTogglePublish={() =>
            onMutateMeta({ visibility: published ? "private" : "shared" })
          }
          locked={locked}
          onToggleLock={() => onMutateMeta({ locked: !locked })}
          onShare={() => setShareOpen(true)}
          onDelete={onDelete}
        />
        <Sep />
        <div className="flex items-center gap-px bg-bg-2/60 rounded-md p-px">
          <ViewToggle current={view} onChange={onView} label="Blocks" value="blocks" />
          <ViewToggle current={view} onChange={onView} label="Source" value="source" />
          <ViewToggle current={view} onChange={onView} label="Preview" value="preview" />
        </div>
        {!embedded && onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            className="w-7 h-7 grid place-items-center text-text-4 hover:text-text-1 rounded-md hover:bg-bg-2 transition-colors"
          >
            <span className="text-[14px] leading-none">×</span>
          </button>
        )}
      </div>

      {/* Scrollable canvas — full-bleed cover above the centered body
       *  column. Title + editor share the SAME max-w + padding so they
       *  align horizontally. The floating format pill is rendered last so
       *  it layers over the canvas, bottom-centered. */}
      <div className="pages-canvas flex-1 min-h-0 overflow-y-auto bg-bg-content relative">
        {/* Full-bleed cover when set. Renders nothing otherwise so we
         *  don't burn a row on every page. */}
        <PageCover pageKey={pageKey} />

        {/* Body column — Notion/Linear/Paper page-doc-content: a calm
         *  centered ~740px measure with generous gutters. Cover-head,
         *  icon, title, props row and editor share the SAME max-w +
         *  padding so they align flush left and the document reads as one
         *  column, not a form. */}
        <div className="max-w-[740px] mx-auto px-14 pt-8 pb-28">
          {/* Page head — Notion-style hover-revealed buttons for
           *  "Add icon" / "Add cover" when neither is set. Disappears
           *  once the user picks one. */}
          {(!iconSet || !coverSet) && (
            <PageDocHead
              pageKey={pageKey}
              hasIcon={iconSet}
              hasCover={coverSet}
            />
          )}

          {/* Icon block (only when set) */}
          {iconSet && (
            <div className="pt-2">
              <PageIcon pageKey={pageKey} hasCover={coverSet} />
            </div>
          )}

          {/* Title — big bold display type, full measure, flush with the
           *  editor margin. ReadOnly while the page is locked. */}
          <div className="pt-3">
            <input
              type="text"
              value={title}
              onChange={(e) => onTitle(e.target.value)}
              readOnly={locked}
              placeholder="Untitled"
              className={cn(
                "w-full bg-transparent text-[30px] font-bold text-text-1 focus:outline-none placeholder:text-text-4 tracking-[-0.01em] leading-[1.2]",
                locked && "cursor-default",
              )}
            />
          </div>

          {/* Slim properties row — one calm provenance line (owner ·
           *  edited · scope · visibility · lock · live peers) under the
           *  title, the one place metadata lives now that the cramped
           *  inline scope chip is gone. */}
          <PagePropsRow
            note={activeNote}
            identity={identity}
            locked={locked}
            published={published}
            peers={pagesProvider}
          />
          <div className="h-px bg-line-soft my-6" aria-hidden />

          {/* Editor / source / preview — no internal padding, parent
           *  wrapper carries the horizontal margin. */}
          <div className="min-h-[420px]">
            {view === "blocks" ? (
              <TiptapEditor
                key={`${activeNote.scope}|${activeNote.bucket}|${activeNote.id}`}
                value={body}
                onChange={onBody}
                placeholder="Type / for blocks…"
                showSectionIndicator
                editorRef={tiptapRef}
                noPadding
                editable={!locked}
                collab={pagesProvider ? { provider: pagesProvider } : undefined}
                onLinkClick={(href) => {
                  if (!href.startsWith("aura-wiki:")) return false;
                  const target = href.slice("aura-wiki:".length);
                  if (onOpenByTitle(target)) return true;
                  onCreateBlank(target);
                  return true;
                }}
              />
            ) : view === "source" ? (
              <Editor
                value={body}
                language="markdown"
                onChange={onBody}
                filePath={`note:${activeNote.id}`}
              />
            ) : (
              <div className="tiptap-pane prose prose-invert max-w-none text-[15px] leading-[1.7] text-text-1">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath, remarkWikilinks]}
                  rehypePlugins={[rehypeKatex]}
                  components={{
                    a: ({ href, children, ...props }) => {
                      if (typeof href === "string" && href.startsWith("aura-wiki:")) {
                        const target = href.slice("aura-wiki:".length);
                        const resolved = summariesByTitle.has(target.toLowerCase());
                        return (
                          <button
                            type="button"
                            onClick={() => {
                              if (onOpenByTitle(target)) return;
                              onCreateBlank(target);
                            }}
                            className={
                              resolved
                                ? "text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
                                : "text-text-4 underline decoration-dashed underline-offset-2 hover:text-accent"
                            }
                            title={
                              resolved ? `Open: ${target}` : `Create note: ${target}`
                            }
                          >
                            {children}
                          </button>
                        );
                      }
                      return (
                        <a href={href} {...props}>
                          {children}
                        </a>
                      );
                    },
                  }}
                >
                  {body}
                </ReactMarkdown>
              </div>
            )}
          </div>
        </div>

        {/* Floating format pill — Dropbox-Paper style. Bottom-centered,
         *  layered over the canvas so the reading column stays clean. Only
         *  in Blocks view, when the editor is live and the page is
         *  editable. Locked pages get a quiet read-only hint instead. */}
        {view === "blocks" && (
          <div className="pointer-events-none sticky bottom-5 z-10 flex justify-center px-4">
            {locked ? (
              <span className="pointer-events-auto inline-flex items-center gap-1.5 text-[11.5px] text-amber bg-bg-2 px-3 h-9 rounded-full shadow-flyout">
                <Lock className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
                Read-only — unlock to edit
              </span>
            ) : (
              tiptapRef.current && (
                <TiptapToolbarPill
                  editor={tiptapRef.current}
                  className="pointer-events-auto bg-bg-2 rounded-full shadow-flyout"
                />
              )
            )}
          </div>
        )}
      </div>

      {/* Share — deep link + access model + Publish toggle + live peers.
       *  A genuine popup use-case (transient, focused), so it stays a
       *  dialog rather than a page. */}
      <PageShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        pageKey={pageKey}
        pageTitle={title}
        scopeLabel={scopeLabel(activeNote)}
        published={published}
        onTogglePublish={() =>
          onMutateMeta({ visibility: published ? "private" : "shared" })
        }
        provider={pagesProvider}
      />
    </>
  );
}

function ViewToggle({
  current,
  onChange,
  label,
  value,
}: {
  current: ViewMode;
  onChange: (v: ViewMode) => void;
  label: string;
  value: ViewMode;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={`text-[11px] px-2 py-[3px] rounded-[3px] transition-colors ${
        active
          ? "bg-bg-content text-text-1 shadow-sm"
          : "text-text-4 hover:text-text-1"
      }`}
    >
      {label}
    </button>
  );
}

// Thin vertical hairline separator for the editor's one-line top bar —
// matches the PageActionBar `.sep-v` so the back-crumb · edited · actions
// · view-toggle · close groups read as one calm cluster.
function Sep() {
  return (
    <span aria-hidden className="inline-block w-px h-3.5 bg-line-soft mx-1.5" />
  );
}

// Snapshot helpers: localStorage records covers + icons per-page,
// mirroring the PageCover / PageIcon storage keys. Read here so the
// layout can decide whether to render the inline "Add" affordance
// or the actual block, and whether to negative-margin the icon
// over a cover that's already showing.
function hasCover(pageKey: string): boolean {
  try {
    return !!localStorage.getItem(`aura.page.cover.${pageKey}`);
  } catch {
    return false;
  }
}

function hasIcon(pageKey: string): boolean {
  try {
    return !!localStorage.getItem(`aura.page.icon.${pageKey}`);
  } catch {
    return false;
  }
}

// Notion-style hover-revealed "Add icon" / "Add cover" row that sits
// above the title. Only renders the affordance(s) the user hasn't
// set yet. The buttons are 24px tall, subtle text-text-5, hover
// background — visible enough to discover but quiet enough to not
// clutter the page when ignored. Once a user clicks one, the
// corresponding PageIcon / PageCover block takes over and this row
// re-shrinks (or disappears entirely when both are set).
function PageDocHead({
  pageKey,
  hasIcon: iconSet,
  hasCover: coverSet,
}: {
  pageKey: string;
  hasIcon: boolean;
  hasCover: boolean;
}) {
  // Reuse the existing components — they own their picker popovers
  // and storage writes. We just nudge them into render mode by
  // pretending the user is hovering: triggers visible in this row.
  return (
    <div className="h-7 flex items-center gap-1 -ml-2 opacity-60 hover:opacity-100 transition-opacity">
      {!iconSet && <AddIconButton pageKey={pageKey} />}
      {!coverSet && <AddCoverButton pageKey={pageKey} />}
    </div>
  );
}

function AddIconButton({ pageKey }: { pageKey: string }) {
  // Lazy-load PageIcon's emoji picker via a minimal local trigger so
  // we don't need to forward the popover state through props. The
  // PageIcon component's "set" branch handles the real picker once
  // the user picks something; this just writes the first emoji and
  // re-renders the page.
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-6 px-2 inline-flex items-center gap-1.5 text-[11.5px] text-text-5 hover:text-text-2 rounded hover:bg-bg-2 transition-colors"
      >
        <span aria-hidden>😀</span>
        Add icon
      </button>
      {open && (
        <InlineEmojiPick
          onPick={(e) => {
            try {
              localStorage.setItem(`aura.page.icon.${pageKey}`, e);
            } catch {
              /* localStorage denied — session-only is fine */
            }
            setOpen(false);
            // Nudge a re-render of the surrounding PageDetail. The
            // simplest mechanism: dispatch a custom event that the
            // parent doesn't actually listen for — the storage write
            // + next user interaction re-mounts PageIcon. For an
            // immediate update we force the location hash; a more
            // surgical fix would lift `iconSet` state up, but a
            // single window event keeps the patch tight.
            window.dispatchEvent(new Event("aura:page:icon-changed"));
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AddCoverButton({ pageKey }: { pageKey: string }) {
  const [open, setOpen] = useState(false);
  const presets = [
    { id: "indigo-pink", css: "linear-gradient(135deg, #6366f1 0%, #ec4899 100%)" },
    { id: "emerald-cyan", css: "linear-gradient(135deg, #10b981 0%, #06b6d4 100%)" },
    { id: "amber-rose", css: "linear-gradient(135deg, #f59e0b 0%, #f43f5e 100%)" },
    { id: "slate", css: "linear-gradient(135deg, #475569 0%, #1e293b 100%)" },
    { id: "violet-orange", css: "linear-gradient(135deg, #8b5cf6 0%, #f97316 100%)" },
    { id: "teal-violet", css: "linear-gradient(135deg, #14b8a6 0%, #7c3aed 100%)" },
  ];
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-6 px-2 inline-flex items-center gap-1.5 text-[11.5px] text-text-5 hover:text-text-2 rounded hover:bg-bg-2 transition-colors"
      >
        <span aria-hidden>🖼️</span>
        Add cover
      </button>
      {open && (
        <div
          className="absolute left-0 top-full mt-1 z-30 w-[260px] p-2 bg-bg-1 border border-line-soft rounded-lg shadow-[var(--shadow-flyout)]"
          role="dialog"
        >
          <div className="text-[10.5px] uppercase tracking-wider text-text-5 mb-2 px-1">
            Gradient covers
          </div>
          <div className="grid grid-cols-3 gap-2">
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  try {
                    localStorage.setItem(`aura.page.cover.${pageKey}`, p.id);
                  } catch {
                    /* session-only is fine */
                  }
                  setOpen(false);
                  window.dispatchEvent(new Event("aura:page:cover-changed"));
                }}
                className="h-12 rounded-md border border-line-soft hover:border-text-4 transition-colors"
                style={{ background: p.css }}
                aria-label={p.id}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Minimal emoji picker for the inline AddIconButton. Avoids
// dragging in PageIcon's full popover for a one-shot pick.
function InlineEmojiPick({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const quick = [
    "💡", "📝", "📌", "🎯", "🚀", "✨",
    "✅", "⚠️", "🟢", "🔴", "⏳", "🔒",
    "📚", "📖", "📦", "⚙️", "🔧", "🔍",
  ];
  return (
    <div
      className="absolute left-0 top-full mt-1 z-30 w-[240px] p-2 bg-bg-1 border border-line-soft rounded-lg shadow-[var(--shadow-flyout)]"
      role="dialog"
      onBlur={onClose}
    >
      <div className="grid grid-cols-6 gap-0.5">
        {quick.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => onPick(e)}
            className="w-8 h-8 grid place-items-center text-[18px] rounded hover:bg-bg-2"
            title={e}
          >
            <span aria-hidden>{e}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── KK.2 — search overlay (BacklinksPanel migrated to PageDocSide) ────

function NotesSearchDialog({
  repoRoot,
  onClose,
  onPick,
}: {
  repoRoot: string;
  onClose: () => void;
  onPick: (s: NoteSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<NoteSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(() => {
      api
        .notesSearch(repoRoot, query, 50)
        .then((rows) => {
          if (!cancelled) setHits(rows);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query, repoRoot]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-50 bg-black/40 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[90vw] max-h-[60vh] flex flex-col bg-bg-1 border border-line-soft rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes… (Esc to close)"
          className="bg-transparent border-b border-line-soft px-4 py-3 text-[14px] text-text-1 focus:outline-none placeholder:text-text-5"
        />
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-text-4">
              <AsciiSpinner />
              Searching…
            </div>
          )}
          {!loading && query.trim() && hits.length === 0 && (
            <div className="px-4 py-3 text-[12px] text-text-5">No matches.</div>
          )}
          {hits.map((h) => (
            <button
              key={`${h.note.scope}/${h.note.bucket}/${h.note.id}`}
              type="button"
              onClick={() => onPick(h.note)}
              className="w-full text-left px-4 py-2 hover:bg-bg-2 border-b border-line-soft/40 last:border-0 transition-colors"
            >
              <div className="flex items-baseline gap-2 mb-0.5">
                <span className="text-[13px] font-medium text-text-1">
                  {h.note.title}
                </span>
                <span className="text-[10px] text-text-5 font-mono">
                  {h.note.scope === "team"
                    ? "team"
                    : h.note.scope === "channel"
                      ? `#${h.note.bucket}`
                      : `@${h.note.bucket}`}
                </span>
                <span className="text-[10px] text-text-5 ml-auto">
                  {h.match_count} match{h.match_count === 1 ? "" : "es"}
                </span>
              </div>
              <div className="text-[11.5px] text-text-3 truncate font-mono">
                {h.snippet}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── helpers ───────────────────────────────────────────────────────────

function keyFor(s: { scope: NoteScope; bucket: string; id: string }): string {
  return `${s.scope}|${s.bucket}|${s.id}`;
}

function parseKey(k: string): { scope: NoteScope; bucket: string; id: string } {
  const [scope, bucket, ...rest] = k.split("|");
  return {
    scope: scope as NoteScope,
    bucket,
    id: rest.join("|"),
  };
}

function scopeLabel(n: Note): string {
  if (n.scope === "team") return "Team";
  if (n.scope === "channel") return `#${n.bucket}`;
  return `@${n.bucket}`;
}

// ─── templates ─────────────────────────────────────────────────────────

function buildTemplateSeed(
  template: NoteTemplate,
  scopeLabelText: string,
  authorHandle: string | null,
): { title: string; body: string } {
  const today = new Date().toISOString().slice(0, 10);
  const author = authorHandle ? `@${authorHandle}` : "_unassigned_";

  switch (template) {
    case "decision-log": {
      const title = `Decision Log — ${scopeLabelText}`;
      const body = `# ${title}

Running log of decisions. Append new rows on top. Keep context terse;
link out for the full reasoning.

| Date | Decision | Context | Status |
|------|----------|---------|--------|
| ${today} | _short decision_ | _why now, what triggered it_ | proposed |

---

## ${today} — _short decision_

**Status:** proposed · accepted · superseded
**Owner:** ${author}
**Stakeholders:** _who needs to sign off_

### Context
_What problem are we solving? What forces are at play?_

### Options considered
1. _Option A — pros / cons_
2. _Option B — pros / cons_

### Decision
_What we are going to do, in one paragraph._

### Consequences
_What becomes easier, what becomes harder, what we will revisit and when._
`;
      return { title, body };
    }

    case "rfc": {
      const title = `RFC: _short title_`;
      const body = `# ${title}

**Status:** draft · in-review · accepted · rejected · superseded
**Authors:** ${author}
**Reviewers:** _@handles_
**Created:** ${today}
**Target:** _milestone / release_

## Summary
_One paragraph. Someone skimming should walk away knowing what changes
and why it matters._

## Motivation
_What problem does this solve? Who is affected? What goes wrong today?_

## Goals
- _Outcome 1_
- _Outcome 2_

## Non-goals
- _Explicitly out of scope_

## Detailed design
_The meat of the RFC. Architecture, data model, API surface, migration,
failure modes. Diagrams or pseudo-code welcome._

### Data model

### API surface

### Migration / rollout

## Alternatives considered
1. _Alternative A — why we did not pick it_
2. _Alternative B — why we did not pick it_

## Risks & open questions
- _Risk 1 + mitigation_
- _Open question 1_

## Acceptance criteria
- [ ] _Behavioural outcome 1 verifiable_
- [ ] _Behavioural outcome 2 verifiable_
`;
      return { title, body };
    }

    case "design-doc": {
      const title = `Design: _component / feature_`;
      const body = `# ${title}

**Author:** ${author}
**Created:** ${today}
**Status:** draft

## Overview
_What are we building? One paragraph._

## Goals
- _What success looks like_

## Non-goals
- _What this explicitly does not do_

## Architecture
_How the pieces fit. Diagrams in mermaid or ascii art are great._

\`\`\`
[client] --> [api] --> [worker] --> [store]
\`\`\`

### Components
- **_Component A_** — _responsibility_
- **_Component B_** — _responsibility_

### Data flow
_Step through the happy path end-to-end._

### Failure modes
_What can go wrong, what we do about it._

## Open questions
- [ ] _Question 1_
- [ ] _Question 2_

## Rollout plan
_Feature flag, staged rollout, telemetry to watch._
`;
      return { title, body };
    }

    case "standup": {
      const title = `Standup — ${today}${authorHandle ? ` · @${authorHandle}` : ""}`;
      const body = `# ${title}

## Yesterday
- _What landed_
- _What stalled and why_

## Today
- [ ] _Top priority_
- [ ] _Next_
- [ ] _Stretch_

## Blockers
- _What is in your way — name names and timeframes_

## Notes
_Anything the team should know but is not blocking._
`;
      return { title, body };
    }

    case "postmortem": {
      const title = `Postmortem: _incident summary_`;
      const body = `# ${title}

**Date of incident:** ${today}
**Authors:** ${author}
**Status:** draft · in-review · published
**Severity:** SEV-? (1 = critical, 4 = minor)

## Impact
_Who was affected, for how long, and how badly. Quantify wherever you
can — users, revenue, requests dropped, SLO burn._

## Root cause
_The single change or condition that, if absent, would have prevented
the incident. Be specific. Avoid blame; focus on the system._

## Trigger
_The thing that pushed the latent issue into a live failure (deploy,
traffic spike, dependency outage, etc)._

## Resolution
_What we did to stop the bleeding and restore service._

## Detection
_How we found out. Was it monitoring? A user report? How long until
someone knew?_

## Timeline (all times ${Intl.DateTimeFormat().resolvedOptions().timeZone})
| Time | Event |
|------|-------|
| HH:MM | _Trigger event_ |
| HH:MM | _First alert / detection_ |
| HH:MM | _Mitigation started_ |
| HH:MM | _Service restored_ |
| HH:MM | _All clear_ |

## What went well
- _Things we want to keep doing_

## What went wrong
- _Things that made the incident worse or longer_

## Where we got lucky
- _Things that could have been worse_

## Action items
| # | Action | Owner | Type | Due |
|---|--------|-------|------|-----|
| 1 | _What to do_ | ${author} | prevent · detect · mitigate · process | YYYY-MM-DD |
`;
      return { title, body };
    }

    case "blank":
    default: {
      const title = scopeLabelText;
      const body = `# ${title}\n\n`;
      return { title, body };
    }
  }
}

function shortRepo(p: string): string {
  if (!p) return "";
  const segs = p.split("/").filter(Boolean);
  return segs.length <= 2 ? p : `…/${segs.slice(-2).join("/")}`;
}

// "2h ago" / "3d ago" relative stamp for the editor's slim properties row,
// where a precise date is noise — the reader wants recency, not a timestamp.
function relAge(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
