/** TeamSurface — the references-grade 3-pane Team center surface.
 *
 *  Owns the single `useTeamChat()` instance and composes the three panes:
 *  ConversationList (left) · ConversationView (center) · ContextPanel
 *  (right, collapsible). Pure-presentational panes take the hook bundle as a
 *  prop; this container owns the responsive layout and the context-panel
 *  routing the channel header drives.
 *
 *  Responsive on the measured surface width (`chat.rootRef` → `chat.panelW`,
 *  no CSS media queries — matching the `useWindowWidth` precedent in
 *  Layout.tsx):
 *    ≥1040px → three columns (list · view · context), both side columns
 *              drag-resizable and width-persisted; context collapses to a
 *              thin re-open rail in place.
 *    640–1040px → two columns (list · view); context becomes a right-edge
 *              slide-over with a dismiss scrim.
 *    <640px → one column (list OR view, swapped by selection); context is a
 *              full-width overlay.
 *
 *  Threads no longer take over the center: opening one routes through
 *  `chat.activeThread` into the context panel's Thread tab while the channel
 *  stream stays on screen. */

import {
  useCallback,
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useTeamChat } from "./application/useTeamChat";
import { ConversationList } from "./presentation/ConversationList";
import { ConversationView } from "./presentation/ConversationView";
import { ContextPanel, type ContextTab } from "./presentation/ContextPanel";
import { IdentityChoiceDialog } from "../chat/IdentityChoiceDialog";
import { CreateChannelWizard } from "../chat/CreateChannelWizard";

// Responsive column breakpoints (measured surface width, px).
const THREE_COL_MIN = 1040;
const TWO_COL_MIN = 640;

// Side-column resize bounds + defaults. Persisted under the `aura.team.*`
// keys, mirroring Layout.tsx's `aura.sidebar.w` precedent.
const LIST_KEY = "aura.team.list.w";
const LIST_MIN = 210;
const LIST_MAX = 420;
const LIST_DEFAULT = 264;
const CONTEXT_KEY = "aura.team.context.w";
const CONTEXT_MIN = 260;
const CONTEXT_MAX = 480;
const CONTEXT_DEFAULT = 320;

type TeamSurfaceProps = {
  repoRoot: string;
  projectName: string;
  /** Narrow-mount "open in main pane" affordance, forwarded to the channel
   *  header. Omitted by the wide center-pane mount (already expanded). */
  onExpand?: () => void;
};

