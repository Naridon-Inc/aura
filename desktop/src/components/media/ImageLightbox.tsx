// A picture you can open, not just look at.
//
// Renders as a plain image wherever it is put; click it and it fills the
// window on a dark ground, Esc or a click outside puts it back. In the
// overlay the picture is fitted to the window until asked for its real
// size. Right-click, in either state, offers "Copy image" and "Save image…"
// — the two things a person reaches for on a screenshot and could not do
// from the file viewer or a chat attachment before.

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { api } from "../../lib/api";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { copyImageToClipboard, saveImageClip } from "./imageBytes";

type Note = { tone: "ok" | "bad"; text: string } | null;

/** The busy/notice state shared by the inline image and the overlay, so a
 *  copy started from one is reported wherever the person is looking. */
function useImageActions(src: string, name?: string | null) {
  const [busy, setBusy] = useState<"copy" | "save" | null>(null);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 2600);
    return () => clearTimeout(t);
  }, [note]);

  const copy = useCallback(async () => {
    if (busy) return;
    setBusy("copy");
    try {
      await copyImageToClipboard(src, name);
      setNote({ tone: "ok", text: "Copied — paste it anywhere" });
    } catch (e) {
      setNote({ tone: "bad", text: `Could not copy: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [busy, src, name]);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy("save");
    try {
      const entry = await saveImageClip(src, name);
      // Show the file rather than announce a path: the clips folder is not a
      // place anyone navigates to by hand.
      api.fsRevealInFinder(entry.path).catch(() => {});
      setNote({ tone: "ok", text: `Saved as ${entry.name}` });
    } catch (e) {
      setNote({ tone: "bad", text: `Could not save: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [busy, src, name]);

  return { busy, note, copy, save };
}

function ImageMenu({
  children,
  busy,
  onCopy,
  onSave,
}: {
  children: React.ReactNode;
  busy: "copy" | "save" | null;
  onCopy: () => void;
  onSave: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onClick={onCopy} disabled={busy !== null}>
          Copy image
        </ContextMenuItem>
        <ContextMenuItem onClick={onSave} disabled={busy !== null}>
          Save image…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function NoteLine({ note, busy }: { note: Note; busy: "copy" | "save" | null }) {
  if (!note && !busy) return null;
  return (
    <span
      role="status"
      className={cn(
        "pointer-events-none rounded bg-bg-3 px-2 py-1 text-xs shadow-md",
        note?.tone === "bad" ? "text-red" : "text-text-2",
      )}
    >
      {busy ? (
        <>
          <AsciiSpinner className="mr-1.5" />
          {busy === "copy" ? "Copying…" : "Saving…"}
        </>
      ) : (
        note?.text
      )}
    </span>
  );
}

export function ImageLightbox({
  src,
  alt,
  name,
  className,
  style,
}: {
  src: string;
  alt: string;
  /** The picture's own file name, used to name a copy or a save. Falls back
   *  to `alt`. */
  name?: string | null;
  /** Applied to the inline image, exactly as they were on the `<img>` it
   *  replaced. */
  className?: string;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [fit, setFit] = useState(true);
  const fileName = name ?? alt;
  const actions = useImageActions(src, fileName);

  // Esc closes; the listener exists only while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const overlay = open
    ? createPortal(
        <div
          role="dialog"
          aria-label={alt}
          className="fixed inset-0 z-[80] flex flex-col bg-black/85"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex h-10 shrink-0 items-center gap-2 px-3 text-xs text-text-2"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="min-w-0 flex-1 truncate" title={fileName}>
              {fileName}
            </span>
            <NoteLine note={actions.note} busy={actions.busy} />
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setFit((v) => !v)}
              title={fit ? "Show at its real size" : "Fit to the window"}
            >
              <Maximize2 />
              {fit ? "Real size" : "Fit"}
            </Button>
            <Button variant="ghost" size="xs" onClick={actions.copy} disabled={actions.busy !== null}>
              Copy
            </Button>
            <Button variant="ghost" size="xs" onClick={actions.save} disabled={actions.busy !== null}>
              Save…
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="Close" title="Close (Esc)">
              <X />
            </Button>
          </div>
          <div
            className={cn(
              "min-h-0 flex-1",
              fit ? "flex items-center justify-center p-4" : "overflow-auto p-4",
            )}
          >
            <ImageMenu busy={actions.busy} onCopy={actions.copy} onSave={actions.save}>
              <img
                src={src}
                alt={alt}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "select-none",
                  fit ? "max-h-full max-w-full object-contain" : "block max-w-none",
                )}
                style={fit ? undefined : { margin: "0 auto" }}
              />
            </ImageMenu>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <span className="relative inline-block max-w-full">
        <ImageMenu busy={actions.busy} onCopy={actions.copy} onSave={actions.save}>
          <img
            src={src}
            alt={alt}
            title="Click to open full size"
            className={cn("cursor-zoom-in", className)}
            style={style}
            onClick={() => {
              setFit(true);
              setOpen(true);
            }}
          />
        </ImageMenu>
        {!open && (actions.note || actions.busy) && (
          <span className="absolute left-2 top-2">
            <NoteLine note={actions.note} busy={actions.busy} />
          </span>
        )}
      </span>
      {overlay}
    </>
  );
}
