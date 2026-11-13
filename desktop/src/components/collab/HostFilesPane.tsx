// The host's repository, browsed from a machine that does not have it.
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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { ChevronRight, Eye } from "lucide-react";

import {
  errText,
  listHostFiles,
  readHostFile,
} from "../../lib/sessionLiveCommands";
import type { AccessLevel, RemoteEntry } from "../../lib/sessionLiveFrames";
import { canReadHostFiles } from "../../lib/sessionLiveSelectors";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { DetailsCaption } from "../ui/details-panel";
import { FilePreview } from "../ui/file-preview";
import { FileTree, type FileTreeNode } from "../ui/file-tree";
import { EmptyState, LoadingState } from "../ui/state";
import "../ui/cloud-patterns.css";
import "../ui/details-files.css";
import "../ui/file-tab.css";
import "../ui/host-files.css";

export type HostFilesPaneProps = {
  sessionId: string;
  /** What this desktop may do. Reading needs `drive`. */
  access: AccessLevel;
  /** For the one sentence that explains an empty pane. */
  hostName: string;
  hostOnline: boolean;
};

type Opened = { path: string; text: string; size: number };

/** One folder as the host sent it, together with the folder it is OF. A row
 *  is opened against the folder it was listed from — never against the folder
 *  you have since asked for, which may not have answered yet. */
type Listing = { dir: string; entries: RemoteEntry[]; truncated: boolean };

/** No folder in this tree ever opens in place: opening one walks into it, the
 *  way the path above the rows says. */
const NONE_OPEN: ReadonlySet<string> = new Set();

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
  // A fresh object per ask, so asking for the same folder again — after a
  // read that failed, or to see what changed — asks again.
  const [want, setWant] = useState<{ dir: string }>(() => ({ dir: "" }));
  const [listing, setListing] = useState<Listing | null>(null);
  const [listingBusy, setListingBusy] = useState(false);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest read may open a file: a slow answer for the file you
  // clicked first must not land on top of the one you clicked second, or
  // pop open after you have walked to another folder.
  const reads = useRef(0);

  const mayRead = canReadHostFiles(access);

  useEffect(() => {
    if (!mayRead) return;
    let live = true;
    setListingBusy(true);
    listHostFiles(sessionId, want.dir)
      .then((answer) => {
        if (!live) return;
        setListing({ dir: want.dir, entries: answer.entries, truncated: answer.truncated });
        setError(null);
      })
      // The tree on screen is kept: a listing that failed is not a listing
      // that is empty, and the reason is worth more than a blank pane. The
      // path above it stays on the folder those rows belong to.
      .catch((e) => live && setError(errText(e)))
      .finally(() => live && setListingBusy(false));
    return () => {
      live = false;
    };
  }, [sessionId, want, mayRead]);

  const go = useCallback((dir: string) => {
    reads.current += 1;
    setReading(false);
    setOpened(null);
    setWant({ dir });
  }, []);

  const read = useCallback(
    (path: string) => {
      const ask = ++reads.current;
      setReading(true);
      readHostFile(sessionId, path)
        .then((file) => {
          if (ask !== reads.current) return;
          setOpened({ path, text: file.text, size: file.size });
          setError(null);
        })
        .catch((e) => ask === reads.current && setError(errText(e)))
        .finally(() => ask === reads.current && setReading(false));
    },
    [sessionId],
  );

  const here = listing?.dir ?? "";
  const nodes = useMemo<FileTreeNode[]>(
    () =>
      (listing?.entries ?? []).map((entry) => ({
        id: join(here, entry.name),
        name: entry.name,
        children: entry.dir ? [] : undefined,
      })),
    [listing, here],
  );
  const sizes = useMemo(
    () => new Map((listing?.entries ?? []).map((e) => [join(here, e.name), e.size])),
    [listing, here],
  );

  if (!mayRead) {
    return (
      <div className="ui-host-files-watching">
        <EmptyState
          size="sm"
          icon={Eye}
          title="You are watching this session"
          body={`${hostName} can give you drive access, and their repository opens here — no clone, no git.`}
        />
      </div>
    );
  }

  const busy = listingBusy || reading;
  let body: JSX.Element | null;
  if (opened) {
    // Read-only on purpose — see the note at the top of this file.
    body = (
      <FilePreview
        name={opened.path}
        kind="text"
        content={opened.text}
        actions={<small>{size(opened.size)}</small>}
        onClose={() => setOpened(null)}
      />
    );
  } else if (!listing) {
    body = listingBusy ? <LoadingState label={`Reading ${hostName}’s files…`} /> : null;
  } else {
    body = (
      <div className="ui-details-files">
        {nodes.length === 0 ? (
          <DetailsCaption>This folder is empty.</DetailsCaption>
        ) : (
          <FileTree
            nodes={nodes}
            label={`${hostName}’s repository`}
            onSelect={(node) => read(node.id)}
            expanded={NONE_OPEN}
            onExpandedChange={(_open, node) => go(node.id)}
            rowProps={(node) =>
              node.children ? {} : { title: `${node.name} — ${size(sizes.get(node.id))}` }
            }
          />
        )}
        {listing.truncated && (
          <DetailsCaption>
            Only the first {listing.entries.length} are shown — this folder holds more.
          </DetailsCaption>
        )}
      </div>
    );
  }

  return (
    <div className="ui-host-files">
      {/* Where you are. The project root is a crumb like any other, so there
          is always something to click back to. */}
      <div className="ui-details-toolbar">
        <nav
          className="ui-cloud-routine-breadcrumb"
          aria-label={`Where you are in ${hostName}’s repository`}
        >
          <button
            type="button"
            onClick={() => go("")}
            title={`The root of ${hostName}'s repository`}
            aria-current={here === "" ? "location" : undefined}
          >
            repository
          </button>
          {crumbs(here).map((c) => (
            <Fragment key={c.path}>
              <ChevronRight size={12} aria-hidden />
              <button
                type="button"
                onClick={() => go(c.path)}
                aria-current={c.path === here ? "location" : undefined}
              >
                {c.name}
              </button>
            </Fragment>
          ))}
        </nav>
        {busy && <AsciiSpinner size={11} />}
      </div>

      {/* A read can fail while the tree is still good. Say which failed and
          leave the tree alone. */}
      {error && (
        <div role="alert" className="ui-details-files-problem">
          {error}
        </div>
      )}
      {!hostOnline && (
        <DetailsCaption>{hostName} is offline — these files are whatever was last read.</DetailsCaption>
      )}

      {body}
    </div>
  );
}
