// `Pane` is a shared sub-pane shell with a collapsible header. The
// outer ReviewPanel (Blocks/Activity/Orchestration tabs) was removed
// in the chat-first sweep — Orchestration now lives behind the
// `/orchestrate` chat slash command. Pane stays exported because pane
// components in ./panes/ still mount it for their headers.

import { useState } from "react";
import { Button } from "./ui/button";
export function Pane({
  title,
  defaultOpen = true,
  actions,
  loading,
  onRefresh,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  actions?: React.ReactNode;
  loading?: boolean;
  onRefresh?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-line-soft">
      <header
        onClick={() => setOpen((v) => !v)}
        className="flex items-center h-8 px-3 cursor-pointer hover:bg-bg-2 select-none"
      >
        <span
          className="text-text-3 inline-block"
          style={{ width: 12, fontSize: 9 }}
        >
          {open ? "▾" : "▸"}
        </span>
        <span className="text-text-2 text-[11.5px] font-medium uppercase tracking-wider">
          {title}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {actions}
          {onRefresh && (
            <Button
              variant="ghost"
              size="icon-sm"
              title="Refresh"
              onClick={(e) => {
                e.stopPropagation();
                onRefresh();
              }}
              className="text-text-4 hover:bg-bg-hover"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.4" fill="none" />
                <path d="M9 5h3V2M7 11H4v3" stroke="currentColor" strokeWidth="1.3" fill="none" />
              </svg>
            </Button>
          )}
        </span>
      </header>
      {open && (
        <div className="px-3 pb-3 text-[12px] text-text-2">
          {loading ? (
            <div className="text-text-4 text-[11px] py-2">loading…</div>
          ) : (
            children
          )}
        </div>
      )}
    </section>
  );
}
