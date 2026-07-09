// Add-ons — one home for everything that extends what Aura can do, with two
// tracks behind a single segmented switch: add-ons "Built for Aura" (the
// signed, ADE-native Plugins) and add-ons "From VS Code" (the compatibility
// Extensions gallery). They used to be two separate rail rows; clubbing the
// closely-related pair into one tab keeps the sidebar calm without losing the
// ADE-first distinction (native plugins are the real platform; VS Code is the
// compatibility source). Each track is its own existing pane, mounted whole, so
// search state and in-flight installs behave exactly as before.

import { useState } from "react";
import { Blocks, Puzzle } from "lucide-react";

import type { PluginRow } from "../../../lib/api";
import { PluginsPane } from "./PluginsPane";
import { ExtensionsPane } from "./ExtensionsPane";

export type AddOnsTab = "plugins" | "extensions";

const TABS: { id: AddOnsTab; label: string; icon: typeof Blocks }[] = [
  { id: "plugins", label: "Built for Aura", icon: Blocks },
  { id: "extensions", label: "From VS Code", icon: Puzzle },
];

export function AddOnsPane({
  plugins,
  loading,
  refresh,
  initialTab = "plugins",
}: {
  plugins: PluginRow[];
  loading: boolean;
  refresh: () => void;
  /** Which track to open on — lets a deep-link land on the VS Code gallery. */
  initialTab?: AddOnsTab;
}) {
  const [tab, setTab] = useState<AddOnsTab>(initialTab);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The Add-ons switch — the one control that picks a track. Kept compact
          so each track's own pane carries the explaining copy below it. */}
      <div className="shrink-0 border-b border-line-soft px-8 pt-5 pb-3">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-text-4">
            Add-ons
          </span>
          <div className="ml-1 inline-flex rounded-md border border-line-soft bg-bg-1/40 p-0.5">
            {TABS.map((t) => {
              const active = tab === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`inline-flex items-center gap-1.5 rounded px-3 py-1 text-[12px] transition-colors ${
                    active
                      ? "bg-bg-2 text-text-1"
                      : "text-text-3 hover:text-text-1"
                  }`}
                  style={active ? { color: "var(--color-accent)" } : undefined}
                >
                  <Icon size={13} />
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* The selected track — its own pane, mounted whole. */}
      <div className="min-h-0 flex-1">
        {tab === "plugins" ? (
          <PluginsPane plugins={plugins} loading={loading} refresh={refresh} />
        ) : (
          <ExtensionsPane />
        )}
      </div>
    </div>
  );
}
