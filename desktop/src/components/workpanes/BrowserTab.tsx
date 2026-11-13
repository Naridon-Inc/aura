// In-app browser as a first-class WORKPANE TAB — the only place the browser
// lives (the panel browser is gone). A desktop-chrome browser you open as a
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
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, Search, X } from "lucide-react";
import { Button } from "../ui/button";
import { AsciiSpinner } from "../ui/ascii-spinner";
import "../ui/browser-tab.css";

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
import { isWithheld } from "../../lib/nativeSurfacePlacement";
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
  // A page drawn over the work surface leaves the hole full size, and the
  // native view would go on painting over the page; the shell marks the
  // covered part `inert` (see `isWithheld`).
  if (isWithheld(el)) return null;
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
    <div className="ui-browser-tab">
      {/* Address bar — back / forward / reload, the url field, new-tab + close. */}
      <div className="ui-browser-bar">
        <ChromeBtn title="Back" disabled={!created} onClick={() => browserBack(tabId)}>
          <ArrowLeft />
        </ChromeBtn>
        <ChromeBtn title="Forward" disabled={!created} onClick={() => browserForward(tabId)}>
          <ArrowRight />
        </ChromeBtn>
        <ChromeBtn
          title={loading ? "Stop" : "Reload"}
          disabled={!created}
          onClick={() => browserReload(tabId)}
        >
          {loading ? <AsciiSpinner size={14} /> : <RotateCw />}
        </ChromeBtn>

        <div className="ui-browser-address">
          {loading ? (
            <AsciiSpinner size={12} />
          ) : url ? (
            <Globe />
          ) : (
            <Search />
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
            className="ui-browser-input"
          />
        </div>

        {onNewTab && (
          <ChromeBtn title="New browser tab" onClick={onNewTab}>
            <Plus />
          </ChromeBtn>
        )}
        {onClose && (
          <ChromeBtn title="Close tab" onClick={onClose}>
            <X />
          </ChromeBtn>
        )}
      </div>

      {/* Page body — the native webview always pins to this hole. The blank
          start face is an overlay INSIDE the hole (not a separate branch) so
          the hole element, and thus its measured rect, exists from mount
          onward. That keeps the native bounds stable from the very first
          navigation and stops a url→no-url flip from remounting the hole. */}
      <div ref={holeRef} className="ui-browser-hole">
        {!url && (
          <button
            type="button"
            onClick={() => inputRef.current?.focus()}
            className="ui-browser-start"
          >
            <Globe />
            <span>Enter an address to start browsing</span>
          </button>
        )}
      </div>
    </div>
  );
}

// The bar's icon buttons are the shared ghost button at the small icon size.
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
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={title}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
