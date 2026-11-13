// The machine half of a cloud workspace's details: the rows and actions that
// are about the computer the workspace runs on, each read from that computer
// or from the chat on it, never filled in.
//
// The machine is found the way the chat finds it — this laptop's machine
// book, matched on the workspace's machine and folder (`useTarget`). When
// this laptop can't reach it (a teammate's machine you never connected, a
// folder that isn't there) the details say so and leave the machine's rows
// out, rather than showing an SSH button that can't dial or numbers nobody
// read.
//
// CPU, Memory and Disk are asked of the machine as the workspace opens and
// again when the details open, if the last answer is older than half a
// minute. Agent cost is the chat's own turns, summed, when this laptop runs
// the chat. Sync to a local directory copies the files git tracks into a
// folder here, now and every two minutes while the switch is on and the
// workspace is open.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { api } from "../../lib/api";
import { writeClipboardText } from "../../lib/clipboard";
import { threadKey } from "../../lib/cloudBoxChat";
import { setCloudNotice } from "../../lib/cloudPlace";
import type { CloudWorkspaceRow } from "../../lib/cloudWorkspacesApi";
import { REMOTE_EDITOR_NAMES, machineOpenInEditor, machineRemoteEditors } from "../../lib/editorRemote";
import { openRemoteWorkspace } from "../../lib/editorStore";
import { pickPath } from "../../lib/nativeDialog";
import { openShell as shellAsk } from "../../lib/place";
import { placeWorkCopyOut, placeWorkStats, type MachineStats, type WorkAt } from "../../lib/place/placeWork";
import { wantShellAt } from "../../lib/remotePlaces";
import { summarizeSessionSpend, type ChatSpend } from "../manager/chat/spend";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import type { CloudSession } from "../ui/cloud-workspace";
import { relTime } from "../workspaces/workspacesModel";
import { viewKey } from "./cloudPlaceKeep";
import {
  costLabel,
  defaultSyncFolder,
  payerOf,
  readSyncPrefs,
  resourcesOf,
  writeSyncPrefs,
  type SyncPrefs,
} from "./cloudWorkspaceMachine";
import { textOf, useTarget } from "./useBoxWork";
import { useKeptView } from "./useKeptView";

/** An answer younger than this is shown again rather than asked for again. */
const STALE_MS = 30_000;
/** How often a switched-on sync copies the files again. */
const SYNC_EVERY_MS = 120_000;

