// The composer's "Link workspaces" dialog: lists every other project's
// workspaces when it opens, narrows them as the user types, and links or
// unlinks the one picked. Folders from anywhere on disk come in through the
// native picker. Links are stored with the workspace; the launch reads them.

import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { pickPath } from "../../lib/nativeDialog";
import {
  linkDirectory,
  linkWorkspace,
  unlinkDirectory,
  unlinkWorkspace,
  useWorkspaceLinks,
} from "../../lib/workspaceCustomization";
import {
  agentReadsLinkedDirs,
  groupLinkable,
  isMissing,
  loadLinkableWorkspaces,
  UNKNOWN_REPOSITORY,
  withGoneLinks,
  type LinkableWorkspace,
} from "../../lib/workspaceLinks";
import type { LinkWorkspacesDialog } from "../ui/link-workspaces-dialog";

type DialogProps = Parameters<typeof LinkWorkspacesDialog>[0];

const NONE: ReadonlySet<string> = new Set();

/** The quiet line for an agent that can't be handed linked folders, or null
 *  when it can (or isn't known yet). */
export function unsupportedLinkNote(
  agentId: string | null | undefined,
  agentLabel: string | null | undefined,
): string | null {
  if (!agentId || agentReadsLinkedDirs(agentId)) return null;
  return `${agentLabel || "This agent"} can't read linked folders.`;
}

export function useLinkWorkspaces({
  repoRoot,
  agentId,
  agentLabel,
  onClosed,
}: {
  repoRoot?: string | null;
  /** The engine the next message goes to (a brain id or an agent id). */
  agentId?: string | null;
  agentLabel?: string | null;
  /** Runs once the dialog has closed, to put the caret back in the field. */
  onClosed: () => void;
}) {
  const root = repoRoot ?? "";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [listed, setListed] = useState<{
    workspaces: LinkableWorkspace[];
    currentRepoId: string | null;
  }>();
  const [goneDirs, setGoneDirs] = useState<ReadonlySet<string>>(NONE);
  const links = useWorkspaceLinks(root);

  useEffect(() => {
    if (!open || !root) return;
    let alive = true;
    loadLinkableWorkspaces(root)
      .then((result) => alive && setListed(result))
      .catch(() => alive && setListed({ workspaces: [], currentRepoId: null }));
    return () => {
      alive = false;
    };
  }, [open, root]);

  useEffect(() => {
    if (!open || links.directoryPaths.length === 0) {
      setGoneDirs(NONE);
      return;
    }
    let alive = true;
    api
      .linkedDirsMissing([...links.directoryPaths])
      .then((gone) => alive && setGoneDirs(new Set(gone)))
      .catch(() => alive && setGoneDirs(NONE));
    return () => {
      alive = false;
    };
  }, [open, links.directoryPaths]);

  const linked = useMemo(() => new Set(links.workspaceIds), [links.workspaceIds]);
  const groups = useMemo(() => {
    if (!listed) return [];
    const all = withGoneLinks(listed.workspaces, links.workspaceIds);
    return groupLinkable(all, listed.currentRepoId, query, linked).map((group) => ({
      id: group.repoId || UNKNOWN_REPOSITORY,
      heading: group.repoName,
      rows: group.rows.map((ws) => ({
        id: ws.id,
        name: ws.name,
        directoryName: ws.directoryName,
        linked: linked.has(ws.id),
        missing: isMissing(ws),
      })),
    }));
  }, [listed, links.workspaceIds, linked, query]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const dialog: DialogProps = {
    open,
    onOpenChange: (next) => (next ? setOpen(true) : close()),
    query,
    onQueryChange: setQuery,
    directories: links.directoryPaths.map((path) => ({ path, missing: goneDirs.has(path) })),
    groups,
    unsupportedNote: unsupportedLinkNote(agentId, agentLabel),
    onBrowse: () => {
      if (!root) return;
      void pickPath({ directory: true, multiple: false, title: "Select directory to link" })
        .then((picked) => {
          const path = Array.isArray(picked) ? picked[0] : picked;
          if (path) linkDirectory(root, path);
        })
        .catch(() => {});
    },
    onUnlinkDirectory: (path) => unlinkDirectory(root, path),
    onToggleWorkspace: (id) =>
      linked.has(id) ? unlinkWorkspace(root, id) : linkWorkspace(root, id),
    onCloseAutoFocus: (event) => {
      event.preventDefault();
      onClosed();
    },
  };

  return {
    dialog,
    /** The add menu's "Link workspaces" row. */
    toggle: () => (open ? close() : setOpen(true)),
  };
}
