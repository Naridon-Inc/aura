// The row of tabs under the ⌘K field, with room on the right for the
// Workspaces tab's filters.

import type { ReactNode } from "react";

import { Tabs, TabsList, TabsTrigger } from "../ui/tab-panels";
import { paletteTabsFor, type PaletteTab } from "./paletteTabs";

export function PaletteTabsRow({
  tab,
  showRepositories,
  onTab,
  actions,
}: {
  tab: PaletteTab;
  showRepositories: boolean;
  onTab: (tab: PaletteTab) => void;
  actions?: ReactNode;
}) {
  return (
    <div className="ui-command-palette-tabs">
      <Tabs value={tab} onValueChange={(v) => onTab(v as PaletteTab)}>
        <TabsList className="ui-command-palette-tab-list" aria-label="Search in">
          {paletteTabsFor(showRepositories).map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="ui-command-palette-tab">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {actions && <div className="ui-command-palette-tab-actions">{actions}</div>}
    </div>
  );
}
