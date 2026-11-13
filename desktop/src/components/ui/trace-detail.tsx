// A run, opened: the same layout a workspace opens into. A main column (page
// header, a strip of views, the view itself) and, on the right, the details
// column with its own small tabs. A session is read the way a workspace is
// worked in — the conversation in the middle, what it touched beside it — so
// it is drawn with the same columns, heights and tabs rather than a report
// layout of its own.

import { type KeyboardEvent, type ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tab-panels";
import { cn } from "../../lib/utils";
import "./trace-detail.css";

export function TraceDetail({
  main,
  aside,
  className,
}: {
  main: ReactNode;
  /** The details column. Omitted (or null) when it is folded away. */
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("ui-trace-detail", className)}>
      <div className="ui-trace-detail-main">{main}</div>
      {aside}
    </div>
  );
}

export interface TraceDetailTab<T extends string> {
  id: T;
  label: string;
  /** Drawn after the label in the faint ink, like a count on any other tab. */
  count?: number;
}

/** The strip of views over a run — the workspace's centre tabs, fixed rather
 *  than closeable: these are the views a run has, not documents someone
 *  opened. */
export function TraceDetailTabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  trailing,
}: {
  label: string;
  tabs: TraceDetailTab<T>[];
  value: T;
  onChange: (value: T) => void;
  trailing?: ReactNode;
}) {
  const focusTab = (index: number, list: HTMLElement | null) => {
    const next = tabs[(index + tabs.length) % tabs.length];
    if (!next) return;
    onChange(next.id);
    list?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const list = event.currentTarget.closest<HTMLElement>("[role=tablist]");
    focusTab(
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : index + (event.key === "ArrowRight" ? 1 : -1),
      list,
    );
  };
  return (
    <div className="ui-workspace-tabs ui-trace-detail-tabs">
      <div className="ui-workspace-tab-scroll" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => (
          <div key={tab.id} className="ui-workspace-tab" data-selected={value === tab.id}>
            <button
              type="button"
              role="tab"
              data-tab={tab.id}
              aria-selected={value === tab.id}
              tabIndex={value === tab.id ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <span>{tab.label}</span>
              {tab.count != null && <small className="ui-trace-tab-count">{tab.count}</small>}
            </button>
          </div>
        ))}
      </div>
      {trailing && <div className="ui-trace-detail-tabs-trailing">{trailing}</div>}
    </div>
  );
}

/** The details column: a resizable right sidebar, an optional top line, then
 *  small pill tabs over panels. */
export function TraceAside<T extends string>({
  label,
  top,
  tabs,
  value,
  onChange,
  children,
}: {
  label: string;
  top?: ReactNode;
  tabs: TraceDetailTab<T>[];
  value: T;
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  return (
    <Sidebar
      side="right"
      defaultWidth={360}
      minWidth={280}
      maxWidth={640}
      resizable
      aria-label={label}
      className="ui-trace-aside"
    >
      {top && <div className="ui-trace-aside-top">{top}</div>}
      <Tabs
        className="ui-trace-aside-body"
        value={value}
        onValueChange={(next) => onChange(next as T)}
      >
        <div className="ui-trace-aside-toolbar">
          <TabsList className="ui-trace-aside-tabs" aria-label={`${label} tabs`}>
            {tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                {tab.label}
                {tab.count != null && <small>{tab.count}</small>}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {children}
      </Tabs>
    </Sidebar>
  );
}

export function TraceAsidePanel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TabsContent value={value} className="ui-trace-aside-panel">
      {children}
    </TabsContent>
  );
}

/** A caption over a run of rows inside a panel. */
export function TraceCaption({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="ui-trace-caption">
      <span>{children}</span>
      {trailing}
    </div>
  );
}

/** One fact about a run: a quiet label and its value on a 32px row. */
export function TraceFact({
  label,
  children,
  title,
}: {
  label: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <div className="ui-trace-fact" title={title}>
      <span className="ui-trace-fact-label">{label}</span>
      <span className="ui-trace-fact-value">{children}</span>
    </div>
  );
}

/** A centred note for a view with nothing in it: what is missing, and why. */
export function TraceNote({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="ui-trace-note">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
