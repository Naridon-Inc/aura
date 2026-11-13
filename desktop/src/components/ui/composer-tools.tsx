import { Fragment, useRef, type ReactNode } from "react";
import {
  Map,
  FolderSymlink,
  Blocks,
  Plus,
  Paperclip,
  Folder,
  Bookmark,
  Terminal,
  X,
  RefreshCw,
} from "lucide-react";
import { Button } from "./button";
import { Switch } from "./switch";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
} from "./dropdown-menu";
import { AsciiSpinner } from "./ascii-spinner";
export interface ContextUsage {
  used: number;
  total: number;
  input?: number;
  output?: number;
  cached?: number;
}
export function ContextUsageIndicator({
  usage,
  loading,
  details = [],
}: {
  usage?: ContextUsage;
  loading?: boolean;
  /** Further readings listed under the token counts, in the same rows. */
  details?: { label: string; value: string }[];
}) {
  const percent =
    usage && usage.total > 0
      ? Math.min(100, Math.round((usage.used / usage.total) * 100))
      : undefined;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="xs" variant="ghost" aria-label="Context usage">
          {loading ? <AsciiSpinner /> : percent == null ? "Context" : `${percent}%`}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="ui-context-popover">
        <strong>Context usage</strong>
        {loading ? (
          <p>Loading context usage…</p>
        ) : usage ? (
          <>
            <p>
              {usage.used.toLocaleString()} / {usage.total.toLocaleString()} tokens
            </p>
            <div
              className="ui-context-meter"
              role="meter"
              aria-label="Context used"
              aria-valuenow={usage.used}
              aria-valuemin={0}
              aria-valuemax={usage.total}
            >
              <span style={{ width: `${percent}%` }} />
            </div>
            <dl>
              {usage.input != null && (
                <>
                  <dt>Input</dt>
                  <dd>{usage.input.toLocaleString()}</dd>
                </>
              )}
              {usage.output != null && (
                <>
                  <dt>Output</dt>
                  <dd>{usage.output.toLocaleString()}</dd>
                </>
              )}
              {usage.cached != null && (
                <>
                  <dt>Cached</dt>
                  <dd>{usage.cached.toLocaleString()}</dd>
                </>
              )}
              {details.map((row) => (
                <Fragment key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </Fragment>
              ))}
            </dl>
          </>
        ) : (
          <p>Context usage is unavailable for this model.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
export interface McpServerStatus {
  id: string;
  name: string;
  status: "connected" | "connecting" | "error" | "disabled";
  description?: string;
}
export function McpStatusMenu({
  servers,
  onConfigure,
  onRetry,
}: {
  servers: McpServerStatus[];
  onConfigure?: () => void;
  onRetry?: (id: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="iconSm" variant="ghost" aria-label="MCP servers">
          <Blocks />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="ui-mcp-popover">
        <strong>MCP servers</strong>
        {!servers.length && <p>No MCP servers configured.</p>}
        {servers.map((server) => (
          <div className="ui-mcp-row" key={server.id}>
            {server.status === "connecting" ? (
              <AsciiSpinner />
            ) : (
              <span
                className="ui-status-dot"
                data-status={
                  server.status === "connected"
                    ? "review"
                    : server.status === "error"
                      ? "error"
                      : "idle"
                }
              />
            )}
            <span>
              {server.name}
              <small>{server.description ?? server.status}</small>
            </span>
            {server.status === "error" && onRetry && (
              <Button
                size="iconXs"
                variant="ghost"
                aria-label={`Retry ${server.name}`}
                onClick={() => onRetry(server.id)}
              >
                <RefreshCw />
              </Button>
            )}
          </div>
        ))}
        {onConfigure && (
          <Button size="xs" variant="ghost" onClick={onConfigure}>
            Configure MCP servers
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
export function ComposerAddMenu({
  onAttach,
  onDirectory,
  onWorkspace,
  onIssue,
  onSnippet,
  onPlan,
  planMode = false,
  children,
}: {
  onAttach?: () => void;
  onDirectory?: () => void;
  onWorkspace?: () => void;
  onIssue?: () => void;
  onSnippet?: () => void;
  onPlan?: () => void;
  planMode?: boolean;
  /** Further rows a host adds below the shared ones, built from the same
   *  menu parts. */
  children?: ReactNode;
}) {
  const pending = useRef<(() => void) | undefined>(undefined);
  const choose = (action?: () => void) => {
    pending.current = action;
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="iconXs" variant="ghost" aria-label="Add context" className="ui-composer-add">
          <Plus />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        className="ui-composer-add-menu"
        onCloseAutoFocus={(event) => {
          if (pending.current) {
            event.preventDefault();
            const action = pending.current;
            pending.current = undefined;
            requestAnimationFrame(action);
          }
        }}
      >
        {onIssue && (
          <DropdownMenuItem onSelect={() => choose(onIssue)}>
            <span className="ui-issue-providers">
              <span aria-hidden="true">◒</span>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 1a7 7 0 0 0-2.2 13.6v-1.5c-1.9.3-2.3-.8-2.6-1.4-.3-.4-.7-.6-.7-.8.9-.2 1.3.9 1.9 1.1.5.2 1 .1 1.4 0 0-.4.2-.7.4-.9C3.9 10.8 3 9.9 3 8.1c0-.9.3-1.6.9-2.2-.2-.6-.2-1.4.1-2.1.8 0 1.6.5 2.1.9a7 7 0 0 1 3.8 0c.6-.4 1.3-.9 2.1-.9.3.7.3 1.5.1 2.1.6.6.9 1.3.9 2.2 0 1.8-.9 2.7-3.2 3 .4.4.5.8.5 1.4v2.1A7 7 0 0 0 8 1Z"
                />
              </svg>
            </span>
            <span className="ui-menu-text">Link issue</span>
            <DropdownMenuShortcut>⌘ I</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {onWorkspace && (
          <DropdownMenuItem onSelect={() => choose(onWorkspace)}>
            <FolderSymlink />
            <span className="ui-menu-text">Link workspaces</span>
          </DropdownMenuItem>
        )}
        {onPlan && (
          <DropdownMenuItem data-on={planMode || undefined} onSelect={() => choose(onPlan)}>
            <Map />
            <span className="ui-menu-text">{planMode ? "Exit plan mode" : "Plan mode"}</span>
            <DropdownMenuShortcut>⇧ Tab</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {onAttach && (
          <DropdownMenuItem onSelect={() => choose(onAttach)}>
            <Paperclip />
            <span className="ui-menu-text">Add attachment</span>
            <DropdownMenuShortcut>⌘ U</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {onDirectory && (
          <DropdownMenuItem onSelect={() => choose(onDirectory)}>
            <Folder />
            <span className="ui-menu-text">Add directory</span>
          </DropdownMenuItem>
        )}
        {onSnippet && (
          <DropdownMenuItem onSelect={() => choose(onSnippet)}>
            <Bookmark />
            <span className="ui-menu-text">Add snippet</span>
            <DropdownMenuShortcut>⌘ ;</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function AutoAcceptControl({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="ui-auto-accept">
      <Switch checked={value} onCheckedChange={onChange} disabled={disabled} />
      Auto-accept edits
    </label>
  );
}
export function TerminalCommandNotice({
  command,
  status,
  output,
  onOpen,
  onRefresh,
  onDismiss,
}: {
  command: string;
  status: "running" | "done" | "error";
  output?: ReactNode;
  onOpen?: () => void;
  onRefresh?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <section className="ui-terminal-command" data-status={status}>
      <header>
        {status === "running" ? <AsciiSpinner /> : <Terminal size={14} />}
        <code>{command}</code>
        {onOpen && (
          <Button size="xs" variant="ghost" onClick={onOpen}>
            Open terminal
          </Button>
        )}
        {onRefresh && (
          <Button
            size="iconXs"
            variant="ghost"
            aria-label="Refresh configuration"
            onClick={onRefresh}
          >
            <RefreshCw />
          </Button>
        )}
        {onDismiss && (
          <Button size="iconXs" variant="ghost" aria-label="Dismiss command" onClick={onDismiss}>
            <X />
          </Button>
        )}
      </header>
      {output && <pre>{output}</pre>}
    </section>
  );
}
