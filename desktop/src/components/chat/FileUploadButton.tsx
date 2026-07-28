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
import { Paperclip, X } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";

import type { ChatAttachment } from "./FileAttachment";
import { api } from "../../lib/api";
import {
  OS_FILE_DRAG,
  OS_FILE_DROP_COMPOSER,
} from "../../lib/osFileDrop";

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
  /** Increment to open the native picker from an external menu trigger. */
  openRequest?: number;
  /** Keep upload/drop behavior mounted without rendering the paperclip. */
  hideTrigger?: boolean;
  /** Unique id stamped on the owning composer drop zone. It keeps native
   *  drops scoped correctly when Team is open in more than one split. */
  dropZoneId: string;
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

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name || "file"}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      if (separator < 0) reject(new Error(`Could not encode ${file.name || "file"}`));
      else resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

function displayNameForFile(file: File, index = 0): string {
  if (file.name.trim()) return file.name;
  const ext = file.type.split("/")[1]?.split(/[;+]/)[0] || "bin";
  return `pasted-file-${Date.now()}-${index + 1}.${ext}`;
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
  openRequest,
  hideTrigger = false,
  dropZoneId,
}: FileUploadButtonProps) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const overlayId = useId();
  const lastOpenRequest = useRef(openRequest);

  // ── upload pipeline ──────────────────────────────────────────────────

  const trackUpload = useCallback(
    async (
      displayName: string,
      upload: () => Promise<Omit<ChatAttachment, "filename"> & { filename?: string }>,
    ) => {
      const id = newId();
      setPending((xs) => [
        ...xs,
        { id, filename: displayName, progress: undefined },
      ]);
      try {
        const uploaded = await upload();
        onUploaded({ ...uploaded, filename: uploaded.filename || displayName });
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
    [onUploaded, onError],
  );

  const uploadPath = useCallback(
    (filePath: string, displayName: string) =>
      trackUpload(displayName, () => api.chatUploadAttachment(repoRoot, filePath)),
    [repoRoot, trackUpload],
  );

  const uploadFile = useCallback(
    (file: File, index = 0) => {
      const displayName = displayNameForFile(file, index);
      return trackUpload(displayName, async () => {
        if (file.size === 0) throw new Error(`${displayName} is empty`);
        if (file.size > MAX_UPLOAD_BYTES) {
          throw new Error(`${displayName} is larger than the 25 MB upload limit`);
        }
        return api.chatUploadAttachmentBytes(
          repoRoot,
          await fileToBase64(file),
          displayName,
          file.type || "application/octet-stream",
        );
      });
    },
    [repoRoot, trackUpload],
  );

  const uploadFiles = useCallback(
    (files: File[]) => {
      files.forEach((file, index) => void uploadFile(file, index));
    },
    [uploadFile],
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
        void uploadPath(p, name);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("file picker failed:", msg);
      onError?.(msg);
    }
  }, [uploadPath, onError]);

  useEffect(() => {
    if (openRequest === undefined || openRequest === lastOpenRequest.current) return;
    lastOpenRequest.current = openRequest;
    void openPicker();
  }, [openPicker, openRequest]);

  // ── drag, drop, and paste on the owning composer surface ───────
  //
  // Browser File objects (clipboard screenshots and browser-mode drops) are
  // uploaded by value. Finder and Aura FileTree drops are routed by the
  // app-level native/in-app path router and arrive through the scoped custom
  // events below. Every source shares the same progress and error handling.

  useEffect(() => {
    const targets: HTMLElement[] = [];
    if (buttonRef.current) targets.push(buttonRef.current);
    if (dropTargetRef?.current) targets.push(dropTargetRef.current);

    const hasFilePayload = (dataTransfer: DataTransfer | null) =>
      !!dataTransfer &&
      (dataTransfer.files.length > 0 ||
        dataTransfer.types.includes("Files") ||
        dataTransfer.types.includes("text/uri-list"));

    const onOver = (e: DragEvent) => {
      if (!hasFilePayload(e.dataTransfer)) return;
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
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);
      uploadFiles(Array.from(e.dataTransfer.files));
    };
    const onPaste = (e: ClipboardEvent) => {
      const clipboard = e.clipboardData;
      const itemFiles = Array.from(clipboard?.items ?? [])
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      // Finder-copy paste is inconsistent across WKWebView versions: some
      // expose file items, while others populate only clipboardData.files.
      const files = itemFiles.length > 0
        ? itemFiles
        : Array.from(clipboard?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      uploadFiles(files);
    };
    for (const t of targets) {
      t.addEventListener("dragover", onOver);
      t.addEventListener("dragleave", onLeave);
      t.addEventListener("drop", onDrop);
      t.addEventListener("paste", onPaste);
    }
    return () => {
      for (const t of targets) {
        t.removeEventListener("dragover", onOver);
        t.removeEventListener("dragleave", onLeave);
        t.removeEventListener("drop", onDrop);
        t.removeEventListener("paste", onPaste);
      }
    };
  }, [dropTargetRef, uploadFiles]);

  // Finder/Desktop and Aura FileTree drops are hit-tested once by the global
  // router. `dropZoneId` ensures only the composer under the pointer reacts,
  // including when multiple Team splits are open simultaneously.
  useEffect(() => {
    const onPathDrop = (event: Event) => {
      const detail = (event as CustomEvent<{
        paths?: string[];
        targetId?: string | null;
      }>).detail;
      if (detail?.targetId !== dropZoneId) return;
      setDragging(false);
      for (const path of detail.paths ?? []) {
        if (!path) continue;
        void uploadPath(path, path.split(/[\\/]/).pop() || "file");
      }
    };
    const onNativeDrag = (event: Event) => {
      const detail = (event as CustomEvent<{
        kind?: string | null;
        targetId?: string | null;
      }>).detail;
      if (!detail?.kind) {
        setDragging(false);
        return;
      }
      setDragging(
        detail.kind === "composer" && detail.targetId === dropZoneId,
      );
    };
    window.addEventListener(OS_FILE_DROP_COMPOSER, onPathDrop);
    window.addEventListener(OS_FILE_DRAG, onNativeDrag);
    return () => {
      window.removeEventListener(OS_FILE_DROP_COMPOSER, onPathDrop);
      window.removeEventListener(OS_FILE_DRAG, onNativeDrag);
    };
  }, [dropZoneId, uploadPath]);

  // ── render ──────────────────────────────────────────────────────────

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={openPicker}
        className={hideTrigger ? "hidden" : "text-text-3 hover:text-text-1 p-1 rounded hover:bg-bg-2 transition-colors"}
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
          className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center rounded-[10px] border border-dashed border-accent/40 bg-bg-1/90 backdrop-blur-sm"
        >
          <div className="rounded-md bg-bg-2 px-4 py-2 text-text-1 text-[12px] font-medium shadow-lg">
            Drop files to attach
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
          ? "bg-bg-2 border-red/40 text-red"
          : "bg-bg-2 border-line-soft text-text-2"
      }`}
    >
      {pending.failed ? (
        <span className="text-red">!</span>
      ) : (
        <AsciiSpinner />
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
