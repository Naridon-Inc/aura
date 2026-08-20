// Right-rail collaboration container. Aura owns the always-on Manager
// surface (chat-first oversight). Chat owns conversations. Story owns
// intent + file-editing activity. Source Control remains the concrete
// git review/stage/commit surface.
//
// W1.4 — plugin right-rail panels stack alongside the four built-ins.
// A plugin tab id is shaped `plugin:<pluginId>:<panelId>` so the host
// can demux back to the bridge when dispatching events.

import { useRef, type ReactNode } from "react";
import { PluginSandboxFrame } from "../plugins/PluginSandboxFrame";

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
  /** Changed-file count badge for the Changes tab. */
  changesCount?: number;
  /** In-flight cloud A2A task count (Tasks tab badge). */
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
  // A folder — the Files tab is this workspace's tree.
  files: (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path
        d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.6h5A1.5 1.5 0 0 1 14 6.1v5.4A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  ),
  // A pane split down the middle — before on one side, after on the other.
  // The Changes tab's own split-diff view, at 11px.
  changes: (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <rect x="2.5" y="3" width="11" height="10" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 3v10" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.6 6.4h1.8M4.6 9.6h1.8M9.6 6.4h1.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  ),
  // Two rings that overlap — what this repo shares with the wider commons.
  commons: (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <circle cx="6.2" cy="8" r="3.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="9.8" cy="8" r="3.6" stroke="currentColor" strokeWidth="1.2" />
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
  filesView,
  changesView,
  checksView,
  commonsView,
  scribbleView,
  browserView,
  changesCount = 0,
  pluginPanels = [],
}: Props) {
  // The rail's sections render through the one shared Segment control (the
  // connected-cell pill track used across the app's chrome), so build its
  // options in declaration order. Conditional surfaces only appear when their
  // view prop is supplied; ADE mode drops the legacy Aura/Chat/Story/Tasks
  // cluster (re-homed elsewhere in the IA).
  const tabOptions: RailTab[] = [];
  if (scribbleView != null)
    tabOptions.push({ value: "scribble", label: "Scribble", icon: ICON.scribble });
  if (filesView != null)
    tabOptions.push({ value: "files", label: "Files", icon: ICON.files });
  if (changesView != null)
    tabOptions.push({
      value: "changes",
      label: "Changes",
      count: changesCount,
      icon: ICON.changes,
    });
  if (checksView != null)
    tabOptions.push({ value: "checks", label: "Checks", icon: ICON.checks });
  if (commonsView != null)
    tabOptions.push({ value: "commons", label: "Commons", icon: ICON.commons });
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

  // A section you have never opened is not mounted; a section you have opened
  // stays mounted.
  //
  // Every body here used to render on every rail render and merely wear
  // `hidden`. Hidden is a paint instruction, not a lifecycle one: all five
  // panels mounted, so opening a project ran the file tree's directory reads,
  // the git status, the checks fetch AND a 15-second team-roster poll for the
  // Commons lounge — four of them for tabs you were not looking at, before you
  // had clicked anything.
  //
  // Unmounting on every switch would be the other extreme: it throws away
  // scroll position and whatever you had typed in Scribble. So the rule is
  // once-seen-stays: the first time a section becomes active it mounts, and
  // from then on it keeps its `hidden` behaviour and all its state.
  const seen = useRef<Set<RightRailTab>>(new Set());
  seen.current.add(activeTab);
  const opened = (tab: RightRailTab) => seen.current.has(tab);

  return (
    <div className="h-full flex flex-col overflow-hidden bg-bg-1">
      {/* The rail's own subtle tab segment. `--row` lays the cells out
          horizontally; `--bare` is the deliberate opt-out from the track every
          other segmented strip in the app now wears, and it is the only one.

          Two structural reasons, not taste. The cells below change width as you
          switch — inside a bordered box that reads as the control resizing
          under your cursor. And the counts overhang their glyph, which the
          track's own `overflow: hidden` would clip.

          Only the tab you are on spells its name. This rail is ~310px wide and
          carries four sections; every
          cell wearing its glyph AND its word ran the strip off the end, so the
          last section was sliced in half by the window edge with nothing to say
          it was there. Scrolling chrome hides destinations — a section you
          cannot see is a section you do not know exists. So the others keep
          their mark and give back their word: the strip fits at any count,
          nothing falls off, and hovering (or a screen reader) still names them.
          Counts stay on show either way, because an unread number is the reason
          you would reach for the tab in the first place. */}
      <div className="flex items-center h-9 px-2 border-b border-line-soft shrink-0 overflow-x-auto bg-bg-1">
        <div
          className="ade-seg ade-seg--row ade-seg--bare"
          role="tablist"
          aria-label="Rail sections"
        >
          {tabOptions.map((opt) => {
            const active = activeTab === opt.value;
            const name = opt.count && opt.count > 0 ? `${opt.label} · ${opt.count}` : opt.label;
            return (
              <button
                key={opt.value}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={name}
                className={active ? "active" : "mark-only"}
                onClick={() => onChangeTab(opt.value)}
                title={name}
              >
                {opt.icon}
                {active && opt.label}
                {opt.count != null && opt.count > 0 && (
                  <span className="text-2xs tabular-nums rounded px-1 bg-state-hover text-text-3">
                    {opt.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {filesView != null && opened("files") && (
        <div className={activeTab === "files" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
          {filesView}
        </div>
      )}
      {changesView != null && opened("changes") && (
        <div className={activeTab === "changes" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
          {changesView}
        </div>
      )}
      {checksView != null && opened("checks") && (
        <div className={activeTab === "checks" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
          {checksView}
        </div>
      )}
      {commonsView != null && opened("commons") && (
        <div className={activeTab === "commons" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
          {commonsView}
        </div>
      )}
      {scribbleView != null && opened("scribble") && (
        <div className={activeTab === "scribble" ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "hidden"}>
          {scribbleView}
        </div>
      )}
      {pluginPanels
        .filter((p) => opened(p.id))
        .map((p) => (
          <div
            key={p.id}
            className={
              activeTab === p.id
                ? "flex-1 min-h-0 flex flex-col overflow-hidden"
                : "hidden"
            }
          >
            {/* A plugin panel is a sandboxed iframe running someone else's
                code. Mounting one for a tab nobody opened is worse than the
                cost — it runs a third party on your machine unasked. */}
            <PluginPanelFrame
              pluginId={p.pluginId}
              panelId={p.panelId}
              title={p.title}
              entry={p.entry}
            />
          </div>
        ))}
      {browserView != null && opened("browser") && (
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

// The rail's own tab shape. The shared `SegmentOption` folds everything into
// one `label` node, which is fine for a strip that always spells its cells out;
// this one shows the word for the active cell only, so the name and the count
// have to stay separable right up to the render.
type RailTab = {
  value: RightRailTab;
  label: string;
  count?: number;
  icon: ReactNode;
};
