// Which box this is — the workspace's title in the work header, and behind it
// the cloud workspace details every cloud workspace opens: the repository it
// works on, when it was connected, its environment and status, and a way in
// over ssh.
//
// The rows are the library's, fed from what this kind of place can actually
// answer. A machine you brought has no meter Aura reads, so the CPU, memory
// and disk rows stay off rather than showing a gauge we made up, and there is
// no local-directory sync for it. Its name is not renamed here either: it is
// the name the runner board knows it by, and changing it on this laptop alone
// would lose the runner.
//
// The few things only Aura has — the folder the chat reads, a window of its
// own, leaving the machine — sit small at the bottom.

import { useCallback, useState } from "react";
import { AppWindow, Check, ChevronDown, Copy, FolderOpen, LogOut, Pencil } from "lucide-react";

import { api, type Machine } from "../../lib/api";
import { writeClipboardText } from "../../lib/clipboard";
import { formatAgo } from "../../lib/freshness";
import { askBoot, openShell as shellAsk, placeOfMachine } from "../../lib/place";
import { Button } from "../ui/button";
import {
  CloudOrganizationGlyph,
  CloudWorkspaceDetails,
  type CloudSession,
  type CloudSessionAction,
  type CloudSessionState,
} from "../ui/cloud-workspace";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import "../ui/cloud-patterns.css";
import "../ui/remote-workspace.css";

/** What the Environment row calls a machine: ours, by name. */
const ENVIRONMENT = "Aura";

export function MachineDetails({
  machine,
  repository,
  state,
  onClose,
  onPopOut,
  onMachineChanged,
  onOpenShell,
  onOpenJoin,
}: {
  machine: Machine | null;
  repository: string | null;
  /** Whether the machine is up — see `machineState`. */
  state: CloudSessionState;
  onClose: () => void;
  onPopOut?: () => void;
  onMachineChanged: (m: Machine) => void;
  onOpenShell?: () => Promise<void>;
  onOpenJoin?: () => void;
}) {
  const [editingDir, setEditingDir] = useState(false);
  const [dirDraft, setDirDraft] = useState(machine?.repo_path ?? "");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback(async (what: string, text: string) => {
    if (await writeClipboardText(text)) {
      setCopied(what);
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
    }
  }, []);

  // The line a terminal on this laptop would run to reach the machine — asked
  // of the place, the one thing that knows how it is dialled, rather than
  // spelled out here. It names the key by its path on this laptop; the key
  // itself never leaves it.
  const copySsh = useCallback(async () => {
    if (!machine) return;
    setError(null);
    try {
      await copy("boot", await askBoot(placeOfMachine(machine), shellAsk()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [machine, copy]);

  const openShell = useCallback(() => {
    if (!onOpenShell) return;
    setError(null);
    onOpenShell().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [onOpenShell]);

  const saveDir = useCallback(async () => {
    if (!machine) return;
    setError(null);
    try {
      const saved = await api.machineSave({
        // This row, by name. Without it the save is matched on the address
        // AND the folder being changed, so a new folder made a second row
        // beside this one instead of correcting it.
        id: machine.id,
        name: machine.name,
        host: machine.host,
        user: machine.user,
        key_path: machine.key_path,
        box_kind: machine.box_kind,
        repo_path: dirDraft.trim() || null,
      });
      onMachineChanged(saved);
      setEditingDir(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [machine, dirDraft, onMachineChanged]);

  if (!machine)
    return (
      <span className="ui-cloud-title ui-remote-machine-trigger">
        <CloudOrganizationGlyph size={18} />
        <span>No machine</span>
      </span>
    );

  const session: CloudSession = {
    // The popover shows no id while its internal block is off; the name is
    // what the runner board knows the machine by.
    id: machine.name,
    title: machine.name,
    repository: repository ?? "Not filed under one",
    branch: machine.repo_branch ?? "",
    state,
    cpu: 0,
    memory: 0,
    build: 0,
    // Unused: the cost row is off, since nothing meters a brought machine.
    cost: "",
    sync: "off",
    createdBy: machine.box_kind === "shared" ? "Shared" : "You",
    createdAt: formatAgo(machine.added_at * 1000),
  };

  // Waking is real: reaching a sleeping box starts it, and the join panel is
  // where that wait is shown. A running box has no restart to offer.
  const onAction = (action: CloudSessionAction) => {
    if (action === "wake") onOpenJoin?.();
    else if (action === "connection-details") openShell();
  };

  return (
    <CloudWorkspaceDetails
      session={session}
      machine
      resources={false}
      sync={false}
      internal={false}
      offers={[]}
      environment={ENVIRONMENT}
      // No setup status and no cost meter reach Aura for a machine you
      // brought, so neither row is drawn rather than drawn with filler.
      setup={null}
      cost={null}
      restart={state === "sleeping" && onOpenJoin ? "wake" : null}
      sshItems={[
        ...(onOpenShell ? [{ label: "Open via SSH", onSelect: openShell }] : []),
        { label: "Copy SSH command", onSelect: () => void copySsh() },
      ]}
      onAction={onAction}
      footer={
        <>
          {/* Which checkout the *conversation* reads. Shells and agents get
              their directory from the session they attach to, but the chat has
              no session to inherit from, so this is where its read_file, bash
              and prove act. Blank means the home directory, which is a real
              answer rather than a missing one. */}
          <div className="ui-cloud-row ui-remote-chat-folder">
            <span>Folder the chat reads</span>
            {editingDir ? (
              <Input
                className="ui-remote-mono"
                aria-label="Folder the conversation reads"
                autoFocus
                value={dirDraft}
                placeholder="~/workspaces/my-repo"
                onChange={(e) => setDirDraft(e.target.value)}
                onBlur={() => void saveDir()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveDir();
                  if (e.key === "Escape") setEditingDir(false);
                }}
              />
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="ui-remote-mono"
                    title={machine.repo_path || "~"}
                  >
                    <FolderOpen />
                    <span>{machine.repo_path || "~"}</span>
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => {
                      setDirDraft(machine.repo_path ?? "");
                      setEditingDir(true);
                    }}
                  >
                    <Pencil />
                    Change folder…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void copy("dir", machine.repo_path || "~")}>
                    {copied === "dir" ? <Check /> : <Copy />}
                    Copy folder path
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {onPopOut && (
            <div className="ui-cloud-row">
              <Button variant="ghost" size="xs" onClick={onPopOut}>
                <AppWindow />
                Open in its own window
              </Button>
            </div>
          )}
          <div className="ui-cloud-row">
            <Button variant="ghost" size="xs" onClick={onClose}>
              <LogOut />
              Leave this machine
            </Button>
          </div>
          {error && <p className="ui-remote-error">{error}</p>}
        </>
      }
    />
  );
}