export function TeamSurface({ repoRoot, projectName, onExpand }: TeamSurfaceProps) {
  const chat = useTeamChat(repoRoot, projectName);
  const { active, activeThread, panelW, rootRef } = chat;

  const threeCol = panelW >= THREE_COL_MIN;
  const twoCol = panelW >= TWO_COL_MIN && panelW < THREE_COL_MIN;
  const oneCol = panelW < TWO_COL_MIN;

  const [listW, setListW] = usePersistentWidth(
    LIST_KEY,
    LIST_DEFAULT,
    LIST_MIN,
    LIST_MAX,
  );
  const [contextW, setContextW] = usePersistentWidth(
    CONTEXT_KEY,
    CONTEXT_DEFAULT,
    CONTEXT_MIN,
    CONTEXT_MAX,
  );

  // Context panel routing. `contextTab` is the active tab; `collapsed` is the
  // 3-col in-place collapse (thin rail), `open` the 2/1-col slide-over.
  const [contextTab, setContextTab] = useState<ContextTab>("members");
  // Default collapsed: the calm resting state is a two-column list +
  // conversation. The member/pin panel is a peek, opened on demand — so a
  // fresh Team view reads as calm as every other tab, not three busy columns.
  // Only an explicit header click persists a preference (below); thread
  // auto-reveal stays transient so it can't corrupt that choice.
  const [contextCollapsed, setContextCollapsed] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem("aura.team.contextCollapsed");
      if (raw === "false") return false;
      if (raw === "true") return true;
    } catch {
      /* private mode / quota — fall through to the default */
    }
    return true;
  });
  const [contextOpen, setContextOpen] = useState(false);

  // Persist only deliberate collapse/expand (header gesture), never the
  // transient thread-driven reveal — so the resting state stays calm.
  const persistCollapsed = useCallback((v: boolean) => {
    setContextCollapsed(v);
    try {
      localStorage.setItem("aura.team.contextCollapsed", String(v));
    } catch {
      /* best-effort */
    }
  }, []);

  // A thread opening pulls focus to the Thread tab and reveals the panel;
  // closing it drops back to Members and dismisses the slide-over so the
  // panel never strands you on an empty Thread tab.
  useEffect(() => {
    if (activeThread) {
      setContextTab("thread");
      setContextCollapsed(false);
      setContextOpen(true);
    } else {
      setContextTab((t) => (t === "thread" ? "members" : t));
      setContextOpen(false);
    }
  }, [activeThread]);

  // The channel header lights up its Members / Pins toggles off the tab the
  // context panel is actually showing — null whenever the panel is hidden.
  const contextTabForHeader: ContextTab | null = threeCol
    ? contextCollapsed
      ? null
      : contextTab
    : contextOpen
      ? contextTab
      : null;

  // Header / collapsed-rail clicks: open the panel at a tab, toggling it shut
  // if it is already showing that tab. The gesture differs per layout — an
  // in-place collapse at three columns, a slide-over elsewhere.
  const selectContext = useCallback(
    (tab: ContextTab) => {
      if (threeCol) {
        if (!contextCollapsed && contextTab === tab) {
          persistCollapsed(true);
        } else {
          setContextTab(tab);
          persistCollapsed(false);
        }
      } else {
        if (contextOpen && contextTab === tab) {
          setContextOpen(false);
        } else {
          setContextTab(tab);
          setContextOpen(true);
        }
      }
    },
    [threeCol, contextCollapsed, contextOpen, contextTab, persistCollapsed],
  );

  const showList = threeCol || twoCol || (oneCol && !active);
  const showView = threeCol || twoCol || (oneCol && !!active);
  const slideWidth = oneCol ? "100%" : Math.min(contextW, panelW - 120);

  return (
    <div
      ref={rootRef}
      className="ade-team-surface h-full w-full flex flex-col bg-bg-content overflow-hidden"
    >
      <div className="flex-1 min-h-0 flex overflow-hidden relative">
        {/* ── LEFT: conversation list ──────────────────────────────── */}
        {showList && (
          <ConversationList
            chat={chat}
            repoRoot={repoRoot}
            width={oneCol ? "full" : listW}
          />
        )}
        {showList && showView && !oneCol && (
          <ColumnResizer
            edge="leading"
            width={listW}
            min={LIST_MIN}
            max={LIST_MAX}
            onResize={setListW}
          />
        )}

        {/* ── CENTER: active conversation ──────────────────────────── */}
        {showView && (
          <ConversationView
            chat={chat}
            repoRoot={repoRoot}
            onExpand={onExpand}
            contextTab={contextTabForHeader}
            onSelectContext={selectContext}
          />
        )}

        {/* ── RIGHT: context panel (inline at 3 columns) ───────────── */}
        {threeCol && (
          <>
            {!contextCollapsed && (
              <ColumnResizer
                edge="trailing"
                width={contextW}
                min={CONTEXT_MIN}
                max={CONTEXT_MAX}
                onResize={setContextW}
              />
            )}
            <div
              className="h-full flex-shrink-0"
              style={{ width: contextCollapsed ? undefined : contextW }}
            >
              <ContextPanel
                chat={chat}
                repoRoot={repoRoot}
                tab={contextTab}
                onTabChange={setContextTab}
                collapsed={contextCollapsed}
                onToggleCollapse={() => setContextCollapsed((c) => !c)}
              />
            </div>
          </>
        )}

        {/* ── RIGHT: context panel (slide-over below 3 columns) ────── */}
        {!threeCol && contextOpen && active && (
          <>
            <div
              className="absolute inset-0 z-20"
              onClick={() => setContextOpen(false)}
              aria-hidden
            />
            <div
              className="absolute right-0 inset-y-0 z-30 h-full shadow-[-8px_0_24px_rgba(0,0,0,0.28)]"
              style={{ width: slideWidth }}
            >
              <ContextPanel
                chat={chat}
                repoRoot={repoRoot}
                tab={contextTab}
                onTabChange={setContextTab}
                onToggleCollapse={() => setContextOpen(false)}
              />
            </div>
          </>
        )}
      </div>

      {/* ── shared modal layer ───────────────────────────────────────
          First-send identity picker (II.9) + full-screen channel-create
          wizard. Both gate on hook state, so they no-op for the common
          single-identity / not-creating case. */}
      {chat.identityPickerOpen && chat.doctorReport && (
        <IdentityChoiceDialog
          repoRoot={repoRoot}
          report={chat.doctorReport}
          manifest={chat.manifest}
          onPicked={() => {
            chat.setIdentityPickerOpen(false);
            chat.refreshDoctor();
          }}
          onClose={() => chat.setIdentityPickerOpen(false)}
        />
      )}
      {chat.creatingChannel && (
        <CreateChannelWizard
          onCancel={() => chat.setCreatingChannel(false)}
          onSubmit={chat.createChannel}
        />
      )}
    </div>
  );
}

// localStorage-backed, clamped column width. Mirrors Layout.tsx's sidebar
// persistence so a dragged Team layout survives reloads.
function usePersistentWidth(
  storageKey: string,
  initial: number,
  min: number,
  max: number,
) {
  const [w, setW] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const n = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
    } catch {
      /* private mode / quota — fall through to the default */
    }
    return initial;
  });
  const set = useCallback(
    (next: number) => {
      const clamped = Math.max(min, Math.min(max, next));
      setW(clamped);
      try {
        localStorage.setItem(storageKey, String(clamped));
      } catch {
        /* persistence is best-effort */
      }
    },
    [storageKey, min, max],
  );
  return [w, set] as const;
}

// 4px transparent column resizer with a ~6px hover catch area (negative
// margins keep panes flush against the hairline border). Self-contained:
// each drag attaches its own window pointer listeners and tears them down on
// release, so there's no shared drag-state plumbing. `edge="leading"` grows
// the pane on a rightward drag (the list); `"trailing"` grows it on a
// leftward drag (the context panel).
function ColumnResizer({
  width,
  onResize,
  edge,
  min,
  max,
}: {
  width: number;
  onResize: (next: number) => void;
  edge: "leading" | "trailing";
  min: number;
  max: number;
}) {
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const raw = edge === "leading" ? startW + dx : startW - dx;
      onResize(Math.max(min, Math.min(max, raw)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className="cursor-col-resize hover:bg-line"
      style={{
        width: 4,
        marginLeft: -2,
        marginRight: -2,
        background: "transparent",
        flexShrink: 0,
        zIndex: 5,
      }}
    />
  );
}
