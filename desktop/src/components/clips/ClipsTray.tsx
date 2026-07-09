// Clipboard tray — workspace-rail bottom button. Captures pasted
// screenshots and dragged-in files into ~/.aura/clips/ so the agents
// (Claude / Gemini / Codex) can read them by an absolute path that
// doesn't go stale when the source moves.
//
// Trigger glyph is a flat clipboard icon (stroked SVG) that sits at the
// same visual weight as the Plus / Settings icons above and below it.
// A small count badge in the top-right shows the number of stored
// clips; the rich preview lives in the hover fan, rendered into a
// document.body portal so it can never be clipped by the rail's
// overflow rules.
//
// Behaviour stack (one icon, three modes):
//   • idle       — clipboard glyph (text-3 colour when empty, text-1
//                  when content is present), with a tiny count badge
//   • hover      — portal-rendered fan shows the most recent clips
//                  scaled up so the user can read them
//   • click      — full panel listing every clip (drag, remove,
//                  add file, clear all)
//
// Drag a clip out of the panel into any text field (Composer, agent
// terminal) and we set both `text/uri-list` and `text/plain` to the
// absolute path, so a Composer drop pastes the path and a terminal
// drop types it.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type ClipEntry } from "../../lib/api";
import { removeClip, saveFilePath, useClips } from "../../lib/clipsStore";
import {
  getCachedThumbnail,
  loadThumbnail,
  subscribeThumbnail,
} from "../../lib/clipsThumbnails";

// Shared hook — fetches the clip's full data URL once, downsamples to
// a ~96px thumbnail, caches the result, and shares it across every
// thumb component that renders the same clip id. Replaces the prior
// pattern of each thumb parking a multi-MB raw data URL in its own
// useState slot.
function useClipThumbnail(clip: ClipEntry | null): string | null {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!clip || clip.kind !== "image") return;
    const unsub = subscribeThumbnail(clip.id, () => setTick((t) => t + 1));
    if (!getCachedThumbnail(clip.id)) {
      void loadThumbnail(clip.id, api.clipsReadDataUrl);
    }
    return unsub;
    // `tick` is intentionally read below — it forces a re-render when
    // the cached value lands without needing a useState mirror.
  }, [clip?.id, clip?.kind]);
  if (!clip || clip.kind !== "image") return null;
  // Touch `tick` so the dependency tracker re-runs when subscribeThumbnail
  // fires. Without this read React lints would also flag it as unused.
  void tick;
  return getCachedThumbnail(clip.id);
}

const TILE = 36;

export function ClipsTray() {
  const { entries } = useClips();
  const [hoverOpen, setHoverOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const enterTimer = useRef<number | null>(null);
  const leaveTimer = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (enterTimer.current) window.clearTimeout(enterTimer.current);
      if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    };
  }, []);

  const cancelEnter = () => {
    if (enterTimer.current) {
      window.clearTimeout(enterTimer.current);
      enterTimer.current = null;
    }
  };
  const cancelLeave = () => {
    if (leaveTimer.current) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };
  const scheduleOpen = () => {
    cancelLeave();
    if (panelOpen) return;
    cancelEnter();
    enterTimer.current = window.setTimeout(() => {
      setHoverOpen(true);
      enterTimer.current = null;
    }, 70);
  };
  const scheduleClose = () => {
    cancelEnter();
    cancelLeave();
    // Never collapse the fan while a drag is in flight — the browser
    // briefly fires mouseleave when the drag image takes over, which
    // would otherwise destroy the source mid-drag.
    if (draggingRef.current) return;
    leaveTimer.current = window.setTimeout(() => {
      setHoverOpen(false);
      leaveTimer.current = null;
    }, 140);
  };
  const onDragStateChange = (next: boolean) => {
    draggingRef.current = next;
    setDragging(next);
    if (next) cancelLeave();
    else scheduleClose();
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    for (const f of Array.from(files)) {
      const path = (f as unknown as { path?: string }).path;
      if (path) await saveFilePath(path);
    }
  };

  // We always render exactly 3 slots so the folder looks "loaded" even
  // when the tray is empty — placeholder slots animate out the same
  // way and invite a paste/drop.
  const slots: (ClipEntry | null)[] = [
    entries[0] ?? null,
    entries[1] ?? null,
    entries[2] ?? null,
  ];
  const total = entries.length;
  const fanActive = hoverOpen && !panelOpen;

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={onDrop}
      style={{ width: TILE, height: TILE }}
    >
      <button
        type="button"
        title={total === 0 ? "Clipboard tray (empty)" : `Clipboard tray — ${total} item${total === 1 ? "" : "s"}`}
        onClick={() => setPanelOpen((v) => !v)}
        className="absolute inset-0 group rounded-lg hover:bg-bg-2/60 transition-colors"
        style={{ overflow: "visible" }}
      >
        <FolderArt slots={slots} hover={fanActive} />
        {total > 0 && (
          <span
            className="absolute pointer-events-none flex items-center justify-center text-[9px] font-semibold tabular-nums"
            style={{
              top: 1,
              right: 1,
              minWidth: 14,
              height: 14,
              padding: "0 3px",
              borderRadius: 7,
              background: "var(--color-text-1)",
              color: "var(--color-bg-1)",
              zIndex: 10,
            }}
          >
            {total > 99 ? "99+" : total}
          </span>
        )}
      </button>

      {(fanActive || dragging) && (
        <FanOverlay
          anchor={wrapRef.current}
          slots={slots}
          onEnter={cancelLeave}
          onLeave={scheduleClose}
          onDragStateChange={onDragStateChange}
        />
      )}

      {panelOpen && (
        <ClipsPanel
          entries={entries}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </div>
  );
}

