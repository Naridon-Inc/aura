import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight,
  ChevronUp,
  CircleAlert,
  ChevronDown,
  Copy,
  MoreHorizontal,
  GitFork,
  RotateCcw,
  ThumbsUp,
  ThumbsDown,
  Search,
  X,
} from "lucide-react";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { AsciiSpinner } from "./ascii-spinner";
import { Popover, PopoverTrigger, PopoverContent } from "./popover";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./dropdown-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "./alert-dialog";
/** A folded run of steps. Besides the count, the folded line can say how
 *  many steps failed or never reported back, and a short detail (the files a
 *  run of reads touched, or the step a live run is on) so it is useful
 *  without opening it. */
export function ToolGroup({
  count,
  messages = 0,
  running,
  failed = 0,
  incomplete = 0,
  detail,
  children,
  defaultOpen = false,
}: {
  count: number;
  messages?: number;
  running?: boolean;
  failed?: number;
  incomplete?: number;
  detail?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen),
    id = useId();
  return (
    <section className="ui-tool-group">
      <button
        className="ui-tool-group-trigger"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={14} className={open ? "ui-chevron-open" : ""} />
        {running ? <AsciiSpinner /> : failed > 0 && <CircleAlert size={14} />}
        <span>
          {count} tool {count === 1 ? "call" : "calls"}
          {messages > 0 && `, ${messages} ${messages === 1 ? "message" : "messages"}`}
        </span>
        {failed > 0 && <span className="ui-tool-group-flag">{failed} failed</span>}
        {incomplete > 0 && <span className="ui-tool-group-note">{incomplete} incomplete</span>}
        {detail && (
          <span className="ui-tool-group-detail" title={detail}>
            {detail}
          </span>
        )}
      </button>
      {open && (
        <div id={id} className="ui-tool-group-content">
          {children}
        </div>
      )}
    </section>
  );
}
export function SubagentRun({
  name,
  task,
  status,
  children,
  onOpen,
}: {
  name: string;
  task: string;
  status: "running" | "completed" | "error";
  children?: ReactNode;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="ui-subagent-run" data-status={status}>
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className={open ? "ui-chevron-open" : ""} />
        {status === "running" ? (
          <AsciiSpinner />
        ) : (
          <span className="ui-status-dot" data-status={status === "error" ? "error" : "review"} />
        )}
        <strong>{name}</strong>
        <span>{task}</span>
        <small>{status}</small>
      </button>
      {open && (
        <div>
          {children}
          {onOpen && (
            <Button size="xs" variant="ghost" onClick={onOpen}>
              Open agent chat
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
export interface TurnUsage {
  model: string;
  input: number;
  output: number;
  cached?: number;
  cost?: string;
}
/** One line of the usage card: a label and the figure it names. */
export interface TurnUsageRow {
  label: string;
  value: ReactNode;
  /** Plain-language expansion, shown when the row is hovered. */
  hint?: string;
}
/** One more entry in the turn's actions menu. */
export interface TurnAction {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}
function usageRows(usage: TurnUsage): TurnUsageRow[] {
  return [
    { label: "Model", value: usage.model },
    { label: "Input", value: usage.input.toLocaleString() },
    { label: "Output", value: usage.output.toLocaleString() },
    ...(usage.cached != null ? [{ label: "Cached", value: usage.cached.toLocaleString() }] : []),
    ...(usage.cost ? [{ label: "Cost", value: usage.cost }] : []),
  ];
}
/** The line under a finished answer: how long it took (which opens what it
 *  used and cost), copy, and the menu of things to do from this point. The
 *  usage card takes whatever rows the engine reported, and a note, so a reply
 *  that ran on a plan can say so instead of showing an empty price. */
export function TurnFooter({
  duration,
  timestamp,
  timestampTitle,
  text,
  usage,
  usageNote,
  files,
  onFork,
  onReset,
  onFeedback,
  actions = [],
  children,
}: {
  duration: string | null;
  timestamp?: string | null;
  timestampTitle?: string;
  text: string;
  usage?: TurnUsage | TurnUsageRow[];
  usageNote?: ReactNode;
  files?: ReactNode;
  onFork?: () => void;
  onReset?: () => void;
  onFeedback?: (positive: boolean) => void;
  /** The surface's own entries, after fork, reset and feedback. */
  actions?: TurnAction[];
  /** Quiet facts about the turn shown after the controls. */
  children?: ReactNode;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const afterMenu = useRef<(() => void) | undefined>(undefined);
  const rows = !usage ? [] : Array.isArray(usage) ? usage : usageRows(usage);
  const label = [duration, timestamp].filter(Boolean).join(" · ");
  const hasUsage = rows.length > 0 || usageNote != null;
  return (
    <div className="ui-turn-footer">
      {label &&
        (hasUsage ? (
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="ui-turn-usage-trigger" title={timestampTitle}>
                {label}
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="ui-usage-popover">
              {usageNote && <p className="ui-turn-usage-note">{usageNote}</p>}
              {rows.length > 0 && (
                <dl>
                  {rows.map((row) => (
                    <div key={row.label} className="ui-turn-usage-row" title={row.hint}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </PopoverContent>
          </Popover>
        ) : (
          <span className="ui-turn-usage-trigger" title={timestampTitle}>
            {label}
          </span>
        ))}
      <Button
        size="iconXs"
        variant="ghost"
        aria-label="Copy final message"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopyStatus("Copied");
          } catch {
            setCopyStatus("Copy unavailable");
          }
        }}
      >
        <Copy />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="iconXs" variant="ghost" aria-label="Message actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          onCloseAutoFocus={() => {
            const action = afterMenu.current;
            afterMenu.current = undefined;
            if (action) queueMicrotask(action);
          }}
        >
          {onFork && (
            <DropdownMenuItem
              onSelect={() => {
                afterMenu.current = onFork;
              }}
            >
              <GitFork />
              Fork chat from here
            </DropdownMenuItem>
          )}
          {onReset && (
            <DropdownMenuItem
              onSelect={() => {
                afterMenu.current = onReset;
              }}
            >
              <RotateCcw />
              Reset chat to here
            </DropdownMenuItem>
          )}
          {onFeedback && (
            <>
              <DropdownMenuItem onSelect={() => onFeedback(true)}>
                <ThumbsUp />
                Good response
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onFeedback(false)}>
                <ThumbsDown />
                Bad response
              </DropdownMenuItem>
            </>
          )}
          {actions.map((action) => (
            <DropdownMenuItem
              key={action.label}
              disabled={action.disabled}
              onSelect={() => {
                afterMenu.current = action.onSelect;
              }}
            >
              {action.icon}
              {action.label}
            </DropdownMenuItem>
          ))}
          {!onFork && !onReset && !onFeedback && actions.length === 0 && (
            <DropdownMenuItem disabled>No actions available</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {files}
      {children}
      <span role="status">{copyStatus}</span>
    </div>
  );
}
export function ResetChatDialog({
  open,
  onOpenChange,
  onReset,
  runningTasks = 0,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReset: (resetFiles: boolean) => void;
  runningTasks?: number;
}) {
  const [files, setFiles] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogTitle>Reset chat?</AlertDialogTitle>
        <AlertDialogDescription>
          Messages after this point will be removed.
          {runningTasks > 0 && ` This will stop ${runningTasks} running background tasks.`}
        </AlertDialogDescription>
        <label className="ui-check-label">
          <Checkbox checked={files} onCheckedChange={(checked) => setFiles(checked === true)} />
          Also reset file changes
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => onReset(files)}>Reset chat</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
export function TranscriptSearch({
  entries,
  onNavigate,
  onClose,
}: {
  entries: { id: string; text: string }[];
  onNavigate: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(""),
    [index, setIndex] = useState(0);
  const hits = useMemo(
    () =>
      query.trim()
        ? entries.filter((entry) => entry.text.toLowerCase().includes(query.toLowerCase()))
        : [],
    [entries, query],
  );
  const current = hits.length ? index % hits.length : 0;
  const navigate = (direction: number) => {
    if (!hits.length) return;
    const next = (current + direction + hits.length) % hits.length;
    setIndex(next);
    onNavigate(hits[next].id);
  };
  return (
    <div className="ui-transcript-search" role="search">
      <Search size={14} />
      <input
        autoFocus
        aria-label="Find in conversation"
        placeholder="Find in conversation"
        value={query}
        onChange={(event) => {
          const value = event.target.value;
          setQuery(value);
          setIndex(0);
          const first =
            value.trim() &&
            entries.find((entry) => entry.text.toLowerCase().includes(value.toLowerCase()));
          if (first) onNavigate(first.id);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            navigate(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span>
        {hits.length ? current + 1 : 0} / {hits.length}
      </span>
      <Button
        size="iconXs"
        variant="ghost"
        aria-label="Previous match"
        disabled={!hits.length}
        onClick={() => navigate(-1)}
      >
        <ChevronUp />
      </Button>
      <Button
        size="iconXs"
        variant="ghost"
        aria-label="Next match"
        disabled={!hits.length}
        onClick={() => navigate(1)}
      >
        <ChevronDown />
      </Button>
      <Button size="iconXs" variant="ghost" aria-label="Close search" onClick={onClose}>
        <X />
      </Button>
    </div>
  );
}
