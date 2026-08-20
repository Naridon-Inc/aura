// In-app browser as a first-class WORKPANE TAB (superset's browser pane, in
// Aura's Tauri stack). Distinct from the rail's Arc-style mobile browser
// (rightrail/RailBrowser): this is a desktop-chrome browser you open as a
// content tab — a top address bar (back / forward / reload + url), the native
// webview below, and a New-tab / close affordance — so you can preview a
// running service or browse alongside your code, and open as many as you want.
//
// The page is a REAL WebKit child webview owned by Rust (lib/browserEngine.ts),
// floating ABOVE the React DOM. We render chrome + a transparent "hole" and pin
// the webview to it. Because only the ACTIVE tab in a leaf is mounted
// (WorkSurface unmounts inactive tab bodies), the webview must OUTLIVE the
// component: on unmount we `browserHide` (not close) so switching tabs keeps
// the live page, and a central reaper (`reapBrowserTabs`, driven by WorkSurface
// from the set of browser ids still in the layout) is the only thing that
// `browserClose`s a webview — when its tab is actually gone.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Globe, RotateCw, Search, X } from "lucide-react";

import {
  browserBack,
  browserClose,
  browserForward,
  browserHide,
  browserNavigate,
  browserOpen,
  browserReload,
  browserSetBounds,
  browserShow,
  normalizeUrl,
  onBrowserState,
  type BrowserRect,
} from "../../lib/browserEngine";
import {
  clearBrowserTabMeta,
  setBrowserTabMeta,
} from "../../lib/browserTabTitles";

// ── Native-webview registry ──────────────────────────────────────────────
//
// One entry per LIVE webview, keyed by tab id, holding the url the native
// layer is currently on. Survives component unmount (tab switch) so a remount
// re-attaches instead of reopening — and so the reaper can tell a
// switched-away tab (still in the layout) from a closed one (gone).
const registry = new Map<string, { url: string }>();

function isCreated(id: string): boolean {
  return registry.has(id);
}
function createdUrl(id: string): string | undefined {
  return registry.get(id)?.url;
}
function markCreated(id: string, url: string): void {
  registry.set(id, { url });
}
function setCreatedUrl(id: string, url: string): void {
  const e = registry.get(id);
  if (e) e.url = url;
}
function unmarkCreated(id: string): void {
  registry.delete(id);
}

/** Close (destroy) every live browser webview whose tab is no longer present
 *  in the layout. Called by WorkSurface whenever the set of open browser tab
 *  ids changes — the single place a browser webview is torn down. */
export function reapBrowserTabs(activeIds: Set<string>): void {
  for (const id of Array.from(registry.keys())) {
    if (!activeIds.has(id)) {
      void browserClose(id).catch(() => {});
      registry.delete(id);
      clearBrowserTabMeta(id);
    }
  }
}

/** Hole rect in logical (CSS) pixels, or null when the hole isn't visible —
 *  a `display:none`/zero-size parent is our signal to hide the native webview
 *  instead of leaving it floating over other content. */
function visibleRect(el: HTMLDivElement | null): BrowserRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

