// The right sidebar's body: one tab strip — Artifacts, All files, Changes,
// Checks, Tasks, then the Aura sections (Commons, plugin panels) drawn as tabs
// of the same strip — with the Review toggle and file search at its end. The
// git status row above it is `ReviewStateHeader`, mounted by the layout.
//
// A browser is not a details tab: it opens as a workspace tab from ＋.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { PanelActiveContext } from "../../lib/panelActive";
import { PluginSandboxFrame } from "../plugins/PluginSandboxFrame";
import { DetailsTabs, type DetailsTab } from "../ui/details-panel";
import { RailFilterContext } from "./railFilter";
import { useChangedFileCount } from "./useChangeList";

export type BuiltinRightRailTab =
  | "artifacts"
  | "files"
  | "changes"
  | "review"
  | "checks"
  | "prs"
  | "commons"
  | "aura"
  | "chat"
  | "story"
  | "tasks";

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
  /** Every section is drawn only when its view is supplied. */
  /** What the workspace has made — changed documents, pages and pictures,
   *  and a card for the code changes. */
  artifactsView?: ReactNode;
  filesView?: ReactNode;
  changesView?: ReactNode;
  /** The review checklist the Review button opens. Without it there is no
   *  Review button. */
  reviewView?: ReactNode;
  /** The pull request: its git status, Aura's checks, CI, comments, and the
   *  repo's other pull requests below. */
  checksView?: ReactNode;
  /** The project's tasks — the board's home beside the work. */
  tasksView?: ReactNode;
  /** Commons — the Lounge (presence + ship log) and Plugin Exchange. */
  commonsView?: ReactNode;
  /** The project the Changes view lists. The number beside "Changes" is
   *  counted from it by the same list the Changes header counts, so the two
   *  read the same. */
  changesRoot?: string | null;
  /** Plugin panels. Each is its own tab whose body is a sandboxed iframe
   *  wired into the plugin's bridge. */
  pluginPanels?: PluginRightRailPanelDescriptor[];
};

/** Tabs whose body reads the file filter — the search button only shows on
 *  these, because a filter box over a body that ignores it is a lie. */
const FILTERED: ReadonlySet<RightRailTab> = new Set(["files", "changes", "review"]);

/** Tabs where Enter in the filter box looks for the words inside the files:
 *  the Search pane opens with what was typed. */
const SEARCH_ON_ENTER: ReadonlySet<RightRailTab> = new Set(["files"]);

function searchInsideFiles(query: string) {
  window.dispatchEvent(new CustomEvent("aura:open-search", { detail: { query } }));
}

/** One tab body. `mounted` is the once-seen-stays rule below; `active` is
 *  whether it is the tab you are looking at right now.
 *
 *  Kept mounted is not the same as kept running. A body behind another tab
 *  holds its scroll, its half-typed message and its selection — that is why it
 *  stays — but its polls have nothing to keep current. `PanelActiveContext` is
 *  how the rail says "you're parked" without unmounting; a poll that reads it
 *  stops while hidden and catches up the moment the tab comes back. Every body
 *  goes through here so a tab added later cannot quietly reintroduce a
 *  background timer. */
function RailBody({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <PanelActiveContext.Provider value={active}>
      <div className={active ? "ui-details-panel ui-details-panel--fill" : "hidden"}>
        {children}
      </div>
    </PanelActiveContext.Provider>
  );
}

export function RightRail({
  activeTab,
  onChangeTab,
  artifactsView,
  filesView,
  changesView,
  reviewView,
  checksView,
  tasksView,
  commonsView,
  changesRoot,
  pluginPanels = [],
}: Props) {
  const changesCount = useChangedFileCount(changesView != null ? changesRoot : null);
  const tabs: DetailsTab[] = [];
  if (artifactsView != null) tabs.push({ value: "artifacts", label: "Artifacts" });
  if (filesView != null) tabs.push({ value: "files", label: "All files" });
  if (changesView != null) tabs.push({ value: "changes", label: "Changes", count: changesCount });
  if (checksView != null) tabs.push({ value: "checks", label: "Checks" });
  if (tasksView != null) tabs.push({ value: "tasks", label: "Tasks" });
  if (commonsView != null) tabs.push({ value: "commons", label: "Commons" });
  for (const p of pluginPanels) tabs.push({ value: p.id, label: p.title });

  // Once-seen-stays: a section mounts the first time it is opened and then
  // stays mounted (hidden) so its scroll and half-typed input survive.
  const seen = useRef<Set<RightRailTab>>(new Set());
  seen.current.add(activeTab);
  const opened = (tab: RightRailTab) => seen.current.has(tab);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = FILTERED.has(activeTab);

  // A tab opened from elsewhere — ⌘T, the palette, "watch them in Tasks" —
  // can sit past the strip's right edge in a narrow panel. Scroll the strip
  // just far enough that the open tab is in view, or the panel changes with
  // nothing in the strip saying why.
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = railRef.current?.querySelector<HTMLElement>(".ui-details-tabs");
    const tab = list?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (!list || !tab) return;
    const strip = list.getBoundingClientRect();
    const open = tab.getBoundingClientRect();
    if (open.left < strip.left) list.scrollLeft -= strip.left - open.left;
    else if (open.right > strip.right) list.scrollLeft += open.right - strip.right;
  }, [activeTab]);

  return (
    <div ref={railRef} className="ui-details-rail">
      <DetailsTabs
        tabs={tabs}
        value={activeTab}
        onValueChange={(next) => onChangeTab(next as RightRailTab)}
        reviewValue={reviewView != null ? "review" : undefined}
        search={
          filtered
            ? {
                open: searchOpen,
                onOpenChange: setSearchOpen,
                query,
                onQueryChange: setQuery,
                onSubmit: SEARCH_ON_ENTER.has(activeTab) ? searchInsideFiles : undefined,
              }
            : undefined
        }
      >
        <RailFilterContext.Provider value={filtered && searchOpen ? query : ""}>
          {artifactsView != null && opened("artifacts") && (
            <RailBody active={activeTab === "artifacts"}>{artifactsView}</RailBody>
          )}
          {filesView != null && opened("files") && (
            <RailBody active={activeTab === "files"}>{filesView}</RailBody>
          )}
          {changesView != null && opened("changes") && (
            <RailBody active={activeTab === "changes"}>{changesView}</RailBody>
          )}
          {reviewView != null && opened("review") && (
            <RailBody active={activeTab === "review"}>{reviewView}</RailBody>
          )}
          {checksView != null && opened("checks") && (
            <RailBody active={activeTab === "checks"}>{checksView}</RailBody>
          )}
          {tasksView != null && opened("tasks") && (
            <RailBody active={activeTab === "tasks"}>{tasksView}</RailBody>
          )}
          {commonsView != null && opened("commons") && (
            <RailBody active={activeTab === "commons"}>{commonsView}</RailBody>
          )}
          {pluginPanels
            .filter((p) => opened(p.id))
            .map((p) => (
              <RailBody key={p.id} active={activeTab === p.id}>
                {/* A plugin panel is a sandboxed iframe running someone else's
                    code. Mounting one for a tab nobody opened would run a
                    third party on your machine unasked. */}
                <PluginSandboxFrame
                  pluginId={p.pluginId}
                  surfaceId={p.panelId}
                  title={p.title}
                  entry={p.entry}
                />
              </RailBody>
            ))}
        </RailFilterContext.Provider>
      </DetailsTabs>
    </div>
  );
}
