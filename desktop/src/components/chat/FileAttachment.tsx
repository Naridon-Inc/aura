// Renders chat attachments inside a message bubble + parser helpers so
// CommsPanel can extract attachments from the message body.
//
// Wire format: the composer appends a sentinel to whatever the user
// typed:
//
//     <user's text>
//     <aura:attachments>[{"url":"…","filename":"…","mime":"…","size":…}]</aura:attachments>
//
// `parseAttachments(body)` returns `{text, attachments}` — receivers
// render `text` in the bubble and `attachments` below it. `encodeAttachments`
// is the inverse and is what the composer calls right before send.
//
// Rendering:
//   - `AttachmentList`  groups a message's attachments — images into a
//     tidy grid (click → full-screen lightbox), everything else stacked
//     as cards. This is what the message bubble uses.
//   - `FileAttachment`  renders ONE attachment (image / code-preview /
//     file card). Used by the channel "Files" gallery tab.
//
// Image mimes → rounded thumbnail + lightbox. Code-ish files → a 15-line
// preview card. Everything else → a file card (type-colored icon + name
// + size + download). Cards use a recessed translucent surface so they
// read on both the bright "from me" bubble and the dark peer bubble.
//
// Non-lightbox clicks go through `@tauri-apps/plugin-opener::openUrl` so
// the link opens in the OS default app, not inside the Tauri webview.

import { useEffect, useRef, useState } from "react";
import {
  AlignLeft,
  Download,
  ExternalLink,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileVideo,
  MoreVertical,
  Pause,
  Play,
  X,
} from "lucide-react";
import { languageSlugForPath } from "../../lib/monacoLanguage";
import { AsciiSpinner } from "../ui/ascii-spinner";

// ───────────────────────────────────────────────────────────────────────
// Types + wire format
// ───────────────────────────────────────────────────────────────────────

export type ChatAttachment = {
  url: string;
  filename: string;
  mime: string;
  size: number;
  /** Optional — present on uploads returned by the cloud upload endpoint. */
  sha256?: string;
  /** Rich metadata added by the in-composer recorder. Older audio uploads
   *  omit it and still receive the same custom player. */
  kind?: "voice-note";
  duration?: number;
  transcript?: string;
};

const SENTINEL_OPEN = "<aura:attachments>";
const SENTINEL_CLOSE = "</aura:attachments>";

/** Strip the `<aura:attachments>` sentinel from a message body and
 *  return the plain text plus the parsed attachment list. Malformed
 *  payloads are silently dropped; the surrounding text is preserved. */
export function parseAttachments(body: string): {
  text: string;
  attachments: ChatAttachment[];
} {
  if (!body || typeof body !== "string") {
    return { text: body ?? "", attachments: [] };
  }
  const start = body.indexOf(SENTINEL_OPEN);
  if (start < 0) return { text: body, attachments: [] };
  const end = body.indexOf(SENTINEL_CLOSE, start + SENTINEL_OPEN.length);
  if (end < 0) return { text: body, attachments: [] };

  const jsonRaw = body.slice(start + SENTINEL_OPEN.length, end);
  const before = body.slice(0, start).replace(/\s+$/, "");
  const after = body.slice(end + SENTINEL_CLOSE.length).replace(/^\s+/, "");
  const text = [before, after].filter(Boolean).join("\n").trim();

  let attachments: ChatAttachment[] = [];
  try {
    const parsed = JSON.parse(jsonRaw);
    if (Array.isArray(parsed)) {
      attachments = parsed
        .filter(
          (a): a is Record<string, unknown> =>
            !!a && typeof a === "object" && typeof (a as Record<string, unknown>).url === "string",
        )
        .map((a) => ({
          url: String(a.url ?? ""),
          filename:
            typeof a.filename === "string" && a.filename ? a.filename : "file",
          mime:
            typeof a.mime === "string" && a.mime
              ? a.mime
              : "application/octet-stream",
          size: typeof a.size === "number" && a.size >= 0 ? a.size : 0,
          sha256: typeof a.sha256 === "string" ? a.sha256 : undefined,
          kind: a.kind === "voice-note" ? "voice-note" : undefined,
          duration: typeof a.duration === "number" ? a.duration : undefined,
          transcript: typeof a.transcript === "string" ? a.transcript : undefined,
        }));
    }
  } catch {
    // fall through — empty attachments, text preserved
  }
  return { text, attachments };
}

