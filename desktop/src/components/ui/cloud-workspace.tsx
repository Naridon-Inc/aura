import { useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import {
  Cloud,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Link,
  Terminal,
  RotateCw,
  ArrowUpRight,
  FolderSync,
  Network,
  Moon,
  CircleAlert,
  LoaderCircle,
  Check,
  MoreHorizontal,
  FolderGit2,
  Clock,
  Wrench,
  CircleDollarSign,
  Cpu,
  MemoryStick,
  HardDrive,
  Activity,
  Pencil,
  ChevronRight,
} from "lucide-react";
import { Kbd } from "./kbd";
import { Button } from "./button";
import { Popover, PopoverTrigger, PopoverContent } from "./popover";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "./context-menu";
import { Switch } from "./switch";
import { Input } from "./input";
import { RepoAvatar } from "./repo-avatar";
import { Tooltip } from "./tooltip";
export type CloudSessionState =
  | "running"
  | "sleeping"
  | "starting"
  | "reconnecting"
  | "unresponsive"
  | "archived";
export interface CloudMember {
  id: string;
  name: string;
  initials: string;
  color: string;
  /** Their photo, when the account has one; the initials stand in otherwise. */
  photo?: string;
  active?: boolean;
  role: "Admin" | "Member";
}
export interface ForwardedPort {
  remote: number;
  local: number;
  process: string;
}
export interface CloudSession {
  id: string;
  title: string;
  repository: string;
  branch: string;
  state: CloudSessionState;
  cpu: number;
  memory: number;
  build: number;
  cost: string;
  sync: "off" | "syncing" | "synced" | "error";
  folder?: string;
  createdBy?: string;
  createdAt?: string;
  disk?: number;
  usage?: { cpu: number; memory: number; disk: number };
}
export type CloudSessionAction =
  | "wake"
  | "restart"
  | "connection-details"
  | "sync"
  | "copy-link"
  | "transfer"
  | "move-local"
  | "archive"
  | "copy-info"
  | "copy-directory";
const stateNames: Record<CloudSessionState, string> = {
  running: "Running",
  sleeping: "Stopped",
  starting: "Starting",
  reconnecting: "Connecting",
  unresponsive: "Unresponsive",
  archived: "Archived",
};
export function CloudStatus({ state }: { state: CloudSessionState }) {
  const Icon =
    state === "sleeping"
      ? Moon
      : state === "unresponsive"
        ? CircleAlert
        : state === "starting" || state === "reconnecting"
          ? LoaderCircle
          : Cloud;
  return (
    <span className="ui-cloud-status" data-state={state}>
      <Icon size={13} />
      {stateNames[state]}
    </span>
  );
}
export function CloudOrganizationGlyph({ size = 18 }: { size?: number }) {
  const dots = [
    [30, 70],
    [50, 70],
    [70, 70],
    [90, 70],
    [110, 70],
    [130, 70],
    [10, 50],
    [30, 50],
    [50, 50],
    [70, 50],
    [90, 50],
    [110, 50],
    [30, 30],
    [50, 30],
    [70, 30],
    [90, 30],
    [50, 10],
    [70, 10],
  ];
  return (
    <svg
      width={size}
      height={(size * 4) / 7}
      viewBox="0 0 140 80"
      fill="currentColor"
      aria-hidden="true"
    >
      {dots.map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={7.2} />
      ))}
    </svg>
  );
}
export function CloudWorkspaceGlyph({
  state = "idle",
  size = 16,
}: {
  state?: "idle" | "working" | "done" | "error";
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      className="ui-cloud-workspace-glyph"
      data-state={state}
      role="img"
      aria-label={`Cloud workspace, ${state}`}
    >
      {Array.from({ length: 25 }, (_, i) => (
        <circle
          key={i}
          cx={2 + (i % 5) * 4}
          cy={2 + Math.floor(i / 5) * 4}
          r="1"
        />
      ))}
    </svg>
  );
}
export function MemberAvatar({
  member,
  ref,
  ...button
}: {
  member: CloudMember;
  /** Lets a popover anchor on the face. */
  ref?: Ref<HTMLButtonElement>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style">) {
  return (
    <button
      ref={ref}
      type="button"
      {...button}
      className="ui-cloud-avatar"
      style={{ background: member.color }}
      data-active={member.active}
      aria-label={`${member.name}${member.active ? ", active now" : ""}`}
    >
      {member.photo ? <img src={member.photo} alt="" draggable={false} /> : member.initials}
    </button>
  );
}
export function CollaboratorPresence({
  members,
  onProfile,
  card,
}: {
  members: CloudMember[];
  /** Where clicking a face takes you, for a list that filters by person. */
  onProfile?: (member: CloudMember) => void;
  /** A small card about the face clicked, opened on the face itself. Given,
   *  it replaces `onProfile`: a face then goes nowhere. */
  card?: (member: CloudMember) => ReactNode;
}) {
  return (
    <div className="ui-cloud-presence" aria-label="People in this workspace">
      {members.map((m) =>
        card ? (
          <Popover key={m.id}>
            <PopoverTrigger asChild>
              <MemberAvatar member={m} />
            </PopoverTrigger>
            <PopoverContent align="end" className="ui-cloud-person-card">
              {card(m)}
            </PopoverContent>
          </Popover>
        ) : (
          <MemberAvatar key={m.id} member={m} onClick={onProfile ? () => onProfile(m) : undefined} />
        ),
      )}
    </div>
  );
}
export function CloudWorkspaceDetails({
  session,
  onAction,
  onRename,
  children,
  machine = true,
  offers,
  onSleep,
  resources = true,
  sync = true,
  restart,
  sshItems,
  environment = "Cloud",
  internal = true,
  setup,
  cost,
  footer,
  repositoryIcon,
  onOpenRepository,
  onOpenChange,
}: {
  session: CloudSession;
  onAction: (action: CloudSessionAction) => void;
  onRename?: (title: string) => void;
  children?: ReactNode;
  /** False for a workspace with no machine of ours behind it: the popover
   *  keeps what the workspace says about itself and leaves the machine out. */
  machine?: boolean;
  /** The actions this workspace offers; every one of them when not given. */
  offers?: readonly CloudSessionAction[];
  /** Puts the workspace to sleep; offered first in the menu when given. */
  onSleep?: () => void;
  /** False hides the CPU, Memory and Disk rows. */
  resources?: boolean;
  /** False hides the Sync to a local directory section. */
  sync?: boolean;
  /** The Status row's button: null hides it, and a word fixes it; when not
   *  given it is Wake for a sleeping workspace and Restart otherwise. */
  restart?: "restart" | "wake" | null;
  /** The ways to open the machine over SSH, in place of the fixed list. */
  sshItems?: { label: string; onSelect: () => void }[];
  /** What the Environment row says the machine is. */
  environment?: string;
  /** False hides the Internal resource details, which are for staff only. */
  internal?: boolean;
  /** The Setup row's value; null hides the row, and when not given it follows
   *  the workspace's state. */
  setup?: string | null;
  /** The Agent cost row's value; null hides the row, and when not given it is
   *  the session's cost. */
  cost?: string | null;
  /** Rows of the workspace's own, drawn after the sections and outside the
   *  internal block. */
  footer?: ReactNode;
  /** The repository's picture, beside its name. A plain repository picture —
   *  a folder — when not given. */
  repositoryIcon?: ReactNode;
  /** Opens the repository's page; given, the Repository row ends in an
   *  Open on GitHub button. */
  onOpenRepository?: () => void;
  /** Told when the popover opens or closes — a caller with live numbers
   *  reads them again as it opens. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [editing, setEditing] = useState(false),
    [title, setTitle] = useState(session.title),
    [internalOpen, setInternalOpen] = useState(false);
  const offered = (action: CloudSessionAction) => !offers || offers.includes(action);
  const menu =
    !!onSleep || offered("copy-link") || offered("transfer") || offered("move-local") || offered("archive");
  const restartAs =
    restart === undefined ? (session.state === "sleeping" ? "wake" : "restart") : restart;
  const saveTitle = () => {
    if (title.trim()) onRename?.(title.trim());
    setEditing(false);
  };
  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="ui-cloud-title"
          aria-label="Workspace details"
        >
          <CloudOrganizationGlyph size={18} />
          <span>{session.title}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="ui-cloud-details"
      >
        <header>
          {editing ? (
            <input
              className="ui-cloud-details-name"
              aria-label="Workspace title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            <strong>{session.title}</strong>
          )}
          {onRename && (
            <Button
              variant="ghost"
              size="iconXs"
              aria-label="Rename workspace"
              onClick={() => {
                setTitle(session.title);
                setEditing(true);
              }}
            >
              <Pencil />
            </Button>
          )}
          {menu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="iconXs"
                  aria-label="Workspace detail actions"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onSleep && (
                  <DropdownMenuItem onSelect={onSleep}>
                    <Moon />
                    Sleep
                  </DropdownMenuItem>
                )}
                {offered("copy-link") && (
                  <DropdownMenuItem onSelect={() => onAction("copy-link")}>
                    <Link />
                    Copy link
                  </DropdownMenuItem>
                )}
                {offered("transfer") && (
                  <DropdownMenuItem onSelect={() => onAction("transfer")}>
                    <FolderSync />
                    Transfer to local
                  </DropdownMenuItem>
                )}
                {offered("move-local") && (
                  <DropdownMenuItem onSelect={() => onAction("move-local")}>
                    <FolderSync />
                    Move to this computer…
                  </DropdownMenuItem>
                )}
                {offered("archive") && (
                  <>
                    {(!!onSleep || offered("copy-link") || offered("transfer") || offered("move-local")) && (
                      <DropdownMenuSeparator />
                    )}
                    <DropdownMenuItem onSelect={() => onAction("archive")}>
                      Archive workspace
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </header>
        <dl className="ui-cloud-resource-table">
          <dt>
            <FolderGit2 />
            Repository
          </dt>
          <dd>
            <span className="ui-cloud-repo">
              {repositoryIcon ?? <RepoAvatar name={session.repository} />}
              <span>{session.repository}</span>
            </span>
            {onOpenRepository && (
              <Tooltip content="Open on GitHub">
                <Button
                  variant="ghost"
                  size="iconXs"
                  aria-label="Open on GitHub"
                  onClick={onOpenRepository}
                >
                  <ArrowUpRight />
                </Button>
              </Tooltip>
            )}
          </dd>
          <dt>
            <Clock />
            Created
          </dt>
          <dd>
            {session.createdBy ?? "You"} · {session.createdAt ?? "Just now"}
          </dd>
          {machine ? (
            <>
              {setup !== null && (
                <>
                  <dt>
                    <Wrench />
                    Setup
                  </dt>
                  <dd>
                    {setup ??
                      (session.state === "starting" ? "Setting up…" : "Setup succeeded")}
                  </dd>
                </>
              )}
              {cost !== null && (
                <>
                  <dt>
                    <CircleDollarSign />
                    Agent cost
                  </dt>
                  <dd>{cost ?? session.cost}</dd>
                </>
              )}
            </>
          ) : (
            <>
              <dt>
                <Activity />
                Status
              </dt>
              <dd>
                <CloudStatus state={session.state} />
              </dd>
            </>
          )}
        </dl>
        {machine && (
          <section>
            <dl className="ui-cloud-resource-table">
              <dt>
                <Cloud />
                Environment
              </dt>
              <dd>{environment}</dd>
              <dt>
                <Activity />
                Status
              </dt>
              <dd>
                {restartAs && (
                  <button
                    className="ui-cloud-resource-restart"
                    disabled={session.state === "starting"}
                    onClick={() => onAction(restartAs)}
                  >
                    <RotateCw size={12} />
                    {restartAs === "wake" ? "Wake" : "Restart"}
                  </button>
                )}
                <CloudStatus state={session.state} />
              </dd>
              {resources && (
                <>
                  <dt>
                    <Cpu />
                    CPU
                  </dt>
                  <dd>
                    {session.cpu} cores ·{" "}
                    <strong>{session.usage?.cpu ?? 0}% used</strong>
                  </dd>
                  <dt>
                    <MemoryStick />
                    Memory
                  </dt>
                  <dd>
                    {session.memory} GB ·{" "}
                    <strong>{session.usage?.memory ?? 0}% used</strong>
                  </dd>
                  <dt>
                    <HardDrive />
                    Disk
                  </dt>
                  <dd>
                    {session.disk ?? 64} GB ·{" "}
                    <strong>{session.usage?.disk ?? 0}% used</strong>
                  </dd>
                </>
              )}
            </dl>
            <div className="ui-cloud-connection-split">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onAction("connection-details")}
              >
                <Terminal />
                Open via SSH
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="iconSm"
                    aria-label="Choose SSH application"
                  >
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {(
                    sshItems ??
                    ["Terminal", "VS Code", "Cursor"].map((label) => ({
                      label,
                      onSelect: () => onAction("connection-details"),
                    }))
                  ).map((item) => (
                    <DropdownMenuItem key={item.label} onSelect={item.onSelect}>
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </section>
        )}
        {machine && sync && (
          <section>
            <div className="ui-cloud-row">
              <strong>Sync to a local directory</strong>
              <Switch
                checked={session.sync !== "off"}
                onCheckedChange={() => onAction("sync")}
                aria-label="Sync to a local directory"
              />
            </div>
            <p className="ui-cloud-note">Copies files that are tracked in git</p>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="ui-cloud-sync-location"
                >
                  <FolderSync />
                  <span>{session.folder ?? "~/Cloud/Studio/" + session.id}</span>
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => onAction("copy-directory")}>
                  <Copy />
                  Copy directory path
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction("transfer")}>
                  <FolderSync />
                  Choose local directory…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {session.sync !== "off" && (
              <p className="ui-cloud-note" role="status">
                {session.sync === "synced"
                  ? "Up to date"
                  : session.sync === "error"
                    ? "Sync interrupted. Turn sync off and on to retry."
                    : "Syncing files…"}
              </p>
            )}
          </section>
        )}
        {footer && <section>{footer}</section>}
        {internal && (
          <details
            className="ui-cloud-internal-details"
            open={internalOpen}
            onToggle={(e) => setInternalOpen(e.currentTarget.open)}
          >
            <summary>
              <ChevronRight size={12} />
              Internal resource details
            </summary>
            <dl className="ui-cloud-resource-table">
              <dt>Workspace</dt>
              <dd>{session.id}</dd>
              {machine && session.build > 0 && (
                <>
                  <dt>Build</dt>
                  <dd>#{session.build}</dd>
                </>
              )}
              {session.branch && (
                <>
                  <dt>Branch</dt>
                  <dd>{session.branch}</dd>
                </>
              )}
            </dl>
            {offered("copy-info") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onAction("copy-info")}
              >
                <Copy />
                Copy details
              </Button>
            )}
            {children}
          </details>
        )}
      </PopoverContent>
    </Popover>
  );
}
export function CloudPortForwarding({
  ports,
  enabled,
  onEnabledChange,
  onAdd,
  onRemove,
  onOpen,
}: {
  ports: ForwardedPort[];
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  onAdd: (port: number) => void;
  onRemove: (port: number) => void;
  onOpen: (port: ForwardedPort) => void;
}) {
  const [port, setPort] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="ui-cloud-ports">
      <div className="ui-cloud-row">
        <Network size={14} />
        <strong>Forward ports</strong>
        <Switch
          checked={enabled}
          onCheckedChange={onEnabledChange}
          aria-label="Forward ports"
        />
      </div>
      {!enabled && <p>Connect local tools to servers in the workspace.</p>}
      {ports.map((p) => (
        <div className="ui-cloud-port" key={p.remote}>
          <div>
            <code>
              {p.remote} → localhost:{p.local}
            </code>
            <small>{p.process}</small>
          </div>
          <Button
            size="xs"
            variant="ghost"
            disabled={!enabled}
            onClick={() => onOpen(p)}
          >
            Open <ArrowUpRight />
          </Button>
          <Button
            size="iconXs"
            variant="ghost"
            aria-label={`Remove port ${p.remote}`}
            onClick={() => onRemove(p.remote)}
          >
            ×
          </Button>
        </div>
      ))}
      <form
        className="ui-cloud-inline"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(port);
          if (!Number.isInteger(n) || n < 1 || n > 65535 || n === 22) {
            setError("Enter a port from 1–65535. Port 22 is reserved for SSH.");
            return;
          }
          if (ports.some((p) => p.remote === n)) {
            setError("This port is already added.");
            return;
          }
          onAdd(n);
          setPort("");
          setError("");
        }}
      >
        <Input
          aria-label="Port number"
          placeholder="Port number"
          inputMode="numeric"
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
        <Button size="sm" variant="secondary" type="submit">
          Add
        </Button>
      </form>
      {error && (
        <p role="alert" className="ui-cloud-error">
          {error}
        </p>
      )}
    </div>
  );
}
export function CloudWorkspaceActions({
  members,
  assignee,
  following,
  onFollow,
  onReassign,
  onAction,
  offers,
  followBusy = false,
}: {
  members: CloudMember[];
  assignee: string;
  following: boolean;
  onFollow: () => void;
  /** Hands the workspace to another member; not given, Reassign is left
   *  out rather than offered and then refused. */
  onReassign?: (id: string) => void;
  onAction: (action: CloudSessionAction) => void;
  /** The actions this workspace offers; every one of them when not given. */
  offers?: readonly CloudSessionAction[];
  /** A follow is being saved. */
  followBusy?: boolean;
}) {
  const offered = (action: CloudSessionAction) => !offers || offers.includes(action);
  return (
    <div className="ui-cloud-inline">
      <Button
        variant="ghost"
        size="iconSm"
        aria-label={following ? "Unfollow workspace" : "Follow workspace"}
        aria-pressed={following}
        disabled={followBusy}
        onClick={onFollow}
      >
        {following ? <EyeOff /> : <Eye />}
      </Button>
      {offered("copy-link") && (
        <Button
          variant="ghost"
          size="iconSm"
          aria-label="Copy workspace link"
          onClick={() => onAction("copy-link")}
        >
          <Link />
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="iconSm"
            aria-label="Cloud workspace actions"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={followBusy} onSelect={onFollow}>
            {following ? <EyeOff /> : <Eye />}
            {following ? "Unfollow" : "Follow"}
          </DropdownMenuItem>
          {onReassign && members.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Reassign to</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {members.map((m) => (
                  <DropdownMenuItem key={m.id} onSelect={() => onReassign(m.id)}>
                    {m.name}
                    {m.id === assignee && <Check />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {offered("copy-link") && (
            <DropdownMenuItem onSelect={() => onAction("copy-link")}>
              <Link />
              Copy link <Kbd>⌘⇧C</Kbd>
            </DropdownMenuItem>
          )}
          {offered("copy-info") && (
            <DropdownMenuItem onSelect={() => onAction("copy-info")}>
              <Copy />
              Copy workspace info
            </DropdownMenuItem>
          )}
          {(offered("transfer") || offered("move-local") || offered("archive")) && <DropdownMenuSeparator />}
          {offered("transfer") && (
            <DropdownMenuItem onSelect={() => onAction("transfer")}>
              Transfer to local…
            </DropdownMenuItem>
          )}
          {offered("move-local") && (
            <DropdownMenuItem onSelect={() => onAction("move-local")}>
              Move to this computer…
            </DropdownMenuItem>
          )}
          {offered("archive") && (
            <DropdownMenuItem onSelect={() => onAction("archive")}>
              Archive
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
export function CloudWorkspaceContext({
  children,
  members,
  following,
  onFollow,
  onReassign,
  onAction,
}: {
  children: ReactNode;
  members: CloudMember[];
  following: boolean;
  onFollow: () => void;
  onReassign: (id: string) => void;
  onAction: (action: CloudSessionAction) => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onFollow}>
          {following ? "Unfollow" : "Follow"}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Reassign to</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {members.map((m) => (
              <ContextMenuItem key={m.id} onSelect={() => onReassign(m.id)}>
                {m.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onSelect={() => onAction("copy-link")}>
          Copy link <Kbd>⌘⇧C</Kbd>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onAction("transfer")}>
          Transfer to local…
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onAction("archive")}>
          Archive
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
export function SharedChatAttribution({
  member,
  time,
  own,
  to,
  children,
}: {
  member: CloudMember;
  time: string;
  /** Your own turn. Defaults to the preview's "you" member. */
  own?: boolean;
  /** Who a message to people is for — "to Maya" — when it was sent to them
   *  rather than to the agent. */
  to?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="ui-shared-message" data-own={own ?? member.id === "you"} data-to-people={!!to || undefined}>
      <header>
        <span
          className="ui-cloud-avatar ui-cloud-avatar-static"
          style={{ background: member.color }}
          aria-hidden="true"
        >
          {member.photo ? <img src={member.photo} alt="" draggable={false} /> : member.initials}
        </span>
        <strong>{member.name}</strong>
        {to && <span className="ui-shared-to">{to}</span>}
        <time>{time}</time>
      </header>
      <div>{children}</div>
    </div>
  );
}
export function CollaboratorTyping({ names }: { names: string[] }) {
  if (!names.length) return null;
  const said =
    names.length === 1
      ? `${names[0]} is typing…`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing…`
        : `${names.length} people are typing…`;
  return (
    <div className="ui-cloud-typing" role="status">
      <span>•••</span>
      {said}
    </div>
  );
}
