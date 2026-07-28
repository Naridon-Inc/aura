// Right-rail collaboration container. Aura owns the always-on Manager
// surface (chat-first oversight). Chat owns conversations. Story owns
// intent + file-editing activity. Source Control remains the concrete
// git review/stage/commit surface.
//
// W1.4 — plugin right-rail panels stack alongside the four built-ins.
// A plugin tab id is shaped `plugin:<pluginId>:<panelId>` so the host
// can demux back to the bridge when dispatching events.

import { type ReactNode } from "react";
import { AgentIcon } from "../agent/AgentIcon";
import { AURA_MANAGER_ENABLED } from "../../lib/featureFlags";
import { PluginSandboxFrame } from "../plugins/PluginSandboxFrame";
import { type SegmentOption } from "../ui/segment";

export type BuiltinRightRailTab =
  | "files"
  | "changes"
  | "checks"
  | "prs"
  | "commons"
  | "scribble"
  | "aura"
  | "chat"
  | "story"
  | "tasks"
  | "browser";
export type RightRailTab = BuiltinRightRailTab | `plugin:${string}:${string}`;

export type PluginRightRailPanelDescriptor = {
  /** Tab id: `plugin:<pluginId>:<panelId>`. */
  id: RightRailTab;
  pluginId: string;
  panelId: string;
  title: string;
  /** Manifest-declared entry — usually an iframe-relative HTML path. */
  entry: string;
};

type Props = {
  activeTab: RightRailTab;
  onChangeTab: (tab: RightRailTab) => void;
  auraView: ReactNode;
  chatView: ReactNode;
  storyView: ReactNode;
  tasksView: ReactNode;
  /** ADE redesign — code-context tabs. The mockup homes the file tree
   *  and the git changes list on the right. Both are rendered only when
   *  the view prop is supplied, so the legacy rail keeps its four tabs
   *  unchanged when these are omitted. */
  filesView?: ReactNode;
  changesView?: ReactNode;
  /** ADE redesign — the Checks tab: a readable PR document (title +
   *  description + Git-status + Aura's semantic checks) over the full PR
   *  list. Checks and PRs are one surface — the list lives at the bottom of
   *  this view, not a separate tab. Rendered only when supplied, so the
   *  legacy rail is unaffected. */
  checksView?: ReactNode;
  /** ADE redesign — the in-rail browser. Rendered only when supplied. Note:
   *  no visible entry point right now (the globe was removed); the body stays
   *  wired so re-enabling it is a one-liner. */
  browserView?: ReactNode;
  /** Commons — the Lounge (presence + ship log) and Plugin Exchange, homed
   *  in the rail next to Checks. Rendered only when supplied, so the legacy
   *  rail is unaffected. */
  commonsView?: ReactNode;
  /** Scribble — a common markdown place to write: a shared team canvas + a
   *  private personal one, with a pinned strip on top. A lightweight markdown
   *  task manager. Rendered only when supplied. */
  scribbleView?: ReactNode;
  /** ADE mode collapses the rail to the workspace-context tabs
   *  (Files · Changes · Checks). The legacy Aura / Chat / Story / Tasks tabs
   *  are re-homed elsewhere in the IA (Chat→Team, Aura/Tasks→manager
   *  center panes, Story→Trace), and the earlier Trust/Review tabs folded
   *  into the Trace section — so they're hidden here rather than stacked
   *  on. That tab pile-up was the clutter. */
  adeMode?: boolean;
  /** Changed-file count badge for the Changes tab. */
  changesCount?: number;
  storyCount?: number;
  /** Unread / open comms count. */
  commsCount?: number;
  /** In-flight cloud A2A task count (Tasks tab badge). */
  tasksCount?: number;
  /** W1.4 — plugin panels. Each one renders as a separate tab whose
   *  body is a sandboxed srcdoc iframe wired into the plugin's bridge
   *  (PluginPanelFrame loads the entry HTML through the Rust-jailed
   *  asset reader). */
  pluginPanels?: PluginRightRailPanelDescriptor[];
};

