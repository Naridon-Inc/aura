// The in-app browser shell — an Arc-Search-style mobile experience that lives
// entirely inside the rail (no detach-to-window: a separate OS window can't
// host the rail's native webview cleanly and broke "inside the sidebar area").
//
// Two faces:
//   • Search face (ArcSearchOverlay) — shown for a fresh tab or when the user
//     taps the address pill: a search field over a list of "Browse for me"
//     suggestions. The native webview is hidden here (no hole rendered).
//   • Page face — a slim top address pill, the native webview hole, and a
//     docked mobile control bar (BrowserBottomBar) with the card-stack tab
//     switcher, new-tab, expand controls, and the Aura⇄Google engine toggle.
//
// The native WebKit webview (owned by Rust, see lib/browserEngine.ts) floats
// ABOVE the React DOM, so this component pins it to the hole and HIDES it
// whenever the hole isn't rendered (search face, tab switcher, or a
// `display:none` parent). `reconcile()` is the single place that drives it.

import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, RotateCw, Search } from "lucide-react";

import { RailBrowserAgent } from "./RailBrowserAgent";
import { ArcSearchOverlay } from "./browser/ArcSearchOverlay";
import { BrowserBottomBar } from "./browser/BrowserBottomBar";
import { BrowserTabSwitcher } from "./browser/BrowserTabSwitcher";
import {
  browserHide,
  browserNavigate,
  browserOpen,
  browserSetBounds,
  browserShow,
  clearAnnotator,
  hostOf,
  installAnnotator,
  onBrowserState,
  readAnnotations,
  type BrowserRect,
} from "../../lib/browserEngine";
import { insertIntoComposer } from "../../lib/composerBridge";
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

