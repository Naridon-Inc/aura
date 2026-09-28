// The host's project, browsed from a machine that does not have it.
//
// This is the piece that makes a shared session a place you can work rather
// than a place you can watch. There is no clone, no remote, no pull: every row
// here came off the session socket from the other person's disk, one folder or
// one file at a time. That is also the whole reason it is read-only — there is
// exactly one copy of this code and exactly one writer, which is what buys the
// "no conflicts, no git setup" this whole plane is for. A guest changes
// something by telling the host's agent to, in the composer next door.
//
// Three things this pane has to be honest about, because none of them can be
// inferred from an empty list:
//
//  1. **Watching is not reading.** A watcher gets the transcript the host
//     chose to publish, not the run of their disk. The pane says so instead of
//     showing a folder that is empty for a reason it will not name.
//  2. **The host can be away.** Every read is a round trip to a laptop that
//     may have closed. A failed read keeps the last listing on screen and puts
//     the reason above it — losing the tree as well would make a five-second
//     wifi drop look like the session ended.
//  3. **A folder can be bigger than we will send.** Truncation is said out
//     loud, never implied by a list that just stops.

import { useCallback, useEffect, useState, type JSX } from "react";

import {
  errText,
  listHostFiles,
  readHostFile,
} from "../../lib/sessionLiveCommands";
import type { AccessLevel, RemoteEntry } from "../../lib/sessionLiveFrames";
import { canReadHostFiles } from "../../lib/sessionLiveSelectors";
import { AsciiSpinner } from "../ui/ascii-spinner";

export type HostFilesPaneProps = {
  sessionId: string;
  /** What this desktop may do. Reading needs `drive`. */
  access: AccessLevel;
  /** For the one sentence that explains an empty pane. */
  hostName: string;
  hostOnline: boolean;
};

type Opened = { path: string; text: string; size: number };

/** Split a repo-relative path into the crumbs a person can click back to. */
function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const out: { name: string; path: string }[] = [];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push({ name: part, path: acc });
  }
  return out;
}

function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Bytes, in the shortest form that is still true. */
function size(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function HostFilesPane({
  sessionId,
  access,
  hostName,
  hostOnline,
}: HostFilesPaneProps): JSX.Element {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mayRead = canReadHostFiles(access);

  useEffect(() => {
    if (!mayRead) return;
    let live = true;
    setBusy(true);
    listHostFiles(sessionId, dir)
      .then((listing) => {
        if (!live) return;
        setEntries(listing.entries);
        setTruncated(listing.truncated);
        setError(null);
      })
      // The tree on screen is kept: a listing that failed is not a listing
      // that is empty, and the reason is worth more than a blank pane.
      .catch((e) => live && setError(errText(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [sessionId, dir, mayRead]);

  const open = useCallback(
    (entry: RemoteEntry) => {
      if (entry.dir) {
        setOpened(null);
        setDir(join(dir, entry.name));
        return;
      }
      const path = join(dir, entry.name);
      setBusy(true);
      readHostFile(sessionId, path)
        .then((file) => {
          setOpened({ path, text: file.text, size: file.size });
          setError(null);
        })
        .catch((e) => setError(errText(e)))
        .finally(() => setBusy(false));
    },
    [sessionId, dir],
  );

  if (!mayRead) {
    return (
      <div className="flex flex-col h-full min-h-0 items-center justify-center px-4 text-center">
        <p className="text-2xs text-text-3 leading-relaxed">
          You are watching this session. {hostName} can give you drive access,
          and their project opens here — no clone, no git.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Where you are. The project root is a crumb like any other, so there
          is always something to click back to. */}
      <div className="flex items-center gap-1 h-7 px-2 border-b border-line shrink-0 overflow-x-auto">
        <button
          type="button"
          onClick={() => {
            setOpened(null);
            setDir("");
          }}
          className="text-2xs text-text-3 hover:text-text-1 transition-colors shrink-0"
          title={`The root of ${hostName}'s project`}
        >
          project
        </button>
        {crumbs(dir).map((c) => (
          <span key={c.path} className="flex items-center gap-1 shrink-0">
            <span className="text-2xs text-text-4">/</span>
            <button
              type="button"
              onClick={() => {
                setOpened(null);
                setDir(c.path);
              }}
              className="text-2xs text-text-3 hover:text-text-1 transition-colors"
            >
              {c.name}
            </button>
          </span>
        ))}

        <div className="flex-1" />
        {busy && <AsciiSpinner size={11} />}
      </div>

      {/* A read can fail while the tree is still good. Say which failed and
          leave the tree alone. */}
      {error && (
        <div className="px-2 py-1 shrink-0 text-2xs text-amber-400/90 border-b border-line">
          {error}
        </div>
      )}
      {!hostOnline && (
        <div className="px-2 py-1 shrink-0 text-2xs text-text-4 border-b border-line">
          {hostName} is offline — these files are whatever was last read.
        </div>
      )}

      {opened ? (
        <>
          <div className="flex items-center gap-2 h-7 px-2 border-b border-line shrink-0">
            <span className="text-2xs text-text-2 truncate">{opened.path}</span>
            <span className="text-2xs text-text-4 shrink-0">{size(opened.size)}</span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setOpened(null)}
              className="px-1.5 h-5 rounded text-2xs text-text-3 hover:text-text-1 hover:bg-bg-2 transition-colors shrink-0"
            >
              Close
            </button>
          </div>
          {/* Read-only on purpose — see the note at the top of this file. */}
          <pre className="flex-1 min-h-0 overflow-auto px-2 py-1.5 text-2xs leading-relaxed text-text-2 font-mono whitespace-pre">
            {opened.text}
          </pre>
        </>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {entries.length === 0 && !busy && !error && (
            <p className="px-2 py-2 text-2xs text-text-4">This folder is empty.</p>
          )}
          {entries.map((entry) => (
            <button
              key={entry.name}
              type="button"
              onClick={() => open(entry)}
              className="flex items-center gap-1.5 w-full h-6 px-2 text-left hover:bg-bg-2 transition-colors group"
            >
              <span
                className={`text-2xs shrink-0 ${entry.dir ? "text-accent" : "text-text-4"}`}
              >
                {entry.dir ? "▸" : "·"}
              </span>
              <span className="text-2xs text-text-2 truncate group-hover:text-text-1">
                {entry.name}
              </span>
              <div className="flex-1" />
              <span className="text-2xs text-text-4 shrink-0 tabular-nums">
                {size(entry.size)}
              </span>
            </button>
          ))}
          {truncated && (
            <p className="px-2 py-1.5 text-2xs text-text-4">
              Only the first {entries.length} are shown — this folder holds more.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