// Segment icons — small stroked glyphs matching the old pill tabs.
const ICON = {
  scribble: (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 3.5A1.5 1.5 0 0 1 4.5 2h5L13 5.5v7A1.5 1.5 0 0 1 11.5 14h-7A1.5 1.5 0 0 1 3 12.5v-9z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M5.5 7.5h5M5.5 10h3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  ),
  chat: (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path
        d="M2 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 3v-3H3a1 1 0 0 1-1-1V4z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  ),
  story: (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M4 3h8M4 8h8M4 13h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M11 11.5 13.5 9l1.5 1.5-2.5 2.5H11v-1.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  ),
  tasks: (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h2M3 8h2M3 12h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M7 4h6M7 8h6M7 12h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  // Pull-request glyph — two branch nodes joined on the left, the right branch
  // curving back with an arrowhead (a change merging into the base). Marks the
  // Checks tab as the PR surface.
  checks: (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <circle cx="4" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 5.6v4.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path
        d="M12 10.4V7.2A2.2 2.2 0 0 0 9.8 5H7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.4 3.4 6.8 5l1.6 1.6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
} as const;

export function RightRail({
  activeTab,
  onChangeTab,
  auraView,
  chatView,
  storyView,
  tasksView,
  filesView,
  changesView,
  checksView,
  commonsView,
  scribbleView,
  browserView,
  adeMode = false,
  changesCount = 0,
  storyCount = 0,
  commsCount = 0,
  tasksCount = 0,
  pluginPanels = [],
}: Props) {
  // The rail's sections render through the one shared Segment control (the
  // connected-cell pill track used across the app's chrome), so build its
  // options in declaration order. Conditional surfaces only appear when their
  // view prop is supplied; ADE mode drops the legacy Aura/Chat/Story/Tasks
  // cluster (re-homed elsewhere in the IA).
  const tabOptions: SegmentOption<RightRailTab>[] = [];
  if (scribbleView != null)
    tabOptions.push({ value: "scribble", label: "Scribble", icon: ICON.scribble });
  if (filesView != null) tabOptions.push({ value: "files", label: "Files" });
  if (changesView != null)
    tabOptions.push({ value: "changes", label: withCount("Changes", changesCount) });
  if (checksView != null)
    tabOptions.push({ value: "checks", label: "Checks", icon: ICON.checks });
  if (commonsView != null) tabOptions.push({ value: "commons", label: "Commons" });
  if (!adeMode) {
    if (AURA_MANAGER_ENABLED)
      tabOptions.push({
        value: "aura",
        label: "Aura",
        icon: <AgentIcon agentId="aura-manager" size={11} />,
      });
    tabOptions.push({ value: "chat", label: withCount("Chat", commsCount), icon: ICON.chat });
    tabOptions.push({ value: "story", label: withCount("Story", storyCount), icon: ICON.story });
    tabOptions.push({ value: "tasks", label: withCount("Tasks", tasksCount), icon: ICON.tasks });
  }
  for (const p of pluginPanels) {
    tabOptions.push({
      value: p.id,
      label: p.title,
      icon: (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          // "This tab came from a plugin, not from us." Neither
          // `--color-accent-purple` nor `--color-accent-blue` is defined by any
          // pack, so this dot rendered as nothing at all. `--color-violet` is
          // the palette's real third-party mark and it is already what the
          // plugin surfaces use elsewhere.
          style={{ background: "var(--color-violet)" }}
          aria-hidden
        />
      ),
    });
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-bg-1">
      {/* The rail's own subtle tab segment — the same flat, accent-tint
          control the primary sidebar's section switcher uses (`.ade-seg`),
          NOT the bordered Medusa button-group. `--row` lays the cells out
          horizontally (glyph beside label). Scribble leads as the rail's home
          surface; the in-app browser has no tab entry for now (its body stays
          wired below). */}
      <div className="flex items-center h-9 px-2 border-b border-line-soft shrink-0 overflow-x-auto bg-bg-1">
        <div className="ade-seg ade-seg--row" role="tablist" aria-label="Rail sections">
          {tabOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={activeTab === opt.value}
              className={activeTab === opt.value ? "active" : ""}
              onClick={() => onChangeTab(opt.value)}
              title={opt.title ?? (typeof opt.label === "string" ? opt.label : undefined)}
            >
              {opt.icon}
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      {filesView != null && (
        <div className={activeTab === "files" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
          {filesView}
        </div>
      )}
      {changesView != null && (
        <div className={activeTab === "changes" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
          {changesView}
        </div>
      )}
      {checksView != null && (
        <div className={activeTab === "checks" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
          {checksView}
        </div>
      )}
      {commonsView != null && (
        <div className={activeTab === "commons" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
          {commonsView}
        </div>
      )}
      {scribbleView != null && (
        <div className={activeTab === "scribble" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
          {scribbleView}
        </div>
      )}
      {!adeMode && (
        <>
          {AURA_MANAGER_ENABLED && (
            <div className={activeTab === "aura" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
              {auraView}
            </div>
          )}
          <div className={activeTab === "chat" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
            {chatView}
          </div>
          <div className={activeTab === "story" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
            {storyView}
          </div>
          <div className={activeTab === "tasks" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
            {tasksView}
          </div>
        </>
      )}
      {pluginPanels.map((p) => (
        <div
          key={p.id}
          className={
            activeTab === p.id
              ? "flex-1 min-h-0 flex flex-col overflow-hidden"
              : "hidden"
          }
        >
          <PluginPanelFrame
            pluginId={p.pluginId}
            panelId={p.panelId}
            title={p.title}
            entry={p.entry}
          />
        </div>
      ))}
      {browserView != null && (
        <div className={activeTab === "browser" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
          {browserView}
        </div>
      )}
    </div>
  );
}

function PluginPanelFrame({
  pluginId,
  panelId,
  title,
  entry,
}: {
  pluginId: string;
  panelId: string;
  title: string;
  entry: string;
}) {
  // Narrow rail panel — the sandbox + bridge logic lives in the shared
  // PluginSandboxFrame so a rail panel and a full-surface app can never
  // diverge on how they're isolated.
  return (
    <PluginSandboxFrame
      pluginId={pluginId}
      surfaceId={panelId}
      title={title}
      entry={entry}
    />
  );
}

// Fold an optional count badge into a segment label. The shared Segment has no
// count slot, so the badge rides inside the cell's label next to the text; it
// stays quiet in both active and inactive cells.
function withCount(label: string, count?: number): ReactNode {
  if (count == null || count <= 0) return label;
  return (
    <>
      {label}
      <span className="text-[10px] tabular-nums rounded px-1 bg-ui-bg-base-hover text-ui-fg-subtle">
        {count}
      </span>
    </>
  );
}