type Read = { stats: MachineStats | null; at: number; error: string | null };
const NOTHING_READ: Read = { stats: null, at: 0, error: null };

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function useWorkspaceMachine({
  row,
  repository,
  drives,
  boxDriven,
  driver,
  mine,
  starter,
}: {
  row: CloudWorkspaceRow;
  repository: string;
  /** This laptop runs the workspace's chat. */
  drives: boolean;
  /** The machine answers by itself; no laptop drives it. */
  boxDriven: boolean;
  /** The member whose laptop drives it, by name. */
  driver: string | null;
  /** You started the workspace. */
  mine: boolean;
  /** Who started it, by name: a machine that answers by itself runs on their
   *  Claude. */
  starter: string | null;
}) {
  const place = row.place ?? null;
  const target = useTarget(place);
  const at: WorkAt | null = target?.kind === "ok" ? target.at : null;
  const atKey = at ? [at.machineId, at.repoRoot, at.remoteRoot ?? ""].join("\u0000") : null;
  const atRef = useRef(at);
  atRef.current = at;

  // ── CPU, Memory, Disk ────────────────────────────────────────────────
  const [read, keepRead] = useKeptView<Read>(
    viewKey("box-stats", at?.machineId, at?.remoteRoot ?? at?.repoRoot),
    NOTHING_READ,
  );
  const readAt = useRef(read.at);
  readAt.current = read.at;
  const reading = useRef(false);
  const readStats = useCallback(
    (force: boolean) => {
      const where = atRef.current;
      if (!where || reading.current) return;
      if (!force && Date.now() - readAt.current < STALE_MS) return;
      reading.current = true;
      placeWorkStats(where)
        .then(
          (stats) => keepRead(() => ({ stats, at: Date.now(), error: null })),
          (e) => keepRead((was) => ({ ...was, at: Date.now(), error: textOf(e) })),
        )
        .finally(() => {
          reading.current = false;
        });
    },
    [keepRead],
  );
  useEffect(() => {
    if (atKey) readStats(false);
  }, [atKey, readStats]);

  // ── Agent cost ───────────────────────────────────────────────────────
  type Spend = Pick<ChatSpend, "sessionUsd" | "sessionEstimated" | "sessionPartial">;
  const [spend, setSpend] = useState<Spend | null>(null);
  const readCost = useCallback(() => {
    if (!drives) return;
    const sessionId = store()?.getItem(threadKey(row.id));
    if (!sessionId) return;
    api.managerStatus(sessionId).then(
      (s) => setSpend(summarizeSessionSpend(s.chat)),
      () => undefined,
    );
  }, [drives, row.id]);
  useEffect(readCost, [readCost]);
  const cost = place ? costLabel(drives ? spend : null, payerOf({ drives, boxDriven, driver, mine, starter })) : null;

  // ── Sync to a local directory ────────────────────────────────────────
  const [prefs, setPrefs] = useState<SyncPrefs>(() => {
    const s = store();
    return s ? readSyncPrefs(s, row.id) : { on: false, folder: null };
  });
  const keepPrefs = (next: SyncPrefs) => {
    setPrefs(next);
    const s = store();
    if (s) writeSyncPrefs(s, row.id, next);
  };
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    import("@tauri-apps/api/path")
      .then((m) => m.homeDir())
      .then(
        (h) => live && setHome(h),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, []);
  const folder = prefs.folder ?? (home ? defaultSyncFolder(home, repository, row.branch, row.id) : null);
  const [sync, setSync] = useState<CloudSession["sync"]>(prefs.on ? "syncing" : "off");
  const copying = useRef(false);
  const copyOut = useCallback(
    async (dest: string): Promise<{ files: number; folder: string } | string> => {
      const where = atRef.current;
      if (!where) return `This computer isn’t connected to ${place?.machine ?? "the machine"}.`;
      try {
        return await placeWorkCopyOut(where, dest);
      } catch (e) {
        return textOf(e);
      }
    },
    [place?.machine],
  );
  const syncNow = useCallback(async () => {
    if (!folder || copying.current) return;
    copying.current = true;
    setSync("syncing");
    const done = await copyOut(folder);
    copying.current = false;
    if (typeof done === "string") {
      // Said once, as it breaks; the switch keeps saying it until it mends.
      setSync((was) => {
        if (was !== "error") setCloudNotice(`Sync from ${place?.machine ?? "the machine"} stopped: ${done}`);
        return "error";
      });
    } else {
      setSync("synced");
    }
  }, [folder, copyOut, place?.machine]);
  useEffect(() => {
    if (!prefs.on || !atKey || !folder) return;
    void syncNow();
    const t = setInterval(() => void syncNow(), SYNC_EVERY_MS);
    return () => clearInterval(t);
  }, [prefs.on, atKey, folder, syncNow]);

  const toggleSync = () => {
    const on = !prefs.on;
    keepPrefs({ ...prefs, on });
    if (!on) setSync("off");
  };
  /** Transfer to local…, and Choose local directory…: pick a folder, and
   *  the workspace's files are copied into it now. */
  const transfer = async () => {
    if (!at || !place) return;
    let picked: string | string[] | null;
    try {
      picked = await pickPath({
        directory: true,
        title: `Copy this workspace’s files from ${place.machine} into…`,
        defaultPath: folder ?? undefined,
      });
    } catch (e) {
      setCloudNotice(`Couldn’t open the folder picker: ${textOf(e)}`);
      return;
    }
    if (typeof picked !== "string") return;
    keepPrefs({ ...prefs, folder: picked });
    setCloudNotice(`Copying from ${place.machine}…`);
    const done = await copyOut(picked);
    if (typeof done === "string") {
      setCloudNotice(`Couldn’t copy from ${place.machine}: ${done}`);
      if (prefs.on) setSync("error");
      return;
    }
    setCloudNotice(`Copied ${done.files} file${done.files === 1 ? "" : "s"} from ${place.machine} to ${done.folder}.`);
    if (prefs.on) setSync("synced");
  };
  const copyDirectory = () => {
    if (!folder) return;
    void writeClipboardText(folder).then((ok) =>
      setCloudNotice(ok ? "Directory path copied." : "Couldn’t reach the clipboard."),
    );
  };

  // ── Open via SSH ─────────────────────────────────────────────────────
  /** Into the machine's own workspace at this folder, with a shell tab
   *  opened there — the same shell its ＋ menu opens. */
  const openShell = () => {
    if (!at) return;
    const entry = { machineId: at.machineId, repoRoot: at.repoRoot, remoteRoot: at.remoteRoot ?? undefined };
    wantShellAt(entry);
    openRemoteWorkspace(entry);
  };
  // VS Code and Cursor, when one is installed here and its own ssh reaches
  // the machine; asked once per machine.
  const [editors, setEditors] = useState<string[]>([]);
  const editorMachine = at?.machineId ?? null;
  useEffect(() => {
    setEditors([]);
    if (!editorMachine) return;
    let live = true;
    machineRemoteEditors(editorMachine).then(
      (ids) => live && setEditors(ids),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [editorMachine]);
  const openInEditor = (id: string) => {
    if (!at) return;
    const name = REMOTE_EDITOR_NAMES[id] ?? id;
    machineOpenInEditor(at.machineId, id, at.remoteRoot ?? at.repoRoot).then(
      () => setCloudNotice(`Opening ${place?.remote_root ?? "the folder"} in ${name}…`),
      (e) => setCloudNotice(`Couldn’t open ${name}: ${textOf(e)}`),
    );
  };
  const copySsh = () => {
    if (!at) return;
    api
      .placeBoot({ machineId: at.machineId, remoteRoot: at.remoteRoot ?? null }, shellAsk())
      .then((line) => writeClipboardText(line))
      .then(
        (ok) => setCloudNotice(ok ? "SSH command copied." : "Couldn’t reach the clipboard."),
        (e) => setCloudNotice(`Couldn’t make the SSH command: ${textOf(e)}`),
      );
  };

  // ── What the popover is given ────────────────────────────────────────
  const reachable = !!at;
  const unreachable: ReactNode =
    place && target && target.kind !== "ok" ? (
      <p className="ui-cloud-note">
        {target.kind === "not-connected"
          ? `${place.machine} runs this workspace. This computer isn’t connected to it, so its CPU, memory, disk and SSH aren’t shown here.`
          : `${place.machine} doesn’t have this workspace’s folder (${place.remote_root}), so its machine details aren’t shown here.`}
      </p>
    ) : null;
  const statsNote: ReactNode =
    reachable && !read.stats && read.error ? <p className="ui-cloud-note">{read.error}</p> : null;
  const internals: ReactNode = place ? (
    <dl className="ui-cloud-resource-table">
      <dt>Place</dt>
      <dd>{place.place_id ?? "Not recorded"}</dd>
      <dt>Machine</dt>
      <dd>{place.machine}</dd>
      <dt>Folder</dt>
      <dd>{place.remote_root}</dd>
      <dt>Agent</dt>
      <dd>
        {place.engine}
        {place.agent_session_id ? ` · ${place.agent_session_id}` : ""}
      </dd>
      <dt>Lease</dt>
      <dd>
        {place.driver === "box" ? "The machine answers by itself" : `Driven from ${driver ?? "a member"}’s laptop`}
        {place.linked_at ? ` · since ${relTime(Math.floor(Date.parse(place.linked_at) / 1000), Date.now())}` : ""}
      </dd>
    </dl>
  ) : null;

  return {
    /** The machine's rows can be shown: this laptop reaches it. */
    reachable,
    /** Fields of the details' session the machine fills in. */
    session: {
      ...(read.stats ? resourcesOf(read.stats) : {}),
      sync,
      folder: folder ?? undefined,
    } satisfies Partial<CloudSession>,
    /** CPU, Memory and Disk have an answer to show. */
    resources: !!read.stats,
    cost,
    sshItems: [
      { label: "Open in a terminal tab", onSelect: openShell },
      ...editors.map((id) => ({ label: REMOTE_EDITOR_NAMES[id] ?? id, onSelect: () => openInEditor(id) })),
      { label: "Copy SSH command", onSelect: copySsh },
    ],
    note: unreachable ?? statsNote,
    internals,
    /** The details opened: read what may have moved since. */
    refresh: () => {
      readStats(false);
      readCost();
    },
    openShell,
    toggleSync,
    transfer: () => void transfer(),
    copyDirectory,
  };
}

/** Archive asks first: it ends the chat on the machine when you run it, and
 *  takes the workspace off everyone's list. */
export function ArchiveConfirm({
  open,
  onOpenChange,
  onArchive,
  machine,
  drives,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive: () => void;
  machine: string | null;
  drives: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogTitle>Archive this workspace?</AlertDialogTitle>
        <AlertDialogDescription>
          {machine && drives
            ? `The chat on ${machine} stops, and the workspace leaves everyone’s list. Its conversation is kept.`
            : "The workspace leaves everyone’s list. Its conversation is kept."}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onArchive}>Archive</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** ⌘⇧C copies the workspace's link while the workspace is open, as its
 *  menu says it does. */
export function useCopyLinkShortcut(copyLink: (() => void) | null) {
  const latest = useRef(copyLink);
  latest.current = copyLink;
  const on = copyLink !== null;
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey || e.altKey || e.ctrlKey || e.key.toLowerCase() !== "c") return;
      e.preventDefault();
      latest.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on]);
}
