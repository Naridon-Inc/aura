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

export type BuiltinRightRailTab =
  | "files"
  | "changes"
  | "prs"
  | "commons"
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
  /** ADE redesign — the in-rail browser (far-end globe tab). A compact
   *  "mobile browser" that lives inside the rail rather than floating over
   *  the work area. Rendered only when supplied. */
  browserView?: ReactNode;
  /** ADE redesign — the PR triage Inbox, re-homed from the center into
   *  the rail (its own filter chips + list). PRs live here in one place;
   *  the Trace section no longer carries a Pull Requests row. Rendered
   *  only when supplied, so the legacy rail is unaffected. */
  prsView?: ReactNode;
  /** Commons — the Lounge (presence + ship log) and Plugin Exchange, homed
   *  in the rail next to PRs. Rendered only when supplied, so the legacy
   *  rail is unaffected. */
  commonsView?: ReactNode;
  /** ADE mode collapses the rail to the workspace-context tabs
   *  (Files · Changes · PRs). The legacy Aura / Chat / Story / Tasks tabs
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

export function RightRail({
  activeTab,
  onChangeTab,
  auraView,
  chatView,
  storyView,
  tasksView,
  filesView,
  changesView,
  prsView,
  commonsView,
  browserView,
  adeMode = false,
  changesCount = 0,
  storyCount = 0,
  commsCount = 0,
  tasksCount = 0,
  pluginPanels = [],
}: Props) {
  return (
    <div className="h-full flex flex-col overflow-hidden bg-bg-1">
      <div className="flex items-center h-9 border-b border-line-soft shrink-0 overflow-x-auto bg-bg-1">
        {filesView != null && (
          <TabButton
            active={activeTab === "files"}
            onClick={() => onChangeTab("files")}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
            Files
          </TabButton>
        )}
        {changesView != null && (
          <TabButton
            active={activeTab === "changes"}
            onClick={() => onChangeTab("changes")}
            count={changesCount}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path
                d="M5 2v8M5 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5 4a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11 6v4M11 16a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11 6a3 3 0 0 0-3-3H6"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Changes
          </TabButton>
        )}
        {prsView != null && (
          <TabButton
            active={activeTab === "prs"}
            onClick={() => onChangeTab("prs")}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <circle cx="4" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="4" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="12" cy="11" r="1.6" stroke="currentColor" strokeWidth="1.3" />
              <path
                d="M4 5.6v4.8M12 9.4V8a3 3 0 0 0-3-3H6.5"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            PRs
          </TabButton>
        )}
        {commonsView != null && (
          <TabButton
            active={activeTab === "commons"}
            onClick={() => onChangeTab("commons")}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
              <path
                d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="9" cy="7" r="3.2" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M22.5 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Commons
          </TabButton>
        )}
        {!adeMode && (
          <>
            {AURA_MANAGER_ENABLED && (
              <TabButton
                active={activeTab === "aura"}
                onClick={() => onChangeTab("aura")}
              >
                <AgentIcon agentId="aura-manager" size={11} />
                Aura
              </TabButton>
            )}
            <TabButton
              active={activeTab === "chat"}
              onClick={() => onChangeTab("chat")}
              count={commsCount}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path
                  d="M2 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 3v-3H3a1 1 0 0 1-1-1V4z"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
              Chat
            </TabButton>
            <TabButton
              active={activeTab === "story"}
              onClick={() => onChangeTab("story")}
              count={storyCount}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 3h8M4 8h8M4 13h5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
                <path
                  d="M11 11.5 13.5 9l1.5 1.5-2.5 2.5H11v-1.5z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
              Story
            </TabButton>
            <TabButton
              active={activeTab === "tasks"}
              onClick={() => onChangeTab("tasks")}
              count={tasksCount}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 4h2M3 8h2M3 12h2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
                <path
                  d="M7 4h6M7 8h6M7 12h6"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
              Tasks
            </TabButton>
          </>
        )}
        {pluginPanels.map((p) => (
          <TabButton
            key={p.id}
            active={activeTab === p.id}
            onClick={() => onChangeTab(p.id)}
          >
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: "var(--color-accent-purple, var(--color-accent-blue))" }}
              aria-hidden
            />
            {p.title}
          </TabButton>
        ))}
        {browserView != null && (
          // Standalone globe — deliberately NOT one of the context tabs. A
          // divider + an icon-only square button (no label, no tab underline)
          // floats it to the far end and sets it apart from the Files /
          // Changes / PRs menu tabs.
          <div className="ml-auto flex items-center h-full px-1.5">
            <span className="w-px h-4 bg-line-soft mr-1.5" aria-hidden />
            <button
              type="button"
              onClick={() => onChangeTab("browser")}
              title="Browser"
              aria-label="Browser"
              aria-pressed={activeTab === "browser"}
              className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                activeTab === "browser"
                  ? "bg-bg-3 text-accent"
                  : "text-text-3 hover:text-text-1 hover:bg-bg-3"
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="1.6" />
                <path
                  d="M2.5 12h19M12 2.5c2.6 2.6 4 6 4 9.5s-1.4 6.9-4 9.5c-2.6-2.6-4-6-4-9.5s1.4-6.9 4-9.5z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}
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
      {prsView != null && (
        <div className={activeTab === "prs" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
          {prsView}
        </div>
      )}
      {commonsView != null && (
        <div className={activeTab === "commons" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
          {commonsView}
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

function TabButton({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-full px-3 flex items-center gap-1.5 text-[11px] border-b-2 transition-colors whitespace-nowrap ${
        active
          ? "text-text-1 border-accent"
          : "text-text-3 border-transparent hover:text-text-1 hover:bg-bg-2"
      }`}
    >
      {children}
      {count != null && count > 0 && (
        <span
          className={`text-[10px] tabular-nums px-1 rounded ${
            active ? "text-text-2 bg-bg-2" : "text-text-4"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
