// A file tab drawn as the shared file view: its header names the file by
// where it lives in the project and carries the tab's own controls; its body
// is the editor, the diff, the rendered document, or the picture itself.
// Files that can't open as text keep the honest reason, drawn as the view's
// own error state.

import { useEffect, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { discardMyEdits, keepMyEdits, type OpenFile } from "../../lib/editorStore";
import { hasDiskConflict } from "../../lib/fileDiskConflict";
import { api } from "../../lib/api";
import { formatBytes } from "../../lib/bytes";
import { defaultFileMode, previewFormatOf } from "../../lib/filePreviewFormat";
import { FilePreview, type FilePreviewKind } from "../ui/file-preview";
import { CsvPreview, HtmlPreview, JsonPreview, SvgPreview } from "../ui/document-preview";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { ImageLightbox } from "../media/ImageLightbox";
import { MarkdownView } from "../MarkdownView";
import "../ui/file-tab.css";

/** Where the file lives, relative to the project — the half of the path its
 *  tab can't show. */
export function fileTabLabel(path: string, repoRoot: string): string {
  return path.startsWith(repoRoot + "/") ? path.slice(repoRoot.length + 1) : path;
}

// ── a file with a preview: read it, edit it, or both side by side ────────

/** "rendered" is Preview, "raw" is Edit, "split" is both. */
export type MdView = "raw" | "rendered" | "split";

export { isPreviewablePath } from "../../lib/filePreviewFormat";

/** The view a file opens on before anyone picks one: documents on their
 *  preview, JSON on its text. */
export function defaultMdView(path: string): MdView {
  return defaultFileMode(path) === "preview" ? "rendered" : "raw";
}

const mdKey = (repoRoot: string) => `aura.md.${repoRoot}`;

function readMdViews(repoRoot: string): Record<string, MdView> {
  try {
    const raw = localStorage.getItem(mdKey(repoRoot));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** The per-file choice of how a previewable file shows, remembered per
 *  project so a README someone edits opens on Edit next time. */
export function useMarkdownView(repoRoot: string, path: string): [MdView, (v: MdView) => void] {
  const [views, setViews] = useState<Record<string, MdView>>(() => readMdViews(repoRoot));
  useEffect(() => setViews(readMdViews(repoRoot)), [repoRoot]);
  const set = (v: MdView) => {
    setViews((prev) => {
      // Re-read so two panes on one project don't drop each other's choice.
      const next = { ...readMdViews(repoRoot), ...prev, [path]: v };
      try {
        localStorage.setItem(mdKey(repoRoot), JSON.stringify(next));
      } catch {
        /* storage full — the choice just isn't remembered */
      }
      return next;
    });
  };
  return [views[path] ?? defaultMdView(path), set];
}

/** Preview / Edit, and Split for both at once — the file view's switch. */
export function FileModeSwitch({
  value,
  onChange,
}: {
  value: MdView;
  onChange: (v: MdView) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="ghost"
      size="sm"
      className="ui-file-mode-switch"
      aria-label="File view"
      value={value}
      onValueChange={(v) => {
        if (v === "rendered" || v === "raw" || v === "split") onChange(v);
      }}
    >
      <ToggleGroupItem value="rendered" aria-label="Preview">
        Preview
      </ToggleGroupItem>
      <ToggleGroupItem value="raw" aria-label="Edit">
        Edit
      </ToggleGroupItem>
      <ToggleGroupItem value="split" aria-label="Split">
        Split
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

/** The rendered side of a file, by what kind of file it is. */
function FilePreviewBody({ path, label, source, repoRoot }: { path: string; label: string; source: string; repoRoot: string }) {
  const format = previewFormatOf(path);
  switch (format) {
    case "html":
      return <HtmlPreview html={source} path={label} />;
    case "svg":
      return <SvgPreview content={source} />;
    case "csv":
      return <CsvPreview content={source} />;
    case "json":
    case "jsonl":
      return <JsonPreview content={source} format={format} />;
    default:
      return <MarkdownView source={source} repoRoot={repoRoot} />;
  }
}

/** A previewable file's body for the chosen view. `editor` is the host's
 *  editor on the same buffer, so Edit and Split change what Preview shows. */
export function PreviewFileBody({
  view,
  path,
  label,
  source,
  repoRoot,
  editor,
}: {
  view: MdView;
  path: string;
  label: string;
  source: string;
  repoRoot: string;
  editor: ReactNode;
}) {
  const preview = <FilePreviewBody path={path} label={label} source={source} repoRoot={repoRoot} />;
  if (view === "rendered") return preview;
  if (view === "split") {
    return (
      <div className="ui-file-split">
        <div>{editor}</div>
        <div>{preview}</div>
      </div>
    );
  }
  return <>{editor}</>;
}

// ── a text file ──────────────────────────────────────────────────────────

/** An open text file: the view's header (path, Unsaved, copy, the host's
 *  controls, Save) over the host's body. Save writes this file — the pane
 *  doesn't have to be the one in focus — and a failed write keeps the
 *  buffer and says so, with a retry. */
export function TextFileView({
  file,
  label,
  dirty,
  onSave,
  actions,
  children,
}: {
  file: OpenFile;
  label: string;
  dirty: boolean;
  onSave: () => Promise<void>;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const save = async () => {
    setSaving(true);
    try {
      await onSave();
      setSaveError(undefined);
    } catch (e) {
      setSaveError(`Couldn't save ${file.name}: ${String(e)}. Your changes are still here.`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <FilePreview
      name={label}
      kind="text"
      content={file.current}
      editable
      dirty={dirty}
      saving={saving}
      saveError={saveError}
      onSave={() => void save()}
      externalChange={hasDiskConflict(file)}
      onKeepEdits={() => keepMyEdits(file.path)}
      onDiscardEdits={() => discardMyEdits(file.path)}
      actions={actions ? <div className="ui-file-view-actions">{actions}</div> : undefined}
    >
      <div className="ui-file-tab-body">{children}</div>
    </FilePreview>
  );
}

// ── a file that isn't text ───────────────────────────────────────────────

type PreviewFile = Pick<OpenFile, "status" | "size" | "name" | "path">;

function mediaKind(path: string): Exclude<FilePreviewKind, "text" | "html"> | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].includes(ext)) {
    return "image";
  }
  if (ext === "pdf") return "pdf";
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) return "audio";
  if (["mp4", "mov", "webm", "m4v"].includes(ext)) return "video";
  return null;
}

function unreadableReason(file: PreviewFile): string {
  return file.status === "too_large"
    ? `This file is too large to open here (${formatBytes(file.size)}; the cap is 2 MB).`
    : file.status === "binary"
      ? "This file looks binary, so it won't open in the text editor."
      : `This file couldn't be read (${file.status}).`;
}

/** Pictures, PDFs, sound and video straight from disk through the scoped
 *  asset protocol; a picture the protocol can't serve falls back to its
 *  bytes. Anything else shows why it can't open. */
export function MediaFileView({ file, label }: { file: PreviewFile; label: string }) {
  const kind = mediaKind(file.path);
  if (!kind) {
    // Not drawn as text, so the header offers no copy of an empty buffer.
    return <FilePreview name={label} kind="image" error={unreadableReason(file)} />;
  }
  if (kind === "image") return <ImageFileView file={file} label={label} />;
  return <FilePreview name={label} kind={kind} url={convertFileSrc(file.path)} />;
}

/** A picture: drawn from disk first, from its bytes if that fails. Click opens
 *  it full size; right-click copies or saves it. */
function ImageFileView({ file, label }: { file: PreviewFile; label: string }) {
  const [src, setSrc] = useState(() => convertFileSrc(file.path));
  // "disk" → drawing through the asset protocol; "bytes" → drawing the bytes
  // read back; "failed" → neither drew. Bytes are tried once, never in a loop.
  const [from, setFrom] = useState<"disk" | "reading" | "bytes" | "failed">("disk");
  useEffect(() => {
    setSrc(convertFileSrc(file.path));
    setFrom("disk");
  }, [file.path]);
  const readBytes = () => {
    if (from !== "disk") {
      setFrom("failed");
      return;
    }
    setFrom("reading");
    api
      .readFileBase64(file.path)
      .then((f) => {
        if (f.is_image && f.data_base64) {
          setSrc(`data:${f.media_type};base64,${f.data_base64}`);
          setFrom("bytes");
        } else {
          setFrom("failed");
        }
      })
      .catch(() => setFrom("failed"));
  };
  const fallback = from === "failed" ? "failed" : from === "reading" ? "loading" : "none";
  if (fallback === "failed") {
    return <FilePreview name={label} kind="image" error="This picture couldn't be drawn." />;
  }
  return (
    <FilePreview name={label} kind="image" url={src}>
      <div className="ui-file-media">
        {fallback === "loading" ? (
          <AsciiSpinner />
        ) : (
          <ImageLightbox
            src={src}
            alt={file.name}
            name={file.name}
            className="ui-file-image"
            onError={readBytes}
          />
        )}
      </div>
    </FilePreview>
  );
}
