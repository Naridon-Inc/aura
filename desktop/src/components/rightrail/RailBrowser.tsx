// The in-app browser shell — a simple, app-native browser that lives entirely
// inside the rail (no detach-to-window: a separate OS window can't host the
// rail's native webview cleanly and broke "inside the sidebar area").
//
// One conventional toolbar sits on top — back · forward · reload · address ·
// tabs · new-tab — matching the rest of the app's compact chrome. Below it is
// the native webview. Two overlays cover the page when needed:
//   • Search face (ArcSearchOverlay) — a fresh tab, or tapping the address:
//     a search field + suggestions (with "Browse for me" to hand a query to
//     the agent). The native webview is hidden while it's up.
//   • Tab switcher (BrowserTabSwitcher) — the open tabs.
//
// The native WebKit webview (owned by Rust, see lib/browserEngine.ts) floats
// ABOVE the React DOM, so this component pins it to the hole and HIDES it
// whenever the hole isn't rendered (search face, tab switcher, or a
// `display:none` parent). `reconcile()` is the single place that drives it.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Plus,
  RotateCw,
  Search,
  SquareStack,
} from "lucide-react";

import { RailBrowserAgent } from "./RailBrowserAgent";
import { ArcSearchOverlay } from "./browser/ArcSearchOverlay";
import { BrowserTabSwitcher } from "./browser/BrowserTabSwitcher";
import {
  browserHide,
  browserNavigate,
  browserOpen,
  browserSetBounds,
  browserShow,
  hostOf,
  onBrowserState,
  type BrowserRect,
} from "../../lib/browserEngine";
import {
  applyBrowserState,
  back,
  closeTab,
  forward,
  getBrowserState,
  go,
  isCreated,
  markCreated,
  newTab,
  pushRecentSearch,
  reload,
  setActiveTab,
  unmarkCreated,
  useBrowserStore,
  useRecentSearches,
} from "../../lib/browserStore";

type Engine = "aura" | "google";

const ENGINE_KEY = "aura.browser.engine";

function readEngine(): Engine {
  try {
    return localStorage.getItem(ENGINE_KEY) === "google" ? "google" : "aura";
  } catch {
    return "aura";
  }
}

/** Hole rect in logical (CSS) pixels, or null when the hole isn't visible —
 *  a `display:none` parent yields a zero-size rect, our signal to hide the
 *  native webview instead of leaving it floating over other rail content. */
