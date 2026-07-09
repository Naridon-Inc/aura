// Paperclip-icon button + drag-and-drop overlay for chat file uploads.
//
// Responsibilities:
//   1. Open the Tauri native file picker (multi-select OK) on click.
//   2. For each picked file, call `api.chatUploadAttachment(repoRoot, path)`
//      and surface progress via inline chips (spinner + filename + %).
//   3. Accept files dragged onto the button OR onto the parent composer
//      area (see `dropTargetRef` prop) — show an overlay while dragging
//      so users get a "Drop to upload" affordance.
//   4. Hand each completed upload to the parent via `onUploaded` so the
//      composer can encode it into the outgoing message body.
//
// Wire format: this component does NOT touch the message body. Encoding
// is the composer's job (use `parseAttachments` / `encodeAttachments`
// from `FileAttachment.tsx`).

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import { Paperclip, Loader2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import type { ChatAttachment } from "./FileAttachment";

// Local wrapper around the Rust `chat_upload_attachment` command. The
// idiomatic Aura pattern is to add this to `lib/api.ts` as
// `api.chatUploadAttachment(repoRoot, filePath)` — see INTEGRATION.md
// for the one-liner. We invoke directly here so this component
// compiles standalone before that wiring lands.
type UploadResp = {
  url: string;
  sha256: string;
  size: number;
  mime: string;
  filename: string;
};
async function chatUploadAttachment(
  repoRoot: string,
  filePath: string,
): Promise<UploadResp> {
  return invoke<UploadResp>("chat_upload_attachment", { repoRoot, filePath });
}

// ───────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────

export type FileUploadButtonProps = {
  repoRoot: string;
  /** Called once per successful upload with the cloud-returned metadata. */
  onUploaded: (a: ChatAttachment) => void;
  /** When provided, this element becomes a drop target too (composer
   *  textarea, surrounding card, etc.). Files dragged onto it trigger
   *  the same upload flow as files dropped on the button. */
  dropTargetRef?: RefObject<HTMLElement | null>;
  /** Optional title for the button — defaults to "Attach files". */
  title?: string;
  /** Optional callback when an upload errors. Use to surface a toast. */
  onError?: (msg: string) => void;
};

type PendingUpload = {
  id: string;
  filename: string;
  /** Progress 0–1. `undefined` means "indeterminate" — we show the
   *  spinner without a % label. */
  progress?: number;
  failed?: boolean;
};

// Stable, monotonic id for pending-upload chips. crypto.randomUUID is
// available in every Tauri webview (Chromium 100+); fall back just in
// case.
function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ───────────────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────────────

export function FileUploadButton({
  repoRoot,
  onUploaded,
  dropTargetRef,
  title = "Attach files",
  onError,
}: FileUploadButtonProps) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const overlayId = useId();

  // ── upload pipeline ──────────────────────────────────────────────────

  const uploadOne = useCallback(
    async (filePath: string, displayName: string) => {
      const id = newId();
      setPending((xs) => [
        ...xs,
        { id, filename: displayName, progress: undefined },
      ]);
      try {
        // `chatUploadAttachment` is a single Tauri invoke; without a
        // streaming hook from the backend we can only show a spinner.
        // (Future: tauri-emit a `chat-upload-progress:<id>` event from
        // the Rust side and listen here.)
        const res = await chatUploadAttachment(repoRoot, filePath);
        onUploaded({
          url: res.url,
          sha256: res.sha256,
          size: res.size,
          mime: res.mime,
          filename: res.filename,
        });
        // Mark complete then drop after a short fade so the user sees
        // the final tick before the chip vanishes.
        setPending((xs) => xs.map((p) => (p.id === id ? { ...p, progress: 1 } : p)));
        setTimeout(() => {
          setPending((xs) => xs.filter((p) => p.id !== id));
        }, 600);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("chat upload failed:", msg);
        setPending((xs) =>
          xs.map((p) => (p.id === id ? { ...p, failed: true } : p)),
        );
        onError?.(msg);
        // Keep failed chips around — user dismisses with the X.
      }
    },
    [repoRoot, onUploaded, onError],
  );

  // ── click → native dialog ────────────────────────────────────────────

  const openPicker = useCallback(async () => {
    try {
      const { pickPath } = await import("../../lib/nativeDialog");
      const picked = await pickPath({ multiple: true });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      for (const p of paths) {
        if (typeof p !== "string" || !p) continue;
        const name = p.split(/[\\/]/).pop() || "file";
        // Fire-and-forget — uploads run in parallel.
        void uploadOne(p, name);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("file picker failed:", msg);
      onError?.(msg);
    }
  }, [uploadOne, onError]);

  // ── drag-and-drop on the button + (optional) composer surface ───────
  //
  // In the Tauri webview, dropped files don't carry an OS path (the
  // browser DataTransfer API only exposes File objects). For our case
  // we need the *path* to feed the Rust upload command, so we listen
  // on Tauri's `tauri://drag-drop` window event instead — it gives us
  // an absolute path list. Pure HTML5 dnd is wired up for the overlay
  // affordance only.

  useEffect(() => {
    const targets: HTMLElement[] = [];
    if (buttonRef.current) targets.push(buttonRef.current);
    if (dropTargetRef?.current) targets.push(dropTargetRef.current);

    const onOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      // relatedTarget is null when leaving the window entirely.
      const to = e.relatedTarget as Node | null;
      if (!to || !targets.some((t) => t.contains(to))) {
        setDragging(false);
      }
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      // HTML5 dnd path — in browsers we'd read the File objects.
      // In Tauri we rely on the global tauri://drag-drop listener
      // below, which gives us real OS paths.
    };
    for (const t of targets) {
      t.addEventListener("dragover", onOver);
      t.addEventListener("dragleave", onLeave);
      t.addEventListener("drop", onDrop);
    }
    return () => {
      for (const t of targets) {
        t.removeEventListener("dragover", onOver);
        t.removeEventListener("dragleave", onLeave);
        t.removeEventListener("drop", onDrop);
      }
    };
  }, [dropTargetRef]);

  // Tauri-native drag-drop listener: gives us absolute paths.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWebview } = await import(
          "@tauri-apps/api/webview"
        );
        const webview = getCurrentWebview();
        // Is a drop position (physical px) over THIS button's own drop
        // surface? Since `dragDropEnabled` is on, every OS drop in the
        // window fires this listener AND the global router — without this
        // guard a drop on the chat composer or terminal would also upload
        // here. We only act when the cursor is over our button / dropTarget.
        const overOwnTarget = (pos?: { x: number; y: number }): boolean => {
          if (!pos) return false;
          const dpr = window.devicePixelRatio || 1;
          const x = pos.x / dpr;
          const y = pos.y / dpr;
          const rects: HTMLElement[] = [];
          if (buttonRef.current) rects.push(buttonRef.current);
          if (dropTargetRef?.current) rects.push(dropTargetRef.current);
          return rects.some((el) => {
            const r = el.getBoundingClientRect();
            return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
          });
        };
        const off = await webview.onDragDropEvent((evt) => {
          if (cancelled) return;
          const payload = evt.payload as unknown as {
            type?: string;
            paths?: string[];
            position?: { x: number; y: number };
          };
          if (payload?.type === "over") {
            setDragging(overOwnTarget(payload.position));
            return;
          }
          if (payload?.type === "leave" || payload?.type === "cancel") {
            setDragging(false);
            return;
          }
          if (payload?.type === "drop" && Array.isArray(payload.paths)) {
            setDragging(false);
            if (!overOwnTarget(payload.position)) return;
            for (const p of payload.paths) {
              if (!p) continue;
              const name = p.split(/[\\/]/).pop() || "file";
              void uploadOne(p, name);
            }
          }
        });
        unlisten = off;
      } catch (e) {
        // Webview API not available (e.g. running in pure browser
        // dev mode). The HTML5 overlay still works for the affordance.
        console.debug("tauri drag-drop unavailable:", e);
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [uploadOne]);

  // ── render ──────────────────────────────────────────────────────────

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={openPicker}
        className="text-text-3 hover:text-text-1 p-1 rounded hover:bg-bg-2 transition-colors"
        title={title}
        aria-label={title}
        aria-describedby={dragging ? overlayId : undefined}
      >
        <Paperclip size={14} />
      </button>

      {pending.length > 0 && (
        <UploadChips
          pending={pending}
          onDismiss={(id) =>
            setPending((xs) => xs.filter((p) => p.id !== id))
          }
        />
      )}

      {dragging && (
        <div
          id={overlayId}
          className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center bg-bg-1/70 backdrop-blur-sm"
        >
          <div className="bg-bg-2 border-2 border-dashed border-line-soft rounded-lg px-6 py-4 text-text-1 text-[12px] font-medium">
            Drop to upload
          </div>
        </div>
      )}
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Pending-chip strip — rendered inline so the composer can position it
// (e.g. above the textarea). Each chip shows: spinner / % / filename
// + a small × to dismiss a failed upload.
// ───────────────────────────────────────────────────────────────────────