/** Encode an attachment list into the trailing sentinel form. A no-op
 *  when the list is empty so callers can wrap their send path
 *  unconditionally. */
export function encodeAttachments(
  text: string,
  attachments: ChatAttachment[],
): string {
  const trimmed = (text ?? "").replace(/\s+$/, "");
  if (!attachments || attachments.length === 0) return trimmed;
  const payload = attachments.map((a) => ({
    url: a.url,
    filename: a.filename,
    mime: a.mime,
    size: a.size,
    ...(a.sha256 ? { sha256: a.sha256 } : {}),
    ...(a.kind ? { kind: a.kind } : {}),
    ...(typeof a.duration === "number" ? { duration: a.duration } : {}),
    ...(a.transcript ? { transcript: a.transcript } : {}),
  }));
  const sentinel = `${SENTINEL_OPEN}${JSON.stringify(payload)}${SENTINEL_CLOSE}`;
  return trimmed ? `${trimmed}\n${sentinel}` : sentinel;
}

// ───────────────────────────────────────────────────────────────────────
// Mime / extension classifiers
// ───────────────────────────────────────────────────────────────────────

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

/** Extensions we'll fetch + preview the first 15 lines of. Kept tight
 *  so we don't accidentally fetch a 25 MB binary just because its mime
 *  was generic `application/octet-stream`. */
const PREVIEWABLE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "rs", "py", "go", "rb", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp",
  "json", "jsonl", "yaml", "yml", "toml",
  "md", "markdown", "txt", "log",
  "sh", "bash", "zsh",
  "html", "htm", "css", "scss",
  "sql",
]);

const PREVIEW_LINES = 15;
const PREVIEW_MAX_BYTES = 64 * 1024; // never fetch more than 64 KB for preview

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

function isImage(mime: string): boolean {
  return IMAGE_MIMES.has(mime.toLowerCase());
}

function isAudio(mime: string, filename: string): boolean {
  const ext = extOf(filename);
  return mime.toLowerCase().startsWith("audio/") ||
    ["mp3", "wav", "ogg", "m4a", "aac", "flac"].includes(ext);
}

