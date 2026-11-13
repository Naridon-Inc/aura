// The workspace's terminal panel: the lower half of the right column, under
// the git panel. Its header is a collapse chevron, one tab per thing that can
// run here (Setup, Run, then each terminal), a new-terminal button, and the
// caller's controls at the right end. Collapsed, the panel is just this
// header; the body is the caller's and is only drawn while it is open.

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "./tab-panels";
import { Button } from "./button";
import { Tooltip } from "./tooltip";
import { Kbd } from "./kbd";
import { AsciiSpinner } from "./ascii-spinner";
import "./details-terminal.css";

export interface DetailsTerminalTab {
  value: string;
  label: string;
  /** Tooltip — the command a Setup or Run tab will start, say. */
  title?: string;
  /** Setup is running: a working spinner before the label. */
  working?: boolean;
  /** Something is live in the tab: a dot before the label. */
  running?: boolean;
  /** A terminal's own tab closes it. Setup and Run have no close. */
  onClose?: () => void;
}

/** The label the collapse chevron wears, and its tooltip. */
export function terminalPanelToggleLabel(open: boolean): string {
  return open ? "Hide terminal panel" : "Show terminal panel";
}

/** Whether another terminal may be opened, and the tooltip that says so. */
export function newTerminalState(count: number, max: number): { disabled: boolean; hint: string } {
  return count >= max
    ? { disabled: true, hint: `Maximum ${max} terminals allowed` }
    : { disabled: false, hint: "New terminal" };
}

export function DetailsTerminal({
  tabs,
  value,
  onValueChange,
  open,
  onOpenChange,
  toggleShortcut,
  onNewTerminal,
  terminalCount,
  maxTerminals,
  newTerminalExtra,
  actions,
  children,
}: {
  tabs: DetailsTerminalTab[];
  value: string;
  onValueChange: (value: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The key that collapses the panel, shown in the chevron's tooltip. */
  toggleShortcut?: string;
  onNewTerminal: () => void;
  /** With `maxTerminals`, how many terminals are open. */
  terminalCount?: number;
  maxTerminals?: number;
  /** Drawn right after the new-terminal button (a shell picker, say). */
  newTerminalExtra?: ReactNode;
  /** Drawn at the far end of the header. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const toggleLabel = terminalPanelToggleLabel(open);
  const next =
    maxTerminals === undefined
      ? { disabled: false, hint: "New terminal" }
      : newTerminalState(terminalCount ?? 0, maxTerminals);
  // The tab row scrolls sideways when the column is narrow; the selected tab
  // is brought into view whenever it changes, so a new terminal is never
  // opened out of sight.
  const toolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = toolbarRef.current?.querySelector<HTMLElement>(
      '.ui-details-terminal-tablist [data-state="active"]',
    );
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [value, tabs.length, open]);
  return (
    <section className="ui-details-terminal" data-collapsed={!open || undefined}>
      <Tabs value={value} onValueChange={onValueChange} className="ui-details-terminal-tabs">
        <div className="ui-details-terminal-toolbar" ref={toolbarRef}>
          <Tooltip
            content={
              <>
                {toggleLabel} {toggleShortcut && <Kbd>{toggleShortcut}</Kbd>}
              </>
            }
          >
            <Button
              size="iconXs"
              variant="ghost"
              className="ui-details-terminal-toggle"
              aria-label={toggleLabel}
              aria-expanded={open}
              onClick={() => onOpenChange(!open)}
            >
              {open ? <ChevronDown /> : <ChevronUp />}
            </Button>
          </Tooltip>
          <TabsList className="ui-details-terminal-tablist" aria-label="Terminal tabs">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                title={tab.title}
                aria-label={tab.label}
                className="ui-details-terminal-tab"
                data-closable={tab.onClose ? true : undefined}
              >
                <span className="ui-details-terminal-tab-label">
                  {tab.working && <AsciiSpinner size={10} />}
                  {!tab.working && tab.running && <span className="ui-details-terminal-dot" aria-hidden />}
                  {tab.label}
                </span>
                {tab.onClose && (
                  <Tooltip content="Close terminal">
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={`Close ${tab.label}`}
                      className="ui-details-terminal-tab-close"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        tab.onClose?.();
                      }}
                    >
                      <X />
                    </span>
                  </Tooltip>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          <Tooltip content={next.hint}>
            <span className="ui-details-terminal-new">
              <Button
                size="iconXs"
                variant="ghost"
                aria-label="New terminal"
                disabled={next.disabled}
                onClick={onNewTerminal}
              >
                <Plus />
              </Button>
            </span>
          </Tooltip>
          {newTerminalExtra}
          {actions && <div className="ui-details-terminal-actions">{actions}</div>}
        </div>
      </Tabs>
      {open && <div className="ui-details-terminal-body">{children}</div>}
    </section>
  );
}

/** What a Setup or Run tab shows while nothing is running in it. */
export function DetailsTerminalEmpty({ children }: { children: ReactNode }) {
  return <div className="ui-details-terminal-empty">{children}</div>;
}

/** The dashed card a Setup or Run tab shows when there is nothing set up to
 *  run there yet. */
export function DetailsTerminalSetupCard({ children }: { children: ReactNode }) {
  return (
    <div className="ui-details-terminal-card-wrap">
      <div className="ui-details-terminal-card">{children}</div>
    </div>
  );
}
