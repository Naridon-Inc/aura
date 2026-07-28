// Chip that renders a repo-file attachment inside a chat bubble. Clicking
// the chip dispatches an `aura:open-file` window event with
// `{detail: {path, line}}` — the editor host listens for this and opens
// the file in the active pane (see INTEGRATION-PICKER.md).
//
// The wire format for attachments piggybacks on the message body: the
// composer appends `<aura:repo-files>[{...},{...}]</aura:repo-files>` to
// whatever the user typed. `parseRepoFiles` (exported below) extracts the
// JSON payload and returns `{text, files}` so the renderer can show the
// chip alongside the original text.

import { useEffect, useRef, useState } from "react";
import { FileIcon } from "../FileIcon";

// --------------------------------------------------------------------- //
// types                                                                  //
// --------------------------------------------------------------------- //

export type RepoFileAttachment = {
  /** Path relative to the repo root. */
  path: string;
  /** Optional inclusive start line (1-based). */
  lineStart?: number;
  /** Optional inclusive end line (1-based). */
  lineEnd?: number;
};

export type RepoFileChipProps = {
  repoRoot: string;
  /** Path relative to `repoRoot`. */
  path: string;
  lineStart?: number;
  lineEnd?: number;
  /** Optional handler invoked instead of the global event if provided. */
  onOpen?: () => void;
  /** Optional handler for the "remove attachment" menu item. */
  onRemove?: () => void;
};

// --------------------------------------------------------------------- //
// parser                                                                 //
// --------------------------------------------------------------------- //

const SENTINEL_OPEN = "<aura:repo-files>";
const SENTINEL_CLOSE = "</aura:repo-files>";

/** Strip the `<aura:repo-files>` sentinel from a message body and return
 *  the plain text plus the parsed attachment list. Malformed payloads are
 *  silently dropped; the text is still preserved. */
export function parseRepoFiles(body: string): {
  text: string;
  files: RepoFileAttachment[];
} {
  if (!body || typeof body !== "string") return { text: body ?? "", files: [] };
  const start = body.indexOf(SENTINEL_OPEN);
  if (start < 0) return { text: body, files: [] };
  const end = body.indexOf(SENTINEL_CLOSE, start + SENTINEL_OPEN.length);
  if (end < 0) return { text: body, files: [] };
  const jsonRaw = body.slice(start + SENTINEL_OPEN.length, end);
  const before = body.slice(0, start).replace(/\s+$/, "");
  const after = body.slice(end + SENTINEL_CLOSE.length).replace(/^\s+/, "");
  const text = [before, after].filter(Boolean).join("\n").trim();
  let files: RepoFileAttachment[] = [];
  try {
    const parsed = JSON.parse(jsonRaw);
    if (Array.isArray(parsed)) {
      files = parsed
        .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
        .map((f) => {
          const path = typeof f.path === "string" ? f.path : "";
          const lineStart =
            typeof f.lineStart === "number" && f.lineStart > 0
              ? f.lineStart
              : undefined;
          const lineEnd =
            typeof f.lineEnd === "number" && f.lineEnd > 0
              ? f.lineEnd
              : undefined;
          return { path, lineStart, lineEnd };
        })
        .filter((f) => f.path.length > 0);
    }
  } catch {
    files = [];
  }
  return { text, files };
}

/** Inverse of `parseRepoFiles` — append the sentinel to a body. Caller
 *  must filter out empty paths. */
export function encodeRepoFiles(text: string, files: RepoFileAttachment[]): string {
  if (!files.length) return text;
  const payload = JSON.stringify(
    files.map((f) => {
      const out: RepoFileAttachment = { path: f.path };
      if (f.lineStart) out.lineStart = f.lineStart;
      if (f.lineEnd) out.lineEnd = f.lineEnd;
      return out;
    }),
  );
  const sentinel = `${SENTINEL_OPEN}${payload}${SENTINEL_CLOSE}`;
  return text ? `${text}\n${sentinel}` : sentinel;
}

// --------------------------------------------------------------------- //
// component                                                              //
// --------------------------------------------------------------------- //