function isPreviewable(mime: string, filename: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json") return true;
  const ext = extOf(filename);
  return PREVIEWABLE_EXTS.has(ext);
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// File-type → icon + label. Drives the icon badge on the file card. The
// icon shape and the extension label carry the type; the badge itself stays
// neutral so a list of attachments doesn't read as a pile of status colours.
type FileKind = {
  Icon: typeof FileIcon;
  label: string;
};

function fileKind(mime: string, filename: string): FileKind {
  const ext = extOf(filename);
  const m = mime.toLowerCase();
  const has = (...xs: string[]) => xs.includes(ext);

  if (m === "application/pdf" || ext === "pdf")
    return { Icon: FileText, label: "PDF" };
  if (has("zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz"))
    return { Icon: FileArchive, label: ext.toUpperCase() };
  if (has("xls", "xlsx", "csv", "ods", "tsv"))
    return { Icon: FileSpreadsheet, label: ext.toUpperCase() };
  if (has("doc", "docx", "rtf", "odt", "pages"))
    return { Icon: FileText, label: ext.toUpperCase() };
  if (has("ppt", "pptx", "key", "odp"))
    return { Icon: FileText, label: ext.toUpperCase() };
  if (m.startsWith("audio/") || has("mp3", "wav", "ogg", "m4a", "flac", "aac"))
    return { Icon: FileAudio, label: ext.toUpperCase() || "Audio" };
  if (m.startsWith("video/") || has("mp4", "mov", "webm", "mkv", "avi"))
    return { Icon: FileVideo, label: ext.toUpperCase() || "Video" };
  if (isPreviewable(mime, filename) || has("xml", "lock", "env", "ini", "conf"))
    return { Icon: FileCode, label: ext.toUpperCase() || "Code" };
  return {
    Icon: FileIcon,
    label: ext ? ext.toUpperCase() : "File",
  };
}

// ───────────────────────────────────────────────────────────────────────
// AttachmentList — message-bubble layout (images grid + files stacked)
// ───────────────────────────────────────────────────────────────────────

export type AttachmentListProps = {
  attachments: ChatAttachment[];
  /** Bright "from me" accent bubble vs the dark peer bubble — only
   *  nudges a couple of border treatments for contrast. */
  fromMe?: boolean;
};

export function AttachmentList({ attachments, fromMe = false }: AttachmentListProps) {
  if (!attachments || attachments.length === 0) return null;
  const images = attachments.filter((a) => isImage(a.mime));
  const rest = attachments.filter((a) => !isImage(a.mime));

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {images.length === 1 && (
        <ImageAttachment attachment={images[0]} fromMe={fromMe} variant="single" />
      )}
      {images.length > 1 && (
        <div
          className="grid gap-1"
          style={{
            gridTemplateColumns:
              images.length === 2 ? "repeat(2, 1fr)" : "repeat(2, minmax(0, 132px))",
          }}
        >
          {images.map((img, i) => (
            <ImageAttachment
              key={`img:${i}`}
              attachment={img}
              fromMe={fromMe}
              variant="grid"
            />
          ))}
        </div>
      )}
      {rest.map((a, i) => (
        <FileAttachment key={`att:${i}`} attachment={a} />
      ))}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// FileAttachment — single attachment (Files gallery tab + grid fallback)
// ───────────────────────────────────────────────────────────────────────

export type FileAttachmentProps = {
  attachment: ChatAttachment;
};

export function FileAttachment({ attachment }: FileAttachmentProps) {
  if (isImage(attachment.mime)) {
    return <ImageAttachment attachment={attachment} variant="single" />;
  }
  if (attachment.kind === "voice-note" || isAudio(attachment.mime, attachment.filename)) {
    return <VoiceNoteAttachment attachment={attachment} />;
  }
  if (isPreviewable(attachment.mime, attachment.filename)) {
    return <CodePreviewAttachment attachment={attachment} />;
  }
  return <FileCard attachment={attachment} />;
}

function VoiceNoteAttachment({ attachment }: { attachment: ChatAttachment }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(attachment.duration ?? 0);
  const [speed, setSpeed] = useState(1);
  const [showTranscript, setShowTranscript] = useState(false);
  const total = duration || attachment.duration || 0;
  const progress = total > 0 ? Math.min(1, current / total) : 0;
  const bars = waveformFor(attachment.sha256 || attachment.filename, 48);

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      await audio.play();
    } else {
      audio.pause();
    }
  };

  const cycleSpeed = () => {
    const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  return (
    <div className="slack-voice-note">
      <audio
        ref={audioRef}
        src={attachment.url}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || attachment.duration || 0)}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
      />
      <div className="slack-voice-player">
        <button type="button" className="slack-voice-play" onClick={() => void toggle()} aria-label={playing ? "Pause voice note" : "Play voice note"}>
          {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
        </button>
        <button
          type="button"
          className="slack-voice-wave"
          onClick={(event) => {
            const audio = audioRef.current;
            if (!audio || total <= 0) return;
            const rect = event.currentTarget.getBoundingClientRect();
            audio.currentTime = Math.max(0, Math.min(total, ((event.clientX - rect.left) / rect.width) * total));
          }}
          aria-label="Seek voice note"
        >
          {bars.map((height, index) => (
            <i key={index} className={index / bars.length <= progress ? "is-played" : ""} style={{ height }} />
          ))}
        </button>
        <span className="slack-voice-time">{formatDuration(total > 0 ? total - current : attachment.duration ?? 0)}</span>
        <button type="button" className="slack-voice-mini" aria-label="Show transcript" onClick={() => setShowTranscript((value) => !value)}>
          <AlignLeft size={15} />
        </button>
        <button type="button" className="slack-voice-speed" onClick={cycleSpeed}>{speed}×</button>
        <button type="button" className="slack-voice-mini" aria-label="More voice-note actions">
          <MoreVertical size={15} />
        </button>
      </div>
      {showTranscript && (
        <div className="slack-voice-transcript">
          {attachment.transcript?.trim() || "A transcript is not available for this voice note."}
        </div>
      )}
      <button type="button" className="slack-view-transcript" onClick={() => setShowTranscript((value) => !value)}>
        {showTranscript ? "Hide transcript" : "View transcript"}
      </button>
    </div>
  );
}

