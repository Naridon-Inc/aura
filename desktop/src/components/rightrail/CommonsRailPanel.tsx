// Right-rail Commons panel — the Lounge (presence + ship log + reactions)
// and the Plugin Exchange, homed in the rail alongside Files / Changes /
// PRs. These used to live only inside the Team surface's ContextPanel,
// which renders inline at ≥1040px and otherwise hides behind a
// conversation-gated slide-over — so on a normal window they were
// invisible. Here they get a permanent, discoverable tab.
//
// The rail is narrow, so the header carries an "expand" action that pops
// the same two panels into a full-width center tab (CommonsSurface) when
// the user wants room to breathe. This panel self-sources the team roster
// (so Lounge presence works standalone); a failing read degrades to an
// empty lounge, never a broken rail.

import { useEffect, useState } from "react";

import { api, type TeamMember } from "../../lib/api";
import { LoungePanel } from "../team/presentation/LoungePanel";
import { PluginBrowser } from "../team/presentation/PluginBrowser";
import { AppsLauncher } from "../commons/AppsLauncher";
import { SegmentedControl } from "../ui/segmented";

type CommonsTab = "lounge" | "apps" | "plugins";

const TABS: { value: CommonsTab; label: string }[] = [
  { value: "lounge", label: "Activity" },
  { value: "apps", label: "Apps" },
  { value: "plugins", label: "Plugins" },
];

type Props = {
  repoRoot: string;
  /** Pop the Commons into a full-width center tab. */
  onExpand: () => void;
};

export function CommonsRailPanel({ repoRoot, onExpand }: Props) {
  const [tab, setTab] = useState<CommonsTab>("lounge");
  const [members, setMembers] = useState<TeamMember[]>([]);

  // Roster for the Lounge presence rows, polled on the same calm cadence
  // as the Team manifest (15s); every read degrades to the last-good list.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .teamLoad(repoRoot)
        .then((m) => {
          if (alive) setMembers(m.members ?? []);
        })
        .catch(() => {
          /* room-less repo → quiet lounge */
        });
    load();
    const id = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [repoRoot]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-1">
      <div className="flex-shrink-0 flex items-center gap-2 px-2.5 h-9 border-b border-line-soft">
        <SegmentedControl<CommonsTab>
          value={tab}
          onChange={setTab}
          options={TABS}
          ariaLabel="Commons section"
        />
        <button
          type="button"
          onClick={onExpand}
          title="Open Commons in full width"
          aria-label="Open Commons in full width"
          className="ml-auto flex items-center justify-center w-7 h-7 rounded-md text-text-3 hover:text-text-1 hover:bg-bg-3 transition-colors"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M15 3h6v6M21 3l-9 9M9 21H3v-6M3 21l9-9"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {tab === "lounge" ? (
          <LoungePanel repoRoot={repoRoot} members={members} />
        ) : tab === "apps" ? (
          <AppsLauncher onGetApp={() => setTab("plugins")} />
        ) : (
          <PluginBrowser repoRoot={repoRoot} />
        )}
      </div>
    </div>
  );
}