function splitParent(rel: string): { name: string; parent: string } {
  const segs = rel.split("/");
  return {
    name: segs[segs.length - 1] ?? rel,
    parent: segs.slice(0, -1).join("/"),
  };
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

function openFile(path: string, line?: number, onOpen?: () => void) {
  if (onOpen) {
    onOpen();
    return;
  }
  window.dispatchEvent(
    new CustomEvent("aura:open-file", {
      detail: { path, line },
    }),
  );
}

export function RepoFileChip({
  repoRoot,
  path,
  lineStart,
  lineEnd,
  onOpen,
  onRemove,
}: RepoFileChipProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { name, parent } = splitParent(path);

  // Resolve to an absolute path for the editor (so listeners can route
  // straight to the FS). Relative attachments only make sense in the
  // context of a known repo, so this is safe to compute eagerly.
  const absPath = repoRoot
    ? repoRoot.endsWith("/")
      ? `${repoRoot}${path}`
      : `${repoRoot}/${path}`
    : path;

  // Close the dropdown on outside click / escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const lineLabel =
    lineStart && lineEnd && lineEnd !== lineStart
      ? `L${lineStart}–${lineEnd}`
      : lineStart
        ? `L${lineStart}`
        : null;

  return (
    <div
      className="inline-flex items-center gap-2 px-2 py-1.5 rounded border border-line-soft bg-bg-card hover:bg-bg-hover cursor-pointer group"
      style={{ maxWidth: 320 }}
      onClick={(e) => {
        // Clicks on the menu trigger shouldn't open the file.
        if ((e.target as HTMLElement).closest("[data-chip-menu]")) return;
        openFile(absPath, lineStart, onOpen);
      }}
      title={`${path}${lineLabel ? ` ${lineLabel}` : ""}`}
    >
      <FileIcon name={name} size={14} />
      <div className="flex flex-col min-w-0 leading-tight">
        <span
          className="font-mono font-semibold text-[12px] text-text-1 truncate"
          style={{ maxWidth: 240 }}
        >
          {name}
        </span>
        {parent && (
          <span
            className="text-[10.5px] text-text-4 truncate"
            style={{ maxWidth: 240 }}
          >
            {truncateMiddle(parent, 38)}
          </span>
        )}
      </div>
      {lineLabel && (
        <span
          className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wider"
          style={{
            background:
              "color-mix(in oklab, var(--color-blue) 18%, transparent)",
            color: "var(--color-blue)",
          }}
        >
          {lineLabel}
        </span>
      )}
      <div
        ref={menuRef}
        data-chip-menu
        className="relative ml-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="text-text-4 hover:text-text-1 px-1 leading-none opacity-60 group-hover:opacity-100"
          title="Attachment actions"
          aria-label="Attachment actions"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path
              d="M2 3.5L5 6.5L8 3.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {menuOpen && (
          <ul
            className="absolute right-0 top-full mt-1 z-10 min-w-[160px] bg-bg-1 border border-line-soft rounded-lg shadow-[var(--shadow-flyout)] p-1 text-[12px]"
            role="menu"
          >
            <MenuItem
              label="Open file"
              onClick={() => {
                openFile(absPath, undefined, onOpen);
                setMenuOpen(false);
              }}
            />
            {lineStart && (
              <MenuItem
                label={`Open at ${lineLabel}`}
                onClick={() => {
                  openFile(absPath, lineStart, onOpen);
                  setMenuOpen(false);
                }}
              />
            )}
            <MenuItem
              label="Copy path"
              onClick={() => {
                void navigator.clipboard?.writeText(path).catch(() => {});
                setMenuOpen(false);
              }}
            />
            {onRemove && (
              <MenuItem
                label="Remove attachment"
                danger
                onClick={() => {
                  onRemove();
                  setMenuOpen(false);
                }}
              />
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        role="menuitem"
        onClick={onClick}
        className={`w-full text-left px-3 py-1.5 hover:bg-bg-hover ${
          danger ? "text-red" : "text-text-2 hover:text-text-1"
        }`}
        style={
          danger
            ? { color: "var(--color-red)" }
            : undefined
        }
      >
        {label}
      </button>
    </li>
  );
}
