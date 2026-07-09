// PagesSurface — the Pages workspace shell. Two columns: PageEditorPane
// (center) + PageContextRail (right). The page LIST lives in the single main
// Plan-rail sidebar (PagesSidebar) — this surface deliberately has no inner
// list column, so the app never shows two stacked page sidebars. It owns the
// active page, the live body buffer, a debounced save, and a periodic sync
// poll; navigation arrives over the `aura:pages:open` bridge the main sidebar
// drives. Mounts where the old NotesWorkpane lived.
//
// Cross-open contract: the parent supplies `repoRoot`. Page links and mentions
// open in-place (this component resolves a title → summary itself); person and
// task mentions dispatch window CustomEvents (`aura:open-dm`, `aura:open-task`)
// that the App-level listeners handle.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Plus } from "lucide-react";
import { PageEditorPane, type PageView, type SaveState } from "./PageEditorPane";
import { PageContextRail } from "./PageContextRail";
import { Button } from "../ui/button";
import {
  notesList,
  notesRead,
  notesWrite,
  notesArchive,
  pagesSyncPoll,
  deviceRoomId,
  deviceIdentity,
  pageKey,
  parsePageKey,
  type Note,
  type NoteSummary,
} from "./pagesApi";
import {
  loadMentionSources,
  type MentionSources,
  type MentionItem,
} from "./mentionSources";
import {
  createPagesProvider,
  hashHandleToColor,
  type PagesProvider,
} from "../../lib/pages_collab";

type Props = {
  repoRoot: string;
  /** Author handle stamped on writes (page frontmatter). Optional — falls
   *  back to undefined (backend may resolve from git). */
  authorHandle?: string;
};

const SYNC_INTERVAL_MS = 6000;
const SAVE_DEBOUNCE_MS = 700;

