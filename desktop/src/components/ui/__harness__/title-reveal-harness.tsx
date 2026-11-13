// The name reveal, frozen at four instants so each can be looked at.
//
// Every row is the same tab strip and sidebar — the library's own components,
// wearing the marks the workspace strip resolves through `TabMark` — renamed at
// a different moment against a stopped clock, so one capture shows the reveal
// before it starts, a quarter in, past halfway, and done. `?row=<n>` keeps a
// single row; `?live=1` runs the clock for real and renames on a click.

import { useState, type JSX } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { TooltipProvider } from "../tooltip";
import { WorkspaceTabs, type WorkspaceTab } from "../workspace-tabs";
import { SidebarGroup, SidebarItem } from "../sidebar";
import { TabMark, tabMarkKey } from "../../TabMark";
import { REVEAL_MS, SETTLE_MS, setRevealClock } from "../../../lib/titleReveal";
import type { WorkPaneRef } from "../../../lib/editorStore";
import "../../../styles.css";

type TabSpec = { ref: WorkPaneRef; agentId?: string; before: string; after: string };

const TABS: TabSpec[] = [
  { ref: { kind: "manager", id: "review" }, agentId: "aura-manager", before: "New chat", after: "Review PR #93: cloud sign-in" },
  { ref: { kind: "agent", id: "claude" }, agentId: "claude-code", before: "Claude Code", after: "Fixing the retry backoff" },
  { ref: { kind: "manager", id: "login" }, agentId: "aura-manager", before: "New chat", after: "Fix the login redirect" },
  { ref: { kind: "browser", id: "docs" }, before: "New tab", after: "Aura docs" },
];

const ROWS = [
  { id: "cloud", before: "Untitled workspace", after: "Billing webhook retries", status: "working" as const },
  { id: "copy", before: "Kyoto", after: "Fix login redirect", status: "branch" as const },
];

/** Each frozen row: its caption, and how far into the reveal it is caught
 *  (null: never renamed). */
const MOMENTS: { caption: string; at: number | null }[] = [
  { caption: "Before. The tabs are called what they are", at: null },
  { caption: "25%. The old names give way, pixel by pixel", at: 0.25 },
  { caption: "60%. The new names resolve left to right", at: 0.6 },
  { caption: "After. Each tab is called what it is about", at: 1.5 },
];

function Moment({ row, renamed }: { row: number; renamed: boolean }): JSX.Element {
  const tabs: WorkspaceTab[] = TABS.map((t) => {
    const label = renamed ? t.after : t.before;
    const key = `h${row}:tab:${t.ref.kind}:${"id" in t.ref ? t.ref.id : t.ref.path}`;
    return {
      id: key,
      label,
      revealKey: key,
      markKey: tabMarkKey(t.ref, label, t.agentId),
      icon: <TabMark refr={t.ref} label={label} agentId={t.agentId} />,
      kind: t.ref.kind === "browser" ? "view" : "chat",
    };
  });
  return (
    <div style={{ display: "flex", border: "1px solid var(--ui-border)", borderRadius: 8, overflow: "hidden" }}>
      <aside className="ui-sidebar" style={{ width: 240, flex: "0 0 240px", padding: "6px 0" }}>
        <SidebarGroup title="Workspaces">
          {ROWS.map((r) => (
            <SidebarItem
              key={r.id}
              label={renamed ? r.after : r.before}
              revealKey={`h${row}:workspace:${r.id}`}
              status={r.status}
              selected={r.id === "cloud"}
            />
          ))}
        </SidebarGroup>
      </aside>
      <div style={{ flex: 1, minWidth: 0, background: "var(--color-bg-content)" }}>
        <WorkspaceTabs tabs={tabs} value={tabs[0].id} onChange={() => {}} onClose={() => {}} />
        <div style={{ height: 36 }} />
      </div>
    </div>
  );
}

const params = new URLSearchParams(location.search);
const only = params.get("row");
const live = params.get("live") === "1";

// A stopped clock: every row first appears at 0, is renamed at the instant
// that leaves it `at` of the way through at FINAL, and is drawn at FINAL.
const FINAL = SETTLE_MS * 10;
let now = 0;
if (!live) setRevealClock(() => now);

let renameRow: ((row: number) => void) | null = null;

function Harness(): JSX.Element {
  const [renamed, setRenamed] = useState<boolean[]>(() => MOMENTS.map(() => false));
  renameRow = (row) =>
    flushSync(() => setRenamed((r) => r.map((v, i) => (i === row ? true : v))));
  return (
    <TooltipProvider>
      <div style={{ padding: 24, fontFamily: "var(--font-sans, system-ui)", minHeight: "100vh", background: "var(--ui-bg, #1d1b1a)" }}>
        {MOMENTS.map((m, i) =>
          only != null && String(i) !== only ? null : (
            <section key={i} data-moment={i} style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 12, color: "var(--ui-muted-fg)", marginBottom: 8 }}>{m.caption}</div>
              <div onClick={live ? () => renameRow?.(i) : undefined}>
                <Moment row={i} renamed={renamed[i]} />
              </div>
            </section>
          ),
        )}
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);

if (!live) {
  // Once the first render has landed at 0, rename each row at its instant —
  // earliest start first, so the clock only ever moves forward and no row is
  // redrawn at a moment before its own reveal began.
  const renameAll = () => {
    if (!renameRow || !document.querySelector("section")) {
      requestAnimationFrame(renameAll);
      return;
    }
    MOMENTS.map((m, i) => ({ at: m.at, i }))
      .filter((m): m is { at: number; i: number } => m.at != null)
      .sort((a, b) => b.at - a.at)
      .forEach(({ at, i }) => {
        now = FINAL - at * REVEAL_MS;
        renameRow?.(i);
      });
    now = FINAL;
    // Two frames for the ticker to draw every row at FINAL.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document.body.dataset.ready = "yes";
      }),
    );
  };
  requestAnimationFrame(renameAll);
}