export function BrowserTab({
  tabId,
  initialUrl,
  onNewTab,
  onClose,
}: {
  tabId: string;
  initialUrl?: string;
  onNewTab?: () => void;
  onClose?: () => void;
}) {
  // Restore the live url on remount (tab switch) from the registry; only fall
  // back to the initial url for a genuinely fresh tab.
  const [url, setUrl] = useState<string>(
    () =>
      createdUrl(tabId) ?? (initialUrl ? normalizeUrl(initialUrl) : "") ?? "",
  );
  const [input, setInput] = useState<string>(url);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);

  const holeRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Read in the native-state listener (subscribed once) without resubscribing
  // on every keystroke / navigation.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const urlRef = useRef(url);
  urlRef.current = url;

  // The one place that drives the native webview for this tab.
  const reconcile = useCallback(() => {
    const rect = visibleRect(holeRef.current);
    // No url (blank start page) or hole not visible → hide the webview.
    if (!url || !rect) {
      if (isCreated(tabId)) void browserHide(tabId);
      return;
    }
    if (!isCreated(tabId)) {
      // Mark before the await so a concurrent reconcile (interval) can't open
      // a second native layer for the same tab.
      markCreated(tabId, url);
      void browserOpen(tabId, url, rect).catch(() => unmarkCreated(tabId));
    } else {
      void browserSetBounds(tabId, rect);
      if (createdUrl(tabId) !== url) {
        setCreatedUrl(tabId, url);
        void browserNavigate(tabId, url);
      }
      void browserShow(tabId);
    }
  }, [tabId, url]);

  // Drive the webview whenever the url changes.
  useEffect(() => {
    reconcile();
  }, [reconcile]);

  // Keep the webview pinned through layout changes the url doesn't see.
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

  // Hide (never close) the webview when this tab body unmounts — a tab switch
  // must keep the live page. The reaper closes it if the tab is truly gone.
  useEffect(
    () => () => {
      if (isCreated(tabId)) void browserHide(tabId);
    },
    [tabId],
  );

  // Fold native nav/load state (title, redirects, back/forward) back in.
  // Subscribed ONCE per tab — reads live `editing`/`url` via refs.
  useEffect(() => {
    let un: (() => void) | undefined;
    void onBrowserState((ev) => {
      if (ev.tabId !== tabId) return;
      setLoading(ev.loading);
      const nextTitle = ev.title ?? "";
      if (ev.url) {
        setCreatedUrl(tabId, ev.url);
        setUrl(ev.url);
        // Don't clobber the address bar while the user is typing in it.
        if (!editingRef.current) setInput(ev.url);
      }
      setBrowserTabMeta(tabId, {
        title: nextTitle,
        url: ev.url || urlRef.current,
        loading: ev.loading,
      });
    }).then((f) => {
      un = f;
    });
    return () => un?.();
  }, [tabId]);

  const created = isCreated(tabId) && Boolean(url);

  const go = (raw: string) => {
    const dest = normalizeUrl(raw);
    if (!dest) return;
    setInput(dest);
    setUrl(dest);
    setEditing(false);
    inputRef.current?.blur();
  };

  return (
    <div className="h-full w-full flex flex-col bg-bg-content min-h-0 min-w-0">
      {/* Address bar — back / forward / reload, the url field, new-tab + close. */}
      <div className="flex items-center gap-1 h-9 px-2 flex-shrink-0 border-b border-line-soft bg-bg-1">
        <ChromeBtn title="Back" disabled={!created} onClick={() => browserBack(tabId)}>
          <ArrowLeft className="h-3.5 w-3.5" />
        </ChromeBtn>
        <ChromeBtn title="Forward" disabled={!created} onClick={() => browserForward(tabId)}>
          <ArrowRight className="h-3.5 w-3.5" />
        </ChromeBtn>
        <ChromeBtn
          title={loading ? "Stop" : "Reload"}
          disabled={!created}
          onClick={() => browserReload(tabId)}
        >
          <RotateCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </ChromeBtn>

        <div className="flex-1 min-w-0 flex items-center gap-2 h-6 px-2.5 rounded-full bg-bg-2 border border-line-soft focus-within:border-accent">
          {loading ? (
            <RotateCw className="h-3 w-3 flex-shrink-0 text-text-4 animate-spin" />
          ) : url ? (
            <Globe className="h-3 w-3 flex-shrink-0 text-text-4" />
          ) : (
            <Search className="h-3 w-3 flex-shrink-0 text-text-4" />
          )}
          <input
            ref={inputRef}
            value={input}
            spellCheck={false}
            placeholder="Search or enter address"
            onFocus={(e) => {
              setEditing(true);
              e.currentTarget.select();
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                go(input);
              } else if (e.key === "Escape") {
                setInput(url);
                inputRef.current?.blur();
              }
            }}
            className="flex-1 min-w-0 bg-transparent outline-none text-base text-text-1 placeholder:text-text-4"
          />
        </div>

        {onNewTab && (
          <ChromeBtn title="New browser tab" onClick={onNewTab}>
            <span className="text-lg leading-none">+</span>
          </ChromeBtn>
        )}
        {onClose && (
          <ChromeBtn title="Close tab" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </ChromeBtn>
        )}
      </div>

      {/* Page body — the native webview always pins to this hole. The blank
          start face is an overlay INSIDE the hole (not a separate branch) so
          the hole element, and thus its measured rect, exists from mount
          onward. That keeps the native bounds stable from the very first
          navigation and stops a url→no-url flip from remounting the hole. */}
      <div ref={holeRef} className="flex-1 min-h-0 min-w-0 relative">
        {!url && (
          <button
            type="button"
            onClick={() => inputRef.current?.focus()}
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-text-4 select-none"
          >
            <Globe className="h-7 w-7 opacity-40" />
            <span className="text-base">Enter an address to start browsing</span>
          </button>
        )}
      </div>
    </div>
  );
}

// Compact chrome button — matches the sidebar-header / topbar icon language.
function ChromeBtn({
  children,
  title,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="w-[22px] h-[22px] rounded flex items-center justify-center text-text-3 transition-colors disabled:opacity-30 disabled:pointer-events-none hover:bg-state-hover hover:text-text-1"
    >
      {children}
    </button>
  );
}