export function PagesSurface({ repoRoot, authorHandle }: Props) {
  const [summaries, setSummaries] = useState<NoteSummary[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [pageView, setPageView] = useState<PageView>("blocks");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  // Outline/context rail is hidden by default — the editor takes full width
  // until the reader opts into the rail from the header kebab.
  const [railOpen, setRailOpen] = useState(false);
  const [mentionSources, setMentionSources] = useState<MentionSources | undefined>(
    undefined,
  );
  const editorRef = useRef<Editor | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pending edits the debounced save will flush. Holds title/body/frontmatter
  // overrides so we never lose a keystroke between debounce ticks.
  const pendingRef = useRef<{ title: string; body: string } | null>(null);
  const activeNoteRef = useRef<Note | null>(null);
  activeNoteRef.current = activeNote;

  // ── Live collab provider (render-time mint) ──────────────────────────────
  // The provider MUST exist on the editor's very first render of a page, or the
  // editor mounts in a non-collab state and never binds Collaboration (its key
  // is the page id, so a later state flip won't remount it). Effects run after
  // paint, so minting in an effect is too late. Instead we derive the provider
  // synchronously during render and cache it in a ref keyed by page identity:
  // the same render that first sees a new page also has a bound provider.
  //
  // Construction is pure-local (Y.Doc + Awareness, no network), so doing it in
  // render is safe; the async room/device resolution + socket open happen in
  // the effect below via provider.connect(...). Teardown of the previous page's
  // provider also happens here so we never leak a Y.Doc.
  const noteScope = activeNote?.scope;
  const noteBucket = activeNote?.bucket;
  const noteId = activeNote?.id;
  const pageCollabKey =
    noteId && noteScope != null && noteBucket != null
      ? `${noteScope}|${noteBucket}|${noteId}|${authorHandle ?? ""}`
      : null;
  const collabCacheRef = useRef<{ key: string; provider: PagesProvider } | null>(
    null,
  );
  if (pageCollabKey !== (collabCacheRef.current?.key ?? null)) {
    // Page (or identity) changed — destroy the previous provider and mint a
    // fresh one for the new page, synchronously, right here in render.
    if (collabCacheRef.current) collabCacheRef.current.provider.destroy();
    if (pageCollabKey) {
      const handle = authorHandle || "anon";
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
  const collabProvider = collabCacheRef.current?.provider ?? null;

  // Connect (room + device resolve async) + tear down on unmount. Keyed on the
  // page identity so a page switch reconnects; the provider object itself is
  // already swapped synchronously above.
  useEffect(() => {
    if (!collabProvider || !noteId || noteScope == null || noteBucket == null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [roomId, device] = await Promise.all([
          deviceRoomId(repoRoot),
          deviceIdentity(),
        ]);
        if (cancelled) return;
        if (!roomId) {
          // Solo repo / no room — no server to reconcile with, so let the
          // editor seed the local doc from saved markdown right away.
          collabProvider.markSolo();
          return;
        }
        await collabProvider.connect({
          roomId,
          pageId: `${noteScope}|${noteBucket}|${noteId}`,
          deviceId: device.device_id,
        });
      } catch (err) {
        console.warn("[PagesSurface] connect collab provider failed", err);
        if (!cancelled) collabProvider.markSolo();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collabProvider, noteId, noteScope, noteBucket, repoRoot]);

  // Destroy the last live provider when the surface unmounts (the render-time
  // swap handles page-to-page teardown; this covers the final teardown).
  useEffect(() => {
    return () => {
      if (collabCacheRef.current) {
        collabCacheRef.current.provider.destroy();
        collabCacheRef.current = null;
      }
    };
  }, []);

  // ── Load list + mention sources ─────────────────────────────────────────
  const refreshList = useCallback(async () => {
    try {
      const rows = await notesList({ repoRoot });
      setSummaries(rows);
    } catch {
      /* keep last-good list */
    }
  }, [repoRoot]);

  useEffect(() => {
    void refreshList();
    loadMentionSources(repoRoot)
      .then(setMentionSources)
      .catch(() => setMentionSources({ people: [], tasks: [], pages: [] }));
  }, [repoRoot, refreshList]);

  // Periodic sync poll — pull shared-page mutations + refetch when changed.
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const res = await pagesSyncPoll(repoRoot);
        if (!stopped && res.changed) await refreshList();
      } catch {
        /* solo repo / offline — no-op */
      }
    };
    const handle = setInterval(tick, SYNC_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }, [repoRoot, refreshList]);

  // ── Open a page ─────────────────────────────────────────────────────────
  const openSummary = useCallback(
    async (s: NoteSummary) => {
      // Flush any pending edits on the page we're leaving first.
      await flushSave();
      const key = pageKey(s);
      setActiveKey(key);
      try {
        const note = await notesRead(repoRoot, s.scope, s.bucket, s.id);
        setActiveNote(note);
        setBody(note.body);
        setTitle(note.frontmatter.title ?? "");
        setSaveState("saved");
        pendingRef.current = null;
      } catch {
        setActiveNote(null);
      }
    },
    // flushSave is stable (defined below with refs); listing repoRoot only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repoRoot],
  );

  const openByTitle = useCallback(
    (wantedTitle: string) => {
      const t = wantedTitle.trim().toLowerCase();
      const match = summaries.find(
        (s) => (s.title || "").trim().toLowerCase() === t,
      );
      if (match) {
        void openSummary(match);
      } else {
        // No page by that title yet → create one with this title.
        void createPage(wantedTitle);
      }
    },
    // openSummary + createPage are stable enough for this surface; summaries
    // is the live dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summaries],
  );

  // ── Save (debounced) ────────────────────────────────────────────────────
  const doSave = useCallback(
    async (override?: { title?: string; body?: string }) => {
      const note = activeNoteRef.current;
      if (!note) return;
      const nextTitle = override?.title ?? pendingRef.current?.title ?? title;
      const nextBody = override?.body ?? pendingRef.current?.body ?? body;
      setSaveState("saving");
      try {
        const saved = await notesWrite({
          repoRoot,
          scope: note.scope,
          bucket: note.bucket,
          id: note.id,
          body: nextBody,
          title: nextTitle,
          author: authorHandle,
          visibility: note.frontmatter.visibility ?? undefined,
          locked: note.frontmatter.locked ?? undefined,
          tags: note.frontmatter.tags,
          parentId: note.frontmatter.parent_id ?? null,
          archivedAt: note.frontmatter.archived_at ?? null,
          icon: note.frontmatter.icon ?? null,
        });
        setActiveNote(saved);
        setSaveState("saved");
        pendingRef.current = null;
        // Reflect the (possibly retitled) page in the tree.
        await refreshList();
      } catch {
        setSaveState("dirty");
      }
    },
    [repoRoot, authorHandle, title, body, refreshList],
  );

  const flushSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (pendingRef.current) await doSave();
  }, [doSave]);

  const scheduleSave = useCallback(
    (next: { title: string; body: string }) => {
      pendingRef.current = next;
      setSaveState("dirty");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void doSave();
      }, SAVE_DEBOUNCE_MS);
    },
    [doSave],
  );

  // Flush on unmount so a fast close doesn't drop the last keystrokes.
  useEffect(() => {
    return () => {
      if (pendingRef.current) void doSave();
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onBodyChange = useCallback(
    (md: string) => {
      setBody(md);
      scheduleSave({ title, body: md });
    },
    [title, scheduleSave],
  );

  const onTitleChange = useCallback(
    (t: string) => {
      setTitle(t);
      scheduleSave({ title: t, body });
    },
    [body, scheduleSave],
  );

  // ── Frontmatter toggles (lock / visibility) — write immediately ──────────
  const writeFrontmatter = useCallback(
    async (patch: Partial<{ locked: boolean; visibility: string }>) => {
      const note = activeNoteRef.current;
      if (!note) return;
      setSaveState("saving");
      try {
        const saved = await notesWrite({
          repoRoot,
          scope: note.scope,
          bucket: note.bucket,
          id: note.id,
          body,
          title,
          author: authorHandle,
          visibility: patch.visibility ?? note.frontmatter.visibility ?? undefined,
          locked: patch.locked ?? note.frontmatter.locked ?? undefined,
          tags: note.frontmatter.tags,
          parentId: note.frontmatter.parent_id ?? null,
          archivedAt: note.frontmatter.archived_at ?? null,
          icon: note.frontmatter.icon ?? null,
        });
        setActiveNote(saved);
        setSaveState("saved");
      } catch {
        setSaveState("dirty");
      }
    },
    [repoRoot, authorHandle, body, title],
  );

  const toggleLock = useCallback(() => {
    const note = activeNoteRef.current;
    if (!note) return;
    void writeFrontmatter({ locked: !note.frontmatter.locked });
  }, [writeFrontmatter]);

  // Set an exact visibility level (private / team / shared) from the header's
  // precise Share popover — no blind cycling. Per-person ACLs are out of scope
  // here (a backend wave); this only writes the page-level visibility string.
  const setVisibility = useCallback(
    (v: string) => {
      const note = activeNoteRef.current;
      if (!note) return;
      if ((note.frontmatter.visibility ?? "shared") === v) return;
      void writeFrontmatter({ visibility: v });
    },
    [writeFrontmatter],
  );

  // ── Create / archive / delete / reparent ────────────────────────────────
  const createPage = useCallback(
    async (initialTitle?: string) => {
      await flushSave();
      try {
        const created = await notesWrite({
          repoRoot,
          scope: "team",
          bucket: "",
          body: "",
          title: initialTitle ?? "Untitled",
          author: authorHandle,
        });
        await refreshList();
        const key = pageKey(created);
        setActiveKey(key);
        setActiveNote(created);
        setBody(created.body);
        setTitle(created.frontmatter.title ?? "");
        setSaveState("saved");
      } catch {
        /* surfaced via unchanged list */
      }
    },
    [repoRoot, authorHandle, flushSave, refreshList],
  );

  const archivePage = useCallback(
    async (s: NoteSummary, archived: boolean) => {
      try {
        await notesArchive(repoRoot, s.scope, s.bucket, s.id, archived);
        await refreshList();
        if (archived && pageKey(s) === activeKey) {
          setActiveKey(null);
          setActiveNote(null);
        }
      } catch {
        /* no-op */
      }
    },
    [repoRoot, activeKey, refreshList],
  );

  // ── Legacy Plan-rail bridge ──────────────────────────────────────────────
  // The PagesSidebar in the Plan rail still speaks the `aura:pages:*` protocol.
  // Honor open/refresh/close and mirror our state back so its list + highlight
  // stay in lock-step with this surface.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key;
      if (!key) return;
      const parsed = parsePageKey(key);
      if (!parsed) return;
      const match = summaries.find((s) => pageKey(s) === key);
      if (match) {
        void openSummary(match);
        return;
      }
      void (async () => {
        try {
          await flushSave();
          const note = await notesRead(
            repoRoot,
            parsed.scope,
            parsed.bucket,
            parsed.id,
          );
          setActiveKey(pageKey(note));
          setActiveNote(note);
          setBody(note.body);
          setTitle(note.frontmatter.title ?? "");
          setSaveState("saved");
          pendingRef.current = null;
        } catch {
          /* no-op */
        }
      })();
    };
    const onRefresh = () => void refreshList();
    const onClose = () => {
      setActiveKey(null);
      setActiveNote(null);
    };
    window.addEventListener("aura:pages:open", onOpen as EventListener);
    window.addEventListener("aura:pages:refresh", onRefresh);
    window.addEventListener("aura:pages:close", onClose);
    return () => {
      window.removeEventListener("aura:pages:open", onOpen as EventListener);
      window.removeEventListener("aura:pages:refresh", onRefresh);
      window.removeEventListener("aura:pages:close", onClose);
    };
  }, [summaries, openSummary, flushSave, refreshList, repoRoot]);

  // Mirror state to the Plan-rail PagesSidebar so its list + highlight track us.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("aura:pages:summaries", {
        detail: { summaries, activeKey },
      }),
    );
  }, [summaries, activeKey]);

  // ── Heading jump (rail → editor) ─────────────────────────────────────────
  const jumpToHeading = useCallback((slug: string) => {
    const view = editorRef.current?.view;
    if (!view) return;
    const root = view.dom as HTMLElement;
    const headings = root.querySelectorAll("h1, h2, h3");
    for (const h of Array.from(headings)) {
      const text = (h.textContent ?? "")
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
      if (text === slug) {
        h.scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      }
    }
  }, []);

  const onResolveMention = useCallback((_item: MentionItem) => {
    // Mention round-trips through the markdown token (handled by onBodyChange);
    // nothing extra to persist here. Hook kept for future eager indexing.
    void _item;
  }, []);

  return (
    <div className="flex h-full min-h-0 bg-bg-content">
      {/* Center — editor / empty state. The page LIST lives in the single main
          Plan-rail sidebar, so this surface has no inner list column. */}
      {activeNote ? (
        <PageEditorPane
          note={activeNote}
          repoRoot={repoRoot}
          authorHandle={authorHandle}
          body={body}
          title={title}
          saveState={saveState}
          view={pageView}
          mentionSources={mentionSources}
          collab={collabProvider}
          onTitleChange={onTitleChange}
          onBodyChange={onBodyChange}
          onViewChange={setPageView}
          onToggleLock={toggleLock}
          onSetVisibility={setVisibility}
          onArchive={() => {
            const s = summaries.find((x) => pageKey(x) === activeKey);
            if (s) void archivePage(s, true);
          }}
          railOpen={railOpen}
          onToggleRail={() => setRailOpen((v) => !v)}
          onOpenByTitle={openByTitle}
          onResolveMention={onResolveMention}
          editorRef={editorRef}
        />
      ) : (
        <div className="flex-1 min-w-0 flex flex-col items-center justify-center bg-bg-content text-center px-6">
          <div className="text-[16px] text-text-2 font-medium">No page open</div>
          <div className="mt-1 text-[12.5px] text-text-4">
            Pick one on the left, or start a new page.
          </div>
          <Button
            variant="accentSoft"
            onClick={() => void createPage()}
            className="mt-4"
          >
            <Plus className="w-3.5 h-3.5" strokeWidth={2} />
            New page
          </Button>
        </div>
      )}

      {/* Right — context rail. Hidden by default; the editor takes full width
          until the reader opens the outline from the header kebab. */}
      {railOpen && (
        <PageContextRail
          repoRoot={repoRoot}
          note={activeNote}
          body={body}
          mentionSources={mentionSources}
          onClose={() => setRailOpen(false)}
          onJumpToHeading={jumpToHeading}
          onOpenByTitle={openByTitle}
          onOpenSummary={(s) => void openSummary(s)}
        />
      )}
    </div>
  );
}