function visibleRect(el: HTMLDivElement | null): BrowserRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** Compact, app-native toolbar icon button (matches the editor's ToolButton). */
function IconBtn({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center w-7 h-7 flex-shrink-0 rounded transition-colors disabled:opacity-30 disabled:pointer-events-none ${
        active
          ? "bg-bg-2 text-text-1"
          : "text-text-3 hover:bg-bg-2 hover:text-text-1"
      }`}
    >
      {children}
    </button>
  );
}

export function RailBrowser() {
  const { tabs, activeId } = useBrowserStore();
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const recents = useRecentSearches();

  const holeRef = useRef<HTMLDivElement>(null);
  // Last navSeq we navigated each tab to — so a server redirect (which updates
  // url without bumping navSeq) is never echoed back as a fresh navigation.
  const lastNav = useRef<Map<string, number>>(new Map());

  // The search face's engine is remembered from last use; there's no visible
  // toggle in the simplified chrome (the search overlay can still switch it).
  const [engine] = useState<Engine>(readEngine);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  // Non-null = "Browse for me" was launched with this goal (auto-runs). null =
  // the agent panel was opened manually for the user to type a goal.
  const [agentGoal, setAgentGoal] = useState<string | null>(null);

  // ── Faces ────────────────────────────────────────────────────────────────
  // A fresh tab (no URL) shows the search face; the agent face wins over it so
  // "Browse for me" from the start page swaps straight to the trace. When an
  // overlay is up the hole is hidden so the native webview (which floats above
  // React) doesn't paint over it.
  const onStartPage = active != null && !active.url;
  const showSearch = (onStartPage || searchOpen) && !agentOpen;
  const showHole = !showSearch && !tabSwitcherOpen;

  // Always keep one tab open while the panel is mounted.
  useEffect(() => {
    if (tabs.length === 0) newTab();
  }, [tabs.length]);

  // The one place that drives the native webview.
  const reconcile = useCallback(() => {
    const state = getBrowserState();
    const tab = state.tabs.find((t) => t.id === state.activeId) ?? null;
    const rect = visibleRect(holeRef.current);

    // Hole not rendered (search face / tab switcher / hidden rail), no tab, or
    // a start-page tab (no URL) → nothing to show.
    if (!tab || !tab.url || !rect) {
      for (const t of state.tabs) if (isCreated(t.id)) void browserHide(t.id);
      return;
    }

    if (!isCreated(tab.id)) {
      // Mark created before the await so a concurrent reconcile (interval)
      // can't open a second native layer for the same tab.
      markCreated(tab.id);
      lastNav.current.set(tab.id, tab.navSeq);
      // Rail browser is narrow → request mobile views (iPhone Safari UA).
      void browserOpen(tab.id, tab.url, rect, true).catch(() => {
        unmarkCreated(tab.id);
        lastNav.current.delete(tab.id);
      });
    } else {
      void browserSetBounds(tab.id, rect);
      if ((lastNav.current.get(tab.id) ?? 0) < tab.navSeq) {
        lastNav.current.set(tab.id, tab.navSeq);
        void browserNavigate(tab.id, tab.url);
      }
      void browserShow(tab.id);
    }

    // Every other live tab is off-screen — hide its native layer.
    for (const t of state.tabs) {
      if (t.id !== tab.id && isCreated(t.id)) void browserHide(t.id);
    }
  }, []);

  const tabsKey = tabs.map((t) => `${t.id}:${t.navSeq}:${t.url}`).join("|");

  // Drive the webview whenever tab state — or whether the hole is covered by an
  // overlay — changes. When the hole is hidden its rect goes zero-size, so
  // reconcile hides the native layer (it floats above React and would
  // otherwise paint over the search face / tab switcher).
  useEffect(() => {
    reconcile();
  }, [reconcile, activeId, tabsKey, showHole]);

  // Keep the webview pinned through layout changes the store doesn't see.
  useEffect(() => {
    const el = holeRef.current;
    const ro = new ResizeObserver(() => reconcile());
    if (el) ro.observe(el);
    const onResize = () => reconcile();
    window.addEventListener("resize", onResize);
    const iv = window.setInterval(reconcile, 400);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      window.clearInterval(iv);
    };
  }, [reconcile]);

  // Hide every native layer when the browser panel unmounts.
  useEffect(
    () => () => {
      for (const t of getBrowserState().tabs) if (isCreated(t.id)) void browserHide(t.id);
    },
    [],
  );

  // Fold native nav/load state back into the store.
  useEffect(() => {
    let un: (() => void) | undefined;
    void onBrowserState(applyBrowserState).then((f) => {
      un = f;
    });
    return () => un?.();
  }, []);

  // ── Actions ──────────────────────────────────────────────────────────────
  const doSearch = (query: string) => {
    if (!active) return;
    pushRecentSearch(query);
    go(active.id, query);
    setSearchOpen(false);
    setAgentOpen(false);
  };

  const doBrowseForMe = (query: string) => {
    pushRecentSearch(query);
    setAgentGoal(query);
    setAgentOpen(true);
    setSearchOpen(false);
  };

  const createTab = () => {
    newTab();
    setSearchOpen(false);
    setAgentOpen(false);
    setTabSwitcherOpen(false);
  };

  const tab = active;
  const created = tab != null && isCreated(tab.id);

  return (
    <div className="relative h-full flex flex-col bg-bg-1 overflow-hidden">
      {/* Toolbar — back · forward · reload · address · tabs · new-tab. */}
      <div className="flex items-center gap-0.5 h-10 px-1.5 border-b border-line-soft flex-shrink-0 bg-bg-1">
        <IconBtn
          label="Back"
          onClick={() => active && back(active.id)}
          disabled={!created}
        >
          <ArrowLeft className="h-4 w-4" />
        </IconBtn>
        <IconBtn
          label="Forward"
          onClick={() => active && forward(active.id)}
          disabled={!created}
        >
          <ArrowRight className="h-4 w-4" />
        </IconBtn>
        <IconBtn
          label={tab?.loading ? "Stop" : "Reload"}
          onClick={() => active && reload(active.id)}
          disabled={!tab?.url}
        >
          <RotateCw
            className={`h-4 w-4${tab?.loading ? " animate-spin" : ""}`}
          />
        </IconBtn>

        {/* Address — tap to open the search face to type a query or URL. */}
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="flex-1 min-w-0 flex items-center gap-2 h-7 px-2.5 rounded-md bg-bg-2 border border-line-soft text-left hover:bg-bg-3/50 transition-colors"
        >
          {tab?.url ? (
            <Globe className="h-3.5 w-3.5 flex-shrink-0 text-text-4" />
          ) : (
            <Search className="h-3.5 w-3.5 flex-shrink-0 text-text-4" />
          )}
          <span
            className={`flex-1 min-w-0 truncate text-[12px] ${
              tab?.url ? "text-text-1" : "text-text-4"
            }`}
          >
            {tab?.url ? hostOf(tab.url) : "Search or enter address"}
          </span>
        </button>

        <IconBtn label="Tabs" onClick={() => setTabSwitcherOpen(true)}>
          <span className="relative flex items-center justify-center">
            <SquareStack className="h-4 w-4" />
            {tabs.length > 1 && (
              <span className="absolute -top-2 -right-2.5 min-w-[14px] h-[14px] px-1 flex items-center justify-center rounded-full bg-accent text-[color:var(--color-accent-foreground)] text-[9px] font-semibold leading-none">
                {tabs.length}
              </span>
            )}
          </span>
        </IconBtn>
        <IconBtn label="New tab" onClick={createTab}>
          <Plus className="h-4 w-4" />
        </IconBtn>
      </div>

      {/* Page body — native webview hole above, agent panel below. The hole is a
          flex child, so opening the agent panel shrinks it and reconcile()
          repositions the native webview into the smaller region above. */}
      <div className="flex-1 min-h-0 flex flex-col bg-bg-content">
        <div
          ref={holeRef}
          className="flex-1 min-h-0"
          style={showHole ? undefined : { display: "none" }}
        />
        {agentOpen && (
          <RailBrowserAgent
            key={agentGoal ?? "manual"}
            tabId={active?.id ?? null}
            initialGoal={agentGoal}
            onClose={() => setAgentOpen(false)}
          />
        )}
      </div>

      {/* Search face — covers the page chrome above. */}
      {showSearch && (
        <ArcSearchOverlay
          recents={recents}
          engine={engine}
          canClose={Boolean(active?.url)}
          onSearch={doSearch}
          onBrowseForMe={doBrowseForMe}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {/* Tab switcher — covers everything. */}
      {tabSwitcherOpen && (
        <BrowserTabSwitcher
          tabs={tabs}
          activeId={activeId}
          onSelect={(id) => {
            setActiveTab(id);
            setTabSwitcherOpen(false);
          }}
          onClose={() => setTabSwitcherOpen(false)}
          onNewTab={createTab}
          onCloseTab={(id) => closeTab(id)}
        />
      )}
    </div>
  );
}