function waveformFor(seed: string, count: number): number[] {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Array.from({ length: count }, (_, index) => {
    hash = Math.imul(hash ^ index, 2246822519);
    return 6 + (Math.abs(hash) % 24);
  });
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const rounded = Math.max(0, Math.round(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

// ── Image + lightbox ─────────────────────────────────────────────────

function ImageAttachment({
  attachment,
  fromMe = false,
  variant = "single",
}: {
  attachment: ChatAttachment;
  fromMe?: boolean;
  variant?: "single" | "grid";
}) {
  const [errored, setErrored] = useState(false);
  const [open, setOpen] = useState(false);
  if (errored) return <FileCard attachment={attachment} />;

  const ring = fromMe
    ? "1px solid var(--color-line)"
    : "1px solid var(--color-line-soft)";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          "group/img relative block overflow-hidden rounded-lg bg-bg-2 transition-[filter] hover:brightness-105 " +
          (variant === "grid" ? "h-[132px] w-full" : "")
        }
        style={{ border: ring }}
        title={`${attachment.filename} · ${formatBytes(attachment.size)}`}
      >
        <img
          src={attachment.url}
          alt={attachment.filename}
          loading="lazy"
          className={
            variant === "grid"
              ? "h-full w-full object-cover"
              : "block max-h-[300px] max-w-[340px] object-contain"
          }
          onError={() => setErrored(true)}
        />
        {/* filename veil on hover (single only — grid stays clean) */}
        {variant === "single" && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/55 to-transparent px-2 pb-1 pt-4 text-[10px] text-white/90 opacity-0 transition-opacity group-hover/img:opacity-100">
            <span className="truncate">{attachment.filename}</span>
            <span className="ml-auto shrink-0 tabular-nums text-white/70">
              {formatBytes(attachment.size)}
            </span>
          </span>
        )}
      </button>
      {open && (
        <Lightbox
          src={attachment.url}
          alt={attachment.filename}
          size={attachment.size}
          onOpenExternal={() => openExternal(attachment.url)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function Lightbox({
  src,
  alt,
  size,
  onClose,
  onOpenExternal,
}: {
  src: string;
  alt: string;
  size: number;
  onClose: () => void;
  onOpenExternal: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Lock background scroll while open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-[200] flex flex-col bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* top bar */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 text-white/80"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate text-[12.5px] font-medium text-white/90">{alt}</span>
        <span className="shrink-0 text-[11px] text-white/50 tabular-nums">
          {formatBytes(size)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenExternal}
            title="Open in default app"
            aria-label="Open in default app"
            className="flex h-8 w-8 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ExternalLink size={16} />
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>
      </div>
      {/* image stage */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-6">
        <img
          src={src}
          alt={alt}
          className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  );
}

// ── File card (non-image, non-preview) ───────────────────────────────

function FileCard({ attachment }: { attachment: ChatAttachment }) {
  const { Icon, label } = fileKind(attachment.mime, attachment.filename);
  return (
    <div
      className="flex w-[300px] max-w-full items-center gap-2.5 rounded-lg border px-2.5 py-2"
      style={{
        background: "color-mix(in srgb, var(--color-bg-0) 55%, transparent)",
        borderColor: "color-mix(in srgb, var(--color-line) 70%, transparent)",
      }}
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
        style={{
          background: "var(--color-bg-2)",
          color: "var(--color-text-3)",
        }}
        aria-hidden
      >
        <Icon size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-[12px] font-medium text-text-1"
          title={attachment.filename}
        >
          {attachment.filename}
        </div>
        <div className="text-[10.5px] text-text-4">
          {label} · {formatBytes(attachment.size)}
        </div>
      </div>
      <button
        type="button"
        onClick={() => openExternal(attachment.url)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-bg-3 hover:text-text-1"
        title="Download"
        aria-label={`Download ${attachment.filename}`}
      >
        <Download size={14} />
      </button>
    </div>
  );
}

// ── Code preview ─────────────────────────────────────────────────────

function CodePreviewAttachment({ attachment }: { attachment: ChatAttachment }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>("");
  const [truncated, setTruncated] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // Range request so we never download a 64KB+ chunk just for
        // the first 15 lines. Servers without Range support fall back
        // to the full body — we cap that ourselves below.
        const resp = await fetch(attachment.url, {
          headers: { Range: `bytes=0-${PREVIEW_MAX_BYTES - 1}` },
        });
        if (!resp.ok && resp.status !== 206) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const text = await resp.text();
        const capped = text.length > PREVIEW_MAX_BYTES
          ? text.slice(0, PREVIEW_MAX_BYTES)
          : text;
        const lines = capped.split(/\r?\n/);
        const head = lines.slice(0, PREVIEW_LINES).join("\n");
        if (cancelled.current) return;
        setPreview(head);
        setTruncated(lines.length > PREVIEW_LINES || text.length >= PREVIEW_MAX_BYTES);
        setLoading(false);
      } catch (e) {
        if (cancelled.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => {
      cancelled.current = true;
    };
  }, [attachment.url]);

  const lang = languageSlugForPath(attachment.filename);
  const { Icon } = fileKind(attachment.mime, attachment.filename);

  return (
    <div
      className="w-[420px] max-w-full overflow-hidden rounded-lg border"
      style={{
        background: "color-mix(in srgb, var(--color-bg-0) 55%, transparent)",
        borderColor: "color-mix(in srgb, var(--color-line) 70%, transparent)",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          style={{
            background: "var(--color-bg-2)",
            color: "var(--color-text-3)",
          }}
          aria-hidden
        >
          <Icon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[12px] font-medium text-text-1"
            title={attachment.filename}
          >
            {attachment.filename}
          </div>
          <div className="text-[10.5px] text-text-4">
            {lang} · {formatBytes(attachment.size)}
          </div>
        </div>
        <button
          type="button"
          onClick={() => openExternal(attachment.url)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-bg-3 hover:text-text-1"
          title="Open"
          aria-label={`Open ${attachment.filename}`}
        >
          <ExternalLink size={13} />
        </button>
      </div>
      {/* Body */}
      <div
        className="px-2.5 py-1.5"
        style={{ background: "color-mix(in srgb, var(--color-bg-1) 75%, transparent)", borderTop: "1px solid color-mix(in srgb, var(--color-line) 60%, transparent)" }}
      >
        {loading ? (
          <div className="flex items-center gap-1.5 text-[11px] text-text-3">
            <AsciiSpinner />
            <span>Loading preview…</span>
          </div>
        ) : error ? (
          <div className="text-[11px] text-text-3">Preview unavailable · {error}</div>
        ) : (
          <pre
            className="overflow-x-auto whitespace-pre font-mono text-[11px] leading-snug text-text-1"
            data-language={lang}
          >
            {preview}
            {truncated && <span className="text-text-4">{"\n…"}</span>}
          </pre>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// External-open helper — uses @tauri-apps/plugin-opener so the URL is
// handed to the OS (default browser / preview app) instead of being
// navigated to inside the Tauri webview.
// ───────────────────────────────────────────────────────────────────────

function openExternal(url: string) {
  void (async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch (e) {
      console.error("openUrl failed, falling back to window.open:", e);
      try {
        window.open(url, "_blank", "noopener,noreferrer");
      } catch {
        /* swallow */
      }
    }
  })();
}