function UploadChips({
  pending,
  onDismiss,
}: {
  pending: PendingUpload[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-1">
      {pending.map((p) => (
        <UploadChip key={p.id} pending={p} onDismiss={() => onDismiss(p.id)} />
      ))}
    </div>
  );
}

function UploadChip({
  pending,
  onDismiss,
}: {
  pending: PendingUpload;
  onDismiss: () => void;
}) {
  const pct = useMemo(() => {
    if (pending.progress === undefined) return null;
    return Math.round(pending.progress * 100);
  }, [pending.progress]);

  return (
    <div
      className={`h-7 px-2 rounded-md flex items-center gap-1.5 border text-[11.5px] ${
        pending.failed
          ? "bg-bg-2 border-rose-500/40 text-rose-300"
          : "bg-bg-2 border-line-soft text-text-2"
      }`}
    >
      {pending.failed ? (
        <span className="text-rose-400">!</span>
      ) : (
        <Loader2 size={12} className="animate-spin text-text-3" />
      )}
      <span className="max-w-[140px] truncate" title={pending.filename}>
        {pending.filename}
      </span>
      {pct !== null && !pending.failed && (
        <span className="text-text-4 tabular-nums">{pct}%</span>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="text-text-4 hover:text-text-1 ml-0.5"
        title="Dismiss"
        aria-label="Dismiss upload"
      >
        <X size={11} />
      </button>
    </div>
  );
}
