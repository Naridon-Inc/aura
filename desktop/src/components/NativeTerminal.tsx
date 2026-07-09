import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { keyEventToBytes } from "../lib/nativeTerminalKeys";

/** Props are a subset of the xterm `Terminal`'s — enough to spawn a shell in
 *  the right cwd and report back the session id. The native path owns its PTY
 *  in Rust, so the xterm-only session/persistence props don't apply. */
type NativeTerminalProps = {
  cwd?: string;
  repoRoot?: string;
  instanceId?: string;
  bootCommand?: string;
  onOpened?: (ptyId: string, reconnected: boolean) => void;
  /** Fired when the native GPU surface / PTY can't be created on this machine
   *  after a couple of attempts. The parent should mount the xterm fallback so
   *  the user still gets a terminal instead of a blank hole. */
  onUnavailable?: () => void;
};

let seq = 0;

// Ids whose Rust PTY + GPU surface should survive a React unmount (a tab or
// group switch), mirroring xterm's persistent session map. A genuine tab-close
// calls releaseNativeTerminalSession() to actually tear the shell down.
const liveNativeTerms = new Set<string>();

/** Permanently close a native terminal's shell + GPU surface. The store calls
 *  this when a terminal TAB is closed — not on tab switches, which unmount the
 *  React tree but keep the session alive for reattach. No-op for ids that were
 *  never opened natively (e.g. an xterm-backed tab), so callers can fire both
 *  this and releaseTerminalSession() without knowing which engine backed it. */
export function releaseNativeTerminalSession(termId: string): void {
  if (!liveNativeTerms.has(termId)) return;
  liveNativeTerms.delete(termId);
  invoke("native_term_close", { termId }).catch(() => {});
}

const encoder = new TextEncoder();

function toBytes(text: string): number[] {
  return Array.from(encoder.encode(text));
}

/**
 * A terminal rendered by the native wgpu engine (cmd_native_term) instead of
 * xterm.js. It leaves a transparent DOM hole and asks the Rust side to
 * composite a GPU surface over that rect — the same hole + `set_bounds`
 * choreography the in-app browser uses. Keyboard/paste/wheel/focus are captured
 * on the hole and forwarded to the shell; the surface itself paints in Rust.
 */
