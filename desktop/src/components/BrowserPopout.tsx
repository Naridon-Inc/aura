// A single in-app browser tab popped out into its own OS window. The native
// WebKit webview is the SAME one the rail was hosting — `browserReparent` moves
// it under this popout window with its live page intact (scroll, login session,
// media all preserved). The rail has already forgotten the tab (`detachTab`),
// so only this window drives it now.
//
// Mirrors RailBrowser's "hole + reconcile" approach but for one tab: render the
// chrome (a back/forward/reload + address toolbar) and a transparent hole, then
// keep the native webview pinned over the hole. The first reconcile reparents;
// later ones just track the hole's rect.

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";

import {
  browserBack,
  browserClose,
  browserForward,
  browserNavigate,
  browserReload,
  browserReparent,
  browserSetBounds,
  browserShow,
  normalizeUrl,
  onBrowserState,
  type BrowserRect,
} from "../lib/browserEngine";

/** Hole rect in logical pixels, or null while it has no real size. */
function visibleRect(el: HTMLDivElement | null): BrowserRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

export function BrowserPopout({ tabId, initialUrl }: { tabId: string; initialUrl?: string }) {
  const holeRef = useRef<HTMLDivElement>(null);
  // `attempted` guards against a double reparent; `ready` gates positioning
  // until the reparent actually landed (set_bounds before then would aim at
  // the old parent window's coordinate space).
  const attempted = useRef(false);
  const ready = useRef(false);

  const [url, setUrl] = useState(initialUrl ?? "");
  const [loading, setLoading] = useState(false);
  const [addr, setAddr] = useState(initialUrl ?? "");
  const [addrFocused, setAddrFocused] = useState(false);

  const windowLabel = getCurrentWindow().label;

  // Mirror the live URL into the address bar unless the user is typing.
  useEffect(() => {
    if (!addrFocused) setAddr(url);
  }, [url, addrFocused]);

  useEffect(() => {
    const reconcile = () => {
      const rect = visibleRect(holeRef.current);
      if (!rect) return;
      if (!attempted.current) {
        attempted.current = true;
        void browserReparent(tabId, windowLabel, rect)
          .then(() => {
            ready.current = true;
          })
          .catch(() => {
            // Retry on the next tick if the reparent failed (window not ready).
            attempted.current = false;
          });
      } else if (ready.current) {
        void browserSetBounds(tabId, rect);
        void browserShow(tabId);
      }
    };

    reconcile();
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
      // The window owns the webview now — close it on teardown so it doesn't
      // outlive the popout (best-effort; a hard OS close destroys it anyway).
      void browserClose(tabId).catch(() => {});
    };
  }, [tabId, windowLabel]);

  // Reflect native nav/load state for this tab.
  useEffect(() => {
    let un: (() => void) | undefined;
    void onBrowserState((ev) => {
      if (ev.tabId !== tabId) return;
      if (ev.url) setUrl(ev.url);
      setLoading(ev.loading);
    }).then((f) => {
      un = f;
    });
    return () => un?.();
  }, [tabId]);

  const submitAddr = (e: React.FormEvent) => {
    e.preventDefault();
    const target = normalizeUrl(addr);
    if (!target) return;
    void browserNavigate(tabId, target);
    setLoading(true);
    (e.target as HTMLFormElement).querySelector("input")?.blur();
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg-1 overflow-hidden">
      <form
        onSubmit={submitAddr}
        className="flex items-center gap-1 h-9 px-1.5 border-b border-line-soft flex-shrink-0"
      >
        <NavBtn label="Back" onClick={() => void browserBack(tabId)}>
          <ArrowLeft className="h-3.5 w-3.5" />
        </NavBtn>
        <NavBtn label="Forward" onClick={() => void browserForward(tabId)}>
          <ArrowRight className="h-3.5 w-3.5" />
        </NavBtn>
        <NavBtn label="Reload" onClick={() => void browserReload(tabId)}>
          <RotateCw className={`h-3.5 w-3.5${loading ? " animate-spin" : ""}`} />
        </NavBtn>
        <div className="relative flex-1 min-w-0">
          <input
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            onFocus={(e) => {
              setAddrFocused(true);
              e.target.select();
            }}
            onBlur={() => setAddrFocused(false)}
            placeholder="Search or enter address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="w-full h-6 pl-2.5 pr-2 rounded-full bg-bg-2 text-[12px] text-text-1 placeholder:text-text-4 outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </form>

      {/* The reparented native webview is positioned over this hole. */}
      <div className="flex-1 min-h-0 bg-bg-content">
        <div ref={holeRef} className="w-full h-full" />
      </div>
    </div>
  );
}

function NavBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-md text-text-3 hover:text-text-1 hover:bg-bg-3 transition-colors"
    >
      {children}
    </button>
  );
}
