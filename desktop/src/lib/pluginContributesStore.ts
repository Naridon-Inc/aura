// Module-level store for the contributes payload of every enabled
// native plugin. Sits next to the static SLASH_COMMANDS catalog —
// surfaces that want plugin-declared entries pull from both.
//
// Reads on boot + refreshes on demand (Settings → Plugins rescan,
// future watcher event). Plugin contributes are static metadata
// (declared in `aura.plugin.json`), so we don't re-fetch per render;
// `useSyncExternalStore` keeps subscribers cheap.
//
// What this DOES handle:
//   • merging plugin slash commands into the static catalog (W1.3)
//   • exposing rail-tile / right-rail / status-pill contribs so UI
//     surfaces can iterate them
//   • kicking the plugin runtime (pluginRuntime.reconcilePluginRuntime)
//     after every refresh so workers spawn/teardown to match (W2)
//
// What this does NOT handle (later waves):
//   • dynamic registration (plugin calls `host.ui.registerSlashCommand`
//     after boot)

import { useSyncExternalStore } from "react";

import {
  api,
  type PluginAppContrib,
  type PluginContributesRow,
  type PluginRailTileContrib,
  type PluginRightRailPanelContrib,
  type PluginStatusPillContrib,
} from "./api";
import { reconcilePluginRuntime } from "./pluginRuntime";
import type { SlashCommand } from "./slashCommands";

type StoreShape = {
  rows: PluginContributesRow[];
  loadedAt: number | null;
  error: string | null;
};

const state: StoreShape = {
  rows: [],
  loadedAt: null,
  error: null,
};

const listeners = new Set<() => void>();

function emit() {
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): StoreShape {
  return state;
}

/** Trigger a fresh read of `plugin_contributes`. Safe to call multiple
 *  times — repeated calls coalesce via in-flight flag (see callers in
 *  pluginContributesBoot). */
export async function refreshPluginContributes(): Promise<void> {
  try {
    const rows = await api.pluginContributes();
    state.rows = rows;
    state.loadedAt = Date.now();
    state.error = null;
    // Bring the execution plane in line: spawn workers for newly
    // enabled plugins, tear down disabled/uninstalled ones. Idempotent.
    reconcilePluginRuntime(rows);
  } catch (e) {
    state.error = String(e);
  } finally {
    emit();
  }
}

export function usePluginContributes(): StoreShape {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ── derived selectors ─────────────────────────────────────────────

/** Plugin slash commands flattened into the same shape as the static
 *  SLASH_COMMANDS catalog so the Composer's `filterSlashWithExtras`
 *  can mix them in without special-casing the source. Target is a
 *  synthetic "plugin:<pluginId>:<commandId>" string the dispatcher
 *  (W1.4) decodes to fire through the bridge. */
export function pluginSlashCommands(rows: PluginContributesRow[]): SlashCommand[] {
  const out: SlashCommand[] = [];
  for (const row of rows) {
    for (const cmd of row.slash_commands) {
      out.push({
        name: cmd.id.startsWith("/") ? cmd.id : `/${cmd.id}`,
        description:
          cmd.description ?? `${cmd.title} (${row.plugin_id})`,
        kind: "ui",
        target: `plugin:${row.plugin_id}:${cmd.id}`,
      });
    }
  }
  return out;
}

/** Plugin-declared rail tiles, with their owning plugin id for routing
 *  taps back through the bridge. */
export type PluginRailTileEntry = PluginRailTileContrib & {
  pluginId: string;
};

export function pluginRailTiles(
  rows: PluginContributesRow[],
): PluginRailTileEntry[] {
  return rows.flatMap((r) =>
    r.rail_tiles.map((t) => ({ ...t, pluginId: r.plugin_id })),
  );
}

export type PluginRightRailPanelEntry = PluginRightRailPanelContrib & {
  pluginId: string;
};

export function pluginRightRailPanels(
  rows: PluginContributesRow[],
): PluginRightRailPanelEntry[] {
  return rows.flatMap((r) =>
    r.right_rail_panels.map((p) => ({ ...p, pluginId: r.plugin_id })),
  );
}

export type PluginStatusPillEntry = PluginStatusPillContrib & {
  pluginId: string;
};

export function pluginStatusPills(
  rows: PluginContributesRow[],
): PluginStatusPillEntry[] {
  return rows.flatMap((r) =>
    r.status_pills.map((p) => ({ ...p, pluginId: r.plugin_id })),
  );
}

/** Full-surface mini-apps declared by enabled plugins, tagged with the
 *  owning plugin id so the launcher can open them and the WorkSurface
 *  can resolve the iframe entry. `entry` stays relative; the runtime
 *  loads it through the jailed asset reader, same as a rail panel. */
export type PluginAppEntry = PluginAppContrib & {
  pluginId: string;
};

export function pluginApps(rows: PluginContributesRow[]): PluginAppEntry[] {
  return rows.flatMap((r) =>
    (r.apps ?? []).map((a) => ({ ...a, pluginId: r.plugin_id })),
  );
}

/** Look up a single app entry by its `<pluginId>:<appId>` key — the id a
 *  WorkSurface `app` pane carries. Returns null when the plugin is
 *  disabled/uninstalled (so the pane can render a graceful empty state). */
export function findPluginApp(
  rows: PluginContributesRow[],
  key: string,
): PluginAppEntry | null {
  const sep = key.lastIndexOf(":");
  if (sep <= 0) return null;
  const pluginId = key.slice(0, sep);
  const appId = key.slice(sep + 1);
  for (const r of rows) {
    if (r.plugin_id !== pluginId) continue;
    for (const a of r.apps ?? []) {
      if (a.id === appId) return { ...a, pluginId: r.plugin_id };
    }
  }
  return null;
}