export function RailBrowser() {
  const { tabs, activeId } = useBrowserStore();
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const recents = useRecentSearches();

  const holeRef = useRef<HTMLDivElement>(null);
  // Last navSeq we navigated each tab to — so a server redirect (which updates
  // url without bumping navSeq) is never echoed back as a fresh navigation.
  const lastNav = useRef<Map<string, number>>(new Map());

  const [engine, setEngineState] = useState<Engine>(readEngine);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  // Non-null = "Browse for me" was launched with this goal (auto-runs). null =
  // the agent panel was opened manually for the user to type a goal.
  const [agentGoal, setAgentGoal] = useState<string | null>(null);
  // Agentation: click-to-annotate mode + the live pin count (polled from the
  // page while on). The annotations themselves live in the page; we read them
  // on demand at attach time.
  const [annotating, setAnnotating] = useState(false);
  const [annCount, setAnnCount] = useState(0);

  const setEngine = (e: Engine) => {
    setEngineState(e);
    try {
      localStorage.setItem(ENGINE_KEY, e);
    } catch {
      /* ignore */
    }
  };

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
      void browserOpen(tab.id, tab.url, rect).catch(() => {
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

  // Drive the webview whenever tab state changes.
  useEffect(() => {
    reconcile();
  }, [reconcile, activeId, tabsKey]);

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

  // ── Faces ──────────────────────────────────────────────────────────────────
  // A fresh tab (no URL) shows the search face; the agent face wins over it so
  // "Browse for me" from the start page swaps straight to the trace.
  const onStartPage = active != null && !active.url;
  const showSearch = (onStartPage || searchOpen) && !agentOpen;
  const showHole = !showSearch && !tabSwitcherOpen;

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

  const openManualAgent = () => {
    setAgentGoal(null);
    setAgentOpen(true);
  };

  const createTab = () => {
    newTab();
    setSearchOpen(false);
    setAgentOpen(false);
    setTabSwitcherOpen(false);
  };

  // ── Agentation ─────────────────────────────────────────────────────────────
  const activeId2 = active?.id ?? null;
  const activeUrl = active?.url ?? "";
  const activeNav = active?.navSeq ?? 0;

  const toggleAnnotate = useCallback(() => {
    if (!activeId2) return;
    setAnnotating((on) => {
      if (on) {
        void clearAnnotator(activeId2);
      } else {
        void installAnnotator(activeId2);
      }
      setAnnCount(0);
      return !on;
    });
  }, [activeId2]);

  const attachAnnotations = useCallback(async () => {
    if (!activeId2) return;
    const anns = await readAnnotations(activeId2);
    if (anns.length === 0) return;
    const lines = anns.map(
      (a) =>
        `${a.n}. <${a.tag}> ${a.selector}${a.text ? ` — "${a.text}"` : ""}`,
    );
    const block = [
      `Page elements I marked on ${activeUrl || "the in-app browser"}:`,
      ...lines,
    ].join("\n");
    insertIntoComposer(block);
    void clearAnnotator(activeId2);
    setAnnotating(false);
    setAnnCount(0);
  }, [activeId2, activeUrl]);

  // Poll the page for the live pin count while annotating, so the Attach badge
  // tracks clicks without a page→app IPC channel (untrusted pages have none).
  useEffect(() => {
    if (!annotating || !activeId2) return;
    let alive = true;
    const iv = setInterval(() => {
      void readAnnotations(activeId2).then((a) => {
        if (alive) setAnnCount(a.length);
      });
    }, 800);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [annotating, activeId2]);

  // A fresh document (back / forward / reload / address-bar nav) drops the
  // injected script, so re-install it after the new page settles.
  useEffect(() => {
    if (!annotating || !activeId2 || !activeUrl) return;
    const t = setTimeout(() => void installAnnotator(activeId2), 400);
    return () => clearTimeout(t);
  }, [annotating, activeId2, activeUrl, activeNav]);

  // Leave annotate mode whenever the page isn't actually on screen (search face,
  // tab switcher, agent panel, or a start-page tab) — the user can't click what
  // they can't see, and the stale script shouldn't linger.
  useEffect(() => {
    if (annotating && (!showHole || !activeUrl)) {
      if (activeId2) void clearAnnotator(activeId2);
      setAnnotating(false);
      setAnnCount(0);
    }
  }, [annotating, showHole, activeUrl, activeId2]);

  const tab = active;
  const created = tab != null && isCreated(tab.id);

  return (
    <div className="relative h-full flex flex-col bg-bg-1 overflow-hidden">
      {/* Slim address pill — tap to open the search face. */}
      <button
        type="button"
        onClick={() => setSearchOpen(true)}
        className="flex items-center gap-2 h-9 mx-2 mt-2 mb-1 px-3 rounded-full bg-bg-2 border border-line-soft text-left hover:bg-bg-3/60 transition-colors flex-shrink-0"
      >
        {tab?.loading ? (
          <RotateCw className="h-3.5 w-3.5 flex-shrink-0 text-text-3 animate-spin" />
        ) : tab?.url ? (
          <Globe className="h-3.5 w-3.5 flex-shrink-0 text-text-3" />
        ) : (
          <Search className="h-3.5 w-3.5 flex-shrink-0 text-text-4" />
        )}
        <span
          className={`flex-1 min-w-0 truncate text-[12.5px] ${
            tab?.url ? "text-text-1" : "text-text-4"
          }`}
        >
          {tab?.url ? hostOf(tab.url) : "Search or enter address"}
        </span>
      </button>

      {/* Page body — native webview hole above, agent panel below. The hole is a
          flex child, so opening the agent panel shrinks it and reconcile()
          repositions the native webview into the smaller region above. */}
      <div className="flex-1 min-h-0 flex flex-col bg-bg-content">
        {showHole ? (
          <div ref={holeRef} className="flex-1 min-h-0" />
        ) : (
          <div className="flex-1 min-h-0" />
        )}
        {agentOpen && (
          <RailBrowserAgent
            key={agentGoal ?? "manual"}
            tabId={active?.id ?? null}
            initialGoal={agentGoal}
            onClose={() => setAgentOpen(false)}
          />
        )}
      </div>

      {/* Docked mobile controls. */}
      <BrowserBottomBar
        tabCount={tabs.length}
        engine={engine}
        loading={Boolean(tab?.loading)}
        canBack={created}
        canForward={created}
        canReload={Boolean(tab?.url)}
        onToggleTabs={() => setTabSwitcherOpen(true)}
        onNewTab={createTab}
        onSetEngine={setEngine}
        onBack={() => active && back(active.id)}
        onForward={() => active && forward(active.id)}
        onReload={() => active && reload(active.id)}
        onBrowseForMe={openManualAgent}
        annotating={annotating}
        annotationCount={annCount}
        canAnnotate={Boolean(tab?.url) && showHole}
        onToggleAnnotate={toggleAnnotate}
        onAttachAnnotations={() => void attachAnnotations()}
      />

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

      {/* Card-stack tab switcher — covers everything. */}
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