/* ───────────── trigger art ───────────── */

// Clipboard glyph + a single thumbnail teaser when the tray has content.
// Replaces the earlier hand-painted manila folder — that read as
// "open folder" to users expecting a clipboard tray. Now the icon
// matches the function: a clipboard with a clasp at the top, and the
// most recent clip peeks out from inside on hover.
function FolderArt({
  slots,
  hover,
}: {
  slots: (ClipEntry | null)[];
  hover: boolean;
}) {
  const hasContent = slots.some((s) => !!s);
  return (
    <span
      className="absolute pointer-events-none"
      style={{
        left: 0,
        right: 0,
        bottom: 0,
        top: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <ClipboardIcon active={hover || hasContent} />
    </span>
  );
}

function ClipboardIcon({ active }: { active: boolean }) {
  // 18×18 clipboard — outer body + top clasp + two interior rule lines.
  // Stroke colour tracks --color-text-2/3 so it sits at the same visual
  // weight as the Plus and Settings glyphs above/below it.
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      style={{
        color: active ? "var(--color-text-1)" : "var(--color-text-3)",
        transition: "color 160ms ease",
      }}
    >
      <rect
        x="5"
        y="5"
        width="14"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <rect
        x="9"
        y="3"
        width="6"
        height="4"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="var(--color-bg-1)"
      />
      <line
        x1="8.5"
        y1="11.5"
        x2="15.5"
        y2="11.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <line
        x1="8.5"
        y1="14.5"
        x2="13.5"
        y2="14.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ───────────── hover fan (portal) ───────────── */

// Rendered into document.body so it can fan out beyond the rail's
// width/overflow. Anchored to the trigger's bounding box, computed on
// open and refreshed on scroll/resize.
function FanOverlay({
  anchor,
  slots,
  onEnter,
  onLeave,
  onDragStateChange,
}: {
  anchor: HTMLElement | null;
  slots: (ClipEntry | null)[];
  onEnter: () => void;
  onLeave: () => void;
  onDragStateChange: (dragging: boolean) => void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(
    anchor ? anchor.getBoundingClientRect() : null,
  );

  useLayoutEffect(() => {
    if (!anchor) return;
    const update = () => setRect(anchor.getBoundingClientRect());
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchor]);

  if (!rect) return null;

  // Compute the fan thumb positions and clamp them inside the viewport
  // so the leftmost thumb doesn't get cropped when the trigger sits
  // hard against the left edge of the window (workspace rail).
  const W = 56;
  const H = 40;
  const SPREAD = 26;
  const slotOffsets = [-SPREAD, 0, SPREAD];
  const anchorY = rect.top - 6 - H - 14;

  // Default: fan is centered above the trigger.
  let anchorX = rect.left + rect.width / 2;
  // Find the leftmost thumb's left edge; if it goes off-screen, slide
  // the entire fan rightward until the leftmost edge clears 8px.
  const minLeft = anchorX + slotOffsets[0] - W / 2;
  if (minLeft < 8) {
    anchorX += 8 - minLeft;
  }
  // Same for the right edge against `window.innerWidth`.
  const maxRight = anchorX + slotOffsets[2] + W / 2;
  const vw = window.innerWidth;
  if (maxRight > vw - 8) {
    anchorX -= maxRight - (vw - 8);
  }

  return createPortal(
    <div
      className="fixed"
      style={{
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        zIndex: 1000,
        pointerEvents: "none",
      }}
    >
      {slots.map((clip, i) => {
        const tx = slotOffsets[i];
        const rot = (i - 1) * 14;
        // Stagger: index × 30ms, like the framer-motion reference.
        const delay = i * 30;
        return (
          <FanThumb
            key={i}
            clip={clip}
            x={anchorX + tx - W / 2}
            y={anchorY}
            w={W}
            h={H}
            rot={rot}
            delay={delay}
            onEnter={onEnter}
            onLeave={onLeave}
            onDragStateChange={onDragStateChange}
          />
        );
      })}
    </div>,
    document.body,
  );
}

function FanThumb({
  clip,
  x,
  y,
  w,
  h,
  rot,
  delay,
  onEnter,
  onLeave,
  onDragStateChange,
}: {
  clip: ClipEntry | null;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  delay: number;
  onEnter: () => void;
  onLeave: () => void;
  onDragStateChange: (dragging: boolean) => void;
}) {
  const src = useClipThumbnail(clip);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Mount-trigger so transitions actually run from a "collapsed"
    // initial state. Without this the thumb appears already at its
    // hover transform.
    const id = window.requestAnimationFrame(() => setMounted(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  const empty = !clip;
  const transform = mounted
    ? `rotate(${rot}deg) scale(1)`
    : `rotate(0deg) scale(0.4)`;
  const opacity = mounted ? 1 : 0;

  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      draggable={!empty}
      onDragStart={(e) => {
        if (empty || !clip) return;
        // Composer + xterm both consume `text/uri-list` first and fall
        // back to `text/plain`. We set both so a drop into either lane
        // ends up with the absolute path the agent can read. The
        // FileTree dragstart bubbles otherwise — stop propagation so
        // its handler doesn't overwrite our payload.
        e.stopPropagation();
        e.dataTransfer.setData("text/uri-list", `file://${clip.path}`);
        e.dataTransfer.setData("text/plain", clip.path);
        // Aura-private MIME so the agent-terminal drop handler can
        // distinguish a tray drag from a generic file drag and route
        // image clips through the OS-clipboard + Ctrl+V path (which is
        // what makes Claude Code attach the image as `[Image #N]`
        // rather than typing the raw path).
        e.dataTransfer.setData(
          "application/x-aura-clip",
          JSON.stringify({ id: clip.id, kind: clip.kind, path: clip.path }),
        );
        e.dataTransfer.effectAllowed = "copy";
        onDragStateChange(true);
      }}
      onDragEnd={() => {
        if (!empty) onDragStateChange(false);
      }}
      style={{
        position: "fixed",
        left: x,
        top: y,
        width: w,
        height: h,
        transform,
        transformOrigin: "bottom center",
        transition: `transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1.15) ${delay}ms, opacity 220ms ease ${delay}ms`,
        opacity,
        borderRadius: 6,
        background: empty
          ? "color-mix(in srgb, var(--color-text-1) 6%, transparent)"
          : src && clip.kind === "image"
            ? `center/cover no-repeat url(${src})`
            : "var(--color-bg-2)",
        border: empty
          ? "1px dashed color-mix(in srgb, var(--color-text-1) 28%, transparent)"
          : "1px solid color-mix(in srgb, var(--color-text-1) 35%, transparent)",
        boxShadow: empty
          ? "none"
          : "0 6px 14px -6px rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--color-text-3)",
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.04em",
        overflow: "hidden",
        // Override the portal container's pointerEvents:none so the
        // thumb itself receives drag/hover events.
        pointerEvents: empty ? "none" : "auto",
        cursor: empty ? "default" : "grab",
        userSelect: "none",
      }}
    >
      {empty
        ? <EmptyMark />
        : clip.kind !== "image"
          ? extOf(clip.name).toUpperCase() || "FILE"
          : !src
            ? null
            : null}
    </div>
  );
}

function EmptyMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 3.5v9M3.5 8h9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity={0.55}
      />
    </svg>
  );
}

/* ───────────── full panel (click) ───────────── */

function ClipsPanel({
  entries,
  onClose,
}: {
  entries: ClipEntry[];
  onClose: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const t = window.setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={wrapRef}
      className="absolute z-30 left-full ml-2 bottom-0 bg-bg-1 border border-line rounded-lg shadow-lg flex flex-col"
      style={{ width: 320, maxHeight: 420 }}
    >
      <header className="flex items-center gap-2 px-3 h-8 border-b border-line-soft">
        <span className="text-text-2 text-[11.5px] font-medium uppercase tracking-wider flex-1">
          Clipboard
        </span>
        <span className="text-text-4 text-[10.5px] tabular-nums">
          {entries.length}
        </span>
      </header>
      <div className="flex-1 overflow-y-auto py-1.5">
        {entries.length === 0 ? (
          <EmptyState />
        ) : (
          entries.map((clip) => (
            <ClipRow key={clip.id} clip={clip} />
          ))
        )}
      </div>
      <footer className="flex items-center gap-2 px-2 h-8 border-t border-line-soft">
        <PickFileButton />
        <span className="flex-1" />
        {entries.length > 0 && (
          <button
            type="button"
            onClick={async () => {
              if (window.confirm("Clear all clips? This cannot be undone.")) {
                const { clearClips } = await import("../../lib/clipsStore");
                await clearClips();
              }
            }}
            className="text-text-4 hover:text-text-2 text-[10.5px] px-2 h-6 rounded transition-colors"
          >
            Clear all
          </button>
        )}
      </footer>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="px-3 py-6 text-[11px] text-text-4 leading-relaxed">
      No clips yet. Paste a screenshot anywhere in Aura, or drag a file
      onto the tray icon — it'll be saved with an absolute path agents
      can read.
    </div>
  );
}

function PickFileButton() {
  return (
    <button
      type="button"
      onClick={async () => {
        const { pickPath } = await import("../../lib/nativeDialog");
        const picked = await pickPath({ multiple: false, directory: false });
        if (picked && typeof picked === "string") {
          await saveFilePath(picked);
        }
      }}
      className="flex items-center gap-1.5 text-text-2 hover:text-text-1 hover:bg-bg-2 text-[10.5px] px-2 h-6 rounded transition-colors"
    >
      <PlusGlyph />
      <span>Add file…</span>
    </button>
  );
}

function PlusGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M5 1.5v7M1.5 5h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ClipRow({ clip }: { clip: ClipEntry }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/uri-list", `file://${clip.path}`);
        e.dataTransfer.setData("text/plain", clip.path);
        e.dataTransfer.setData(
          "application/x-aura-clip",
          JSON.stringify({ id: clip.id, kind: clip.kind, path: clip.path }),
        );
        e.dataTransfer.effectAllowed = "copy";
      }}
      className="flex items-center gap-2 px-2 py-1.5 hover:bg-bg-2 cursor-grab active:cursor-grabbing transition-colors"
    >
      <RowThumb clip={clip} />
      <div className="flex-1 min-w-0">
        <div className="text-text-1 text-[11.5px] truncate">{clip.name}</div>
        <div className="text-text-4 text-[10px] flex items-center gap-1.5">
          <span>{formatSize(clip.size)}</span>
          <span>·</span>
          <span>{formatAge(clip.created_at)}</span>
        </div>
      </div>
      <button
        type="button"
        title="Remove"
        onClick={(e) => {
          e.stopPropagation();
          removeClip(clip.id);
        }}
        className="text-text-4 hover:text-text-1 p-1 rounded transition-colors"
      >
        <TimesGlyph />
      </button>
    </div>
  );
}

