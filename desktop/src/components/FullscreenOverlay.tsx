// FullscreenOverlay — an app-level focus surface for wide content the ADE v2
// layout can't fit in the squeezed center column: the dialog's dim and panel,
// inset 8px from the viewport (rounded, shadowed) rather than centred or
// edge-to-edge.
//
// While the overlay is open it owns the whole window, so its Esc/close chip
// takes the top-left corner — and we drop the native macOS traffic lights DOWN
// below the top bar for the duration (see lib/trafficLights), restoring them on
// close. That's why the close chip can sit flush in the corner instead of being
// pushed to the side to clear the lights.
//
// The top bar carries the esc/close chip, an optional tab strip (short pill
// tabs *or* a full-height step strip — the header stretches to
// fit), and right-aligned actions. There is deliberately NO title slot: the
// wizard/focus surface never shows a title — its tabs carry the context, and a
// redundant "Session"/"Task"/"Pull request" label is noise. Below the bar: a
// full-width scrollable body and an optional sticky right-aligned footer.
//
// Adopters: the PR detail view (PRDetailPane) and the create-task wizard.

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { captureFocus } from "../lib/focusReturn";
import { cn } from "../lib/utils";
import { SurfaceHeader } from "./ui/SurfaceHeader";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";
import "./ui/focus-overlay.css";
import {
  dropTrafficLightsForOverlay,
  restoreTrafficLights,
} from "../lib/trafficLights";

type FullscreenOverlayProps = {
  /** Close handler — wired to both the esc chip and the Escape key. */
  onClose: () => void;
  /** Step-tab strip rendered inline in the top bar (e.g. Overview/Files). */
  tabs?: ReactNode;
  /** Secondary controls pinned to the right of the top bar. */
  actions?: ReactNode;
  /** Sticky bottom action bar (right-aligned). Omitted when falsy. */
  footer?: ReactNode;
  /** Body content. Lives in a flex-col so `flex-1` children fill height. */
  children: ReactNode;
  /** Extra classes for the body region. */
  contentClassName?: string;
  /** Close-chip keyboard hint. Default "esc". */
  closeHint?: string;
  /** Render in-flow filling the parent (no portal, no backdrop, no native
   *  traffic-light manipulation) instead of as a window-owning modal. Used
   *  when the surface is detached into its own popout window — the popout
   *  chrome owns the window, so the pane is just a bare full-height panel. */
  embedded?: boolean;
};

export function FullscreenOverlay({
  onClose,
  tabs,
  actions,
  footer,
  children,
  contentClassName,
  closeHint = "Esc",
  embedded = false,
}: FullscreenOverlayProps) {
  // Hand the keyboard back to whatever opened this. Without it, closing a
  // wizard left focus on <body>, so a keyboard user who opened a row and
  // pressed Esc landed at the top of the document and had to tab through the
  // whole list again to get back to where they were. Runs once per mount and
  // restores on unmount — see lib/focusReturn for what it will and won't do.
  useEffect(() => {
    return captureFocus(
      typeof document === "undefined" ? null : document.activeElement,
      typeof document === "undefined" ? undefined : document.body,
    );
  }, []);

  // Escape closes from anywhere — the overlay owns the whole window while up,
  // so a window-level listener is safe and mirrors the esc chip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Drop the native macOS traffic lights below the top bar for the lifetime of
  // the overlay so the Esc chip can own the top-left corner; restore on close.
  // Skipped when embedded — the popout window owns its own chrome.
  useEffect(() => {
    if (embedded) return;
    dropTrafficLightsForOverlay();
    return () => restoreTrafficLights();
  }, [embedded]);

  // The panel interior (top bar + body + footer) is identical whether the
  // surface owns the window (modal) or fills a popout (embedded); only the
  // wrapper differs.
  const panel = (
    <>
      {/* The same bar every other surface wears — ui/SurfaceHeader. This one
          used to be drawn here, four pixels taller and with a heavier rule
          than the pages', which meant the app had one header idea and three
          drawings of it. The Esc chip is what a modal has that a page doesn't,
          so it rides in the leading slot; there is still no title, because the
          tabs carry the context. */}
      <SurfaceHeader
        leading={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close (Esc)"
            className="ui-focus-close"
          >
            <X />
            <Kbd>{closeHint}</Kbd>
          </Button>
        }
        tabs={tabs}
        actions={actions}
      />

      {/* Body — full panel width; flex-col so flex-1 children fill height. */}
      <div className={cn("ui-focus-body", contentClassName)}>
        {children}
      </div>

      {/* Sticky action footer, right-aligned. */}
      {footer && <footer className="ui-focus-footer">{footer}</footer>}
    </>
  );

  // Embedded: in-flow, fills the popout body. No portal/backdrop/inset — the
  // popout window's own bar is the chrome.
  if (embedded) {
    return (
      <div className="ui-focus-embedded">{panel}</div>
    );
  }

  // z-50 = the app modal layer. Mounted before the dialog stack in App.tsx so
  // dialogs / the agent gate (later in DOM, equal or higher z) stack above it.
  return createPortal(
    <div role="dialog" aria-modal="true" className="ui-focus">
      {/* Backdrop dim. No click-to-close: focus surfaces (esp. the wizard)
          hold unsaved input — Esc is the single, deliberate exit. */}
      <div className="ui-focus-backdrop" aria-hidden />

      {/* Floating panel — inset 8px from the viewport, the dialog's hairline
          and depth. The native traffic lights are dropped below this top bar
          (see the effect above), so the Esc chip sits flush in the corner. */}
      <div className="ui-focus-panel">{panel}</div>
    </div>,
    document.body,
  );
}