export function NativeTerminal({
  cwd,
  repoRoot,
  instanceId,
  bootCommand,
  onOpened,
  onUnavailable,
}: NativeTerminalProps) {
  const holeRef = useRef<HTMLDivElement>(null);
  const termIdRef = useRef<string>(instanceId ?? `native-term-${(seq += 1)}`);
  // Mouse-selection drag state. `selStart` is the down position; `selecting`
  // flips true on the first move so a plain click just clears the selection.
  const selStart = useRef<{ fx: number; fy: number } | null>(null);
  const selecting = useRef(false);

  useEffect(() => {
    const hole = holeRef.current;
    if (!hole) return;
    const el: HTMLDivElement = hole; // non-null alias so nested closures keep the narrowing
    const termId = termIdRef.current;

    let cancelled = false;
    let opened = false;
    let lastBounds = "";
    let raf = 0;
    let unlistenClosed: UnlistenFn | null = null;
    // The pane is already laid out (guarded below) before we call open, so a
    // rejection here is a genuine backend failure — the GPU surface or PTY
    // couldn't be created — not a timing hiccup. Tolerate one transient retry,
    // then hand the pane to the xterm fallback rather than looping forever into
    // a blank transparent hole.
    let openFailures = 0;
    const MAX_OPEN_FAILURES = 2;

    const scale = () => window.devicePixelRatio || 1;
    function rect() {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }

    async function reconcile() {
      if (cancelled) return;
      const b = rect();
      // Skip until the pane is actually laid out — opening a 0×0 surface would
      // spawn a shell sized 1×1 and thrash on the first real resize.
      if (b.w < 2 || b.h < 2) return;

      if (!opened) {
        opened = true;
        // Reattach when the Rust side already holds this PTY — a remount after a
        // tab/group switch. `native_term_open` is idempotent (it just
        // repositions an existing surface), so we must NOT re-run the boot
        // command; we only mark the reconnection.
        const reattach = liveNativeTerms.has(termId);
        try {
          await invoke("native_term_open", {
            termId,
            cwd: cwd ?? repoRoot ?? null,
            x: b.x,
            y: b.y,
            width: b.w,
            height: b.h,
            scale: scale(),
          });
          // Register before the cancel check so an unmount mid-open still parks
          // (not closes) the session — the cleanup below keys off this set.
          liveNativeTerms.add(termId);
          if (cancelled) return;
          onOpened?.(termId, reattach);
          if (bootCommand && !reattach) {
            const cmd = bootCommand.endsWith("\n") ? bootCommand : `${bootCommand}\n`;
            window.setTimeout(() => {
              invoke("native_term_write", { termId, data: toBytes(cmd) }).catch(() => {});
            }, 250);
          }
        } catch {
          opened = false;
          openFailures += 1;
          if (openFailures >= MAX_OPEN_FAILURES) {
            // wgpu / PTY can't come up on this machine — stop retrying and let
            // the parent swap in xterm so the user still gets a shell.
            onUnavailable?.();
            return;
          }
          // Force one more attempt next frame instead of waiting for an
          // incidental resize/scroll tick.
          schedule();
          return;
        }
        lastBounds = JSON.stringify(b);
        return;
      }

      const key = JSON.stringify(b);
      if (key !== lastBounds) {
        lastBounds = key;
        invoke("native_term_set_bounds", {
          termId,
          x: b.x,
          y: b.y,
          width: b.w,
          height: b.h,
          scale: scale(),
        }).catch(() => {});
      }
    }

    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        void reconcile();
      });
    }

    void reconcile();

    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    // Capture-phase so any scrolling ancestor (panes, split views) re-aligns the
    // surface, not just the window.
    window.addEventListener("resize", schedule, true);
    window.addEventListener("scroll", schedule, true);

    listen<{ termId: string }>("native-term:closed", (evt) => {
      if (evt.payload.termId === termId) {
        // The shell itself exited (e.g. the user typed `exit`) — the session is
        // genuinely gone, so drop it from the live set and tear the surface
        // down. Won't be parked/reattached after this.
        liveNativeTerms.delete(termId);
        invoke("native_term_close", { termId }).catch(() => {});
      }
    }).then((u) => {
      if (cancelled) u();
      else unlistenClosed = u;
    });

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", schedule, true);
      window.removeEventListener("scroll", schedule, true);
      unlistenClosed?.();
      // Persist across tab/group switches like xterm: keep the Rust PTY + GPU
      // surface alive and just park it far offscreen so it stops painting over
      // whatever pane replaced it. Reattaches (repositions) on the next mount.
      // A real tab-close routes through releaseNativeTerminalSession() instead.
      if (liveNativeTerms.has(termId)) {
        invoke("native_term_set_bounds", {
          termId,
          x: -100000,
          y: -100000,
          width: 1,
          height: 1,
          scale: 1,
        }).catch(() => {});
      }
    };
  }, [cwd, repoRoot, bootCommand, onOpened, onUnavailable]);

  async function copySelection() {
    try {
      const text = await invoke<string>("native_term_copy", { termId: termIdRef.current });
      if (text) await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard denied or nothing selected — nothing to do */
    }
  }

  async function pasteClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        await invoke("native_term_write", { termId: termIdRef.current, data: toBytes(text) });
      }
    } catch {
      /* clipboard read denied — nothing to do */
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const key = e.key.toLowerCase();
    // Copy: ⌘C (macOS) or Ctrl+Shift+C (Linux). Intercept before the VT encoder
    // so Ctrl+Shift+C never leaks a SIGINT to the shell.
    const isCopy =
      (e.metaKey && key === "c" && !e.ctrlKey && !e.altKey) ||
      (e.ctrlKey && e.shiftKey && key === "c" && !e.metaKey);
    if (isCopy) {
      e.preventDefault();
      void copySelection();
      return;
    }
    // Paste: Ctrl+Shift+V (Linux). ⌘V (macOS) rides the native paste event.
    if (e.ctrlKey && e.shiftKey && key === "v" && !e.metaKey) {
      e.preventDefault();
      void pasteClipboard();
      return;
    }
    const bytes = keyEventToBytes(e.nativeEvent);
    if (bytes == null) return;
    e.preventDefault();
    invoke("native_term_write", {
      termId: termIdRef.current,
      data: toBytes(bytes),
    }).catch(() => {});
  }

  function fracFromEvent(e: React.PointerEvent): { fx: number; fy: number } {
    const el = holeRef.current;
    if (!el) return { fx: 0, fy: 0 };
    const r = el.getBoundingClientRect();
    const fx = r.width > 0 ? (e.clientX - r.left) / r.width : 0;
    const fy = r.height > 0 ? (e.clientY - r.top) / r.height : 0;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return { fx: clamp(fx), fy: clamp(fy) };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return; // left button only
    e.currentTarget.setPointerCapture(e.pointerId);
    selStart.current = fracFromEvent(e);
    selecting.current = false;
    // A fresh click dismisses the previous selection; a drag will start a new one.
    invoke("native_term_select", {
      termId: termIdRef.current,
      phase: "clear",
      fx: 0,
      fy: 0,
    }).catch(() => {});
  }

  function onPointerMove(e: React.PointerEvent) {
    const start = selStart.current;
    if (!start) return;
    const at = fracFromEvent(e);
    if (!selecting.current) {
      selecting.current = true;
      invoke("native_term_select", {
        termId: termIdRef.current,
        phase: "start",
        fx: start.fx,
        fy: start.fy,
      }).catch(() => {});
    }
    invoke("native_term_select", {
      termId: termIdRef.current,
      phase: "move",
      fx: at.fx,
      fy: at.fy,
    }).catch(() => {});
  }

  function onPointerUp(e: React.PointerEvent) {
    if (selStart.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* capture already gone */
      }
    }
    selStart.current = null;
    selecting.current = false;
  }

  function onPaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData("text");
    if (!text) return;
    e.preventDefault();
    invoke("native_term_write", {
      termId: termIdRef.current,
      data: toBytes(text),
    }).catch(() => {});
  }

  function onWheel(e: React.WheelEvent) {
    // Wheel up (deltaY < 0) scrolls back into scrollback (positive lines);
    // wheel down returns toward the live prompt.
    const lines = e.deltaY < 0 ? 3 : -3;
    invoke("native_term_scroll", { termId: termIdRef.current, lines }).catch(() => {});
  }

  function onFocus() {
    invoke("native_term_focus", { termId: termIdRef.current, focused: true }).catch(() => {});
  }

  function onBlur() {
    invoke("native_term_focus", { termId: termIdRef.current, focused: false }).catch(() => {});
  }

  return (
    <div
      ref={holeRef}
      tabIndex={0}
      role="textbox"
      aria-label="Terminal"
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onFocus={onFocus}
      onBlur={onBlur}
      data-native-term=""
      style={{
        width: "100%",
        height: "100%",
        outline: "none",
        background: "transparent",
        cursor: "text",
      }}
    />
  );
}
