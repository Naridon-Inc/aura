// Shared sandboxed-plugin iframe + bridge mount.
//
// Used by BOTH the narrow right-rail panel (RightRail.PluginPanelFrame)
// and the full-surface mini-app (WorkSurface `app` pane). One sandbox
// path, no drift:
//
//   • Panel/app HTML is read through the Rust-jailed asset reader
//     (`loadPanelHtml` → `plugin_asset_read`, no capability needed — the
//     host is loading the plugin's own code) and mounted as `srcDoc`.
//   • `sandbox="allow-scripts"` and nothing else: the frame's window
//     origin is opaque ("null"), so it gets no same-origin DOM/storage
//     access to the shell. The postMessage bridge is its ONLY channel to
//     the host, and every host call is capability-checked in the bridge
//     and re-checked in Rust.
//
// The only thing that differs between a rail panel and a full app is the
// iframe sizing (`className`) — everything security-relevant is shared
// here so the two surfaces can never diverge on sandboxing.

import { useEffect, useRef, useState } from "react";

import { attachPanelBridge, loadPanelHtml } from "../../lib/pluginRuntime";

type Props = {
  pluginId: string;
  /** Panel or app id — surfaced as a data attribute for debugging. */
  surfaceId: string;
  title: string;
  /** HTML entry, relative to the plugin install dir. */
  entry: string;
  /** Iframe sizing classes — rail panels and full apps fill differently. */
  className?: string;
};

export function PluginSandboxFrame({
  pluginId,
  surfaceId,
  title,
  entry,
  className,
}: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const detachRef = useRef<(() => void) | null>(null);
  const retryRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setFailed(false);
    void loadPanelHtml(pluginId, entry).then((body) => {
      if (cancelled) return;
      if (body == null) setFailed(true);
      else setHtml(body);
    });
    return () => {
      cancelled = true;
    };
  }, [pluginId, entry]);

  // Detach the bridge + stop any pending attach retry on unmount.
  useEffect(
    () => () => {
      if (retryRef.current) clearInterval(retryRef.current);
      retryRef.current = null;
      detachRef.current?.();
      detachRef.current = null;
    },
    [],
  );

  if (failed) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-[11px] text-text-3 px-4 text-center">
        {title}: failed to load ({pluginId})
      </div>
    );
  }
  if (html === null) {
    return <div className="flex-1 min-h-0" aria-busy="true" />;
  }

  const attach = (iframe: HTMLIFrameElement) => {
    detachRef.current?.();
    detachRef.current = attachPanelBridge(iframe, pluginId);
    if (detachRef.current || retryRef.current) return;
    // Plugin not running yet (reconcile in flight) — retry briefly.
    let tries = 0;
    retryRef.current = setInterval(() => {
      tries += 1;
      const d = attachPanelBridge(iframe, pluginId);
      if (d || tries >= 20) {
        if (retryRef.current) clearInterval(retryRef.current);
        retryRef.current = null;
        detachRef.current = d;
      }
    }, 250);
  };

  return (
    <iframe
      title={`${title} · ${pluginId}`}
      data-plugin-id={pluginId}
      data-surface-id={surfaceId}
      srcDoc={html}
      sandbox="allow-scripts"
      // Attach on load: the frame's inline scripts run during parse, so
      // its message listener is registered before the bridge's
      // handshake/hello goes out.
      onLoad={(e) => attach(e.currentTarget)}
      className={className ?? "flex-1 min-h-0 w-full border-0"}
      style={{ background: "var(--color-bg-1)" }}
    />
  );
}
