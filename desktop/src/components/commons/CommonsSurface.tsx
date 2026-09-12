// CommonsSurface — the first-class Commons destination (Build / Team /
// Plan / Trace / **Commons**). It exists because the Lounge + Plugin
// Exchange used to live only inside the Team surface's right ContextPanel,
// which renders inline only at ≥1040px and otherwise hides behind a
// conversation-gated slide-over — so on a normal window those whole
// feature-platforms were invisible. Here they get full center width and a
// guaranteed entry point.
//
// Pure host: it self-sources the team roster (so the Lounge presence works
// standalone) and renders the existing LoungePanel + PluginBrowser verbatim
// — nothing about those panels is rebuilt. A failing roster read degrades
// to an empty lounge, never a broken surface.

import { useState } from "react";

import { useTeamRoster } from "../../lib/useTeamRoster";
import { LoungePanel } from "../team/presentation/LoungePanel";
import { PluginBrowser } from "../team/presentation/PluginBrowser";
import { SegmentedControl } from "../ui/segmented";
import { AppsLauncher } from "./AppsLauncher";

export type CommonsTab = "lounge" | "apps" | "plugins";

const TABS: { value: CommonsTab; label: string }[] = [
  { value: "lounge", label: "Activity" },
  { value: "apps", label: "Apps" },
  { value: "plugins", label: "Plugins" },
];

type Props = {
  repoRoot: string;
  /** Initial tab — a launcher row can deep-link straight to Plugins. */
  initialTab?: CommonsTab;
};

export function CommonsSurface({ repoRoot, initialTab = "lounge" }: Props) {
  const [tab, setTab] = useState<CommonsTab>(initialTab);
  // Roster for the Lounge presence rows, on the shared 15s poll — the rail
  // Commons and this one read the same answer instead of each running their
  // own timer against the same manifest.
  const members = useTeamRoster(repoRoot);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-0">
      <header className="flex-shrink-0 flex items-center gap-3 px-4 h-12 border-b border-line-soft">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-text-1 leading-tight">
            Commons
          </div>
          <div className="text-[10.5px] text-text-3 leading-tight">
            Who’s here, what shipped, and the apps you can run
          </div>
        </div>
        <div className="ml-auto">
          <SegmentedControl<CommonsTab>
            value={tab}
            onChange={setTab}
            options={TABS}
            ariaLabel="Commons section"
          />
        </div>
      </header>

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