function RowThumb({ clip }: { clip: ClipEntry }) {
  const src = useClipThumbnail(clip);
  const size = 36;

  if (clip.kind === "image" && src) {
    return (
      <img
        src={src}
        alt={clip.name}
        draggable={false}
        style={{
          width: size,
          height: size,
          objectFit: "cover",
          borderRadius: 4,
          border: "1px solid var(--color-line-soft)",
          background: "var(--color-bg-2)",
        }}
      />
    );
  }
  return (
    <div
      className="flex items-center justify-center bg-bg-2 text-text-3"
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        border: "1px solid var(--color-line-soft)",
        fontSize: 9,
        fontWeight: 600,
      }}
    >
      {extOf(clip.name).toUpperCase() || "FILE"}
    </div>
  );
}

function TimesGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot + 1);
}

function formatSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Window-level paste capture — call from App.tsx once at mount. Any
 *  paste anywhere in the app that carries an image is shoved into the
 *  tray. Returns an unmount cleanup. */
export function installClipsPasteCapture(): () => void {
  const onPaste = async (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind !== "file") continue;
      if (!item.type.startsWith("image/")) continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      const ext = item.type.split("/")[1] ?? "png";
      const name = blob.name && blob.name.length > 0 ? blob.name : `screenshot.${ext}`;
      const { saveImageBlob } = await import("../../lib/clipsStore");
      await saveImageBlob(name, blob);
    }
  };
  window.addEventListener("paste", onPaste);
  return () => window.removeEventListener("paste", onPaste);
}
