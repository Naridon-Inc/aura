// Module-level store for the catalog of tools exposed by every enabled
// MCP server (Atlassian, Linear, GitHub, Sentry, …). Sits next to the
// pluginContributes store; the Composer pulls from both so slash
// commands + the @-tool mention picker see the same merged set.
//
// We don't poll — spawning an MCP server per render would be wasteful.
// `refreshMcpTools()` is called on boot and after the user adds /
// toggles / removes a server in Settings. Stale data is fine; users
// can hit the Settings "Refresh" button to force a re-read.

import { useSyncExternalStore } from "react";

import {
  api,
  type McpServerToolList,
  type McpToolInfo,
} from "./api";
import type { SlashCommand } from "./slashCommands";

type StoreShape = {
  perServer: McpServerToolList[];
  loadedAt: number | null;
  error: string | null;
  loading: boolean;
};

const state: StoreShape = {
  perServer: [],
  loadedAt: null,
  error: null,
  loading: false,
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

let inflight: Promise<void> | null = null;

/** Re-read every enabled server's tool catalog. Repeated calls coalesce
 *  so the Composer + Settings panel firing simultaneously only spawn
 *  each server once. */
export function refreshMcpTools(): Promise<void> {
  if (inflight) return inflight;
  state.loading = true;
  emit();
  inflight = (async () => {
    try {
      const rows = await api.mcpToolsList();
      state.perServer = rows;
      state.loadedAt = Date.now();
      state.error = null;
    } catch (e) {
      state.error = String(e);
    } finally {
      state.loading = false;
      inflight = null;
      emit();
    }
  })();
  return inflight;
}

export function useMcpTools(): StoreShape {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ── derived selectors ────────────────────────────────────────────────

/** Flat list of every enabled server's tools, regardless of error
 *  state. Useful for the @-mention picker which needs a single list. */
export function mcpToolsFlat(rows: McpServerToolList[]): McpToolInfo[] {
  return rows.flatMap((r) => (r.ok ? r.tools : []));
}

/** Slash command entries for MCP tools, slotting into the same shape
 *  the Composer's `filterSlashWithExtras` consumes. The `kind` is
 *  `"mcp-server"` (distinct from the legacy `"mcp"` aura-vcs route);
 *  the dispatcher in App.tsx routes these to `api.mcpToolInvoke`.
 *
 *  Naming: we register tools under `/<tool-name>` AND `/<server>:<tool>`
 *  so the user can pick either disambiguated or short. */
export function mcpSlashCommands(rows: McpServerToolList[]): SlashCommand[] {
  const out: SlashCommand[] = [];
  const seenShort = new Map<string, number>();
  for (const row of rows) {
    if (!row.ok) continue;
    for (const t of row.tools) {
      const short = `/${t.name}`;
      // If two servers expose the same tool name, only the first gets
      // the short alias; the rest are reachable via the prefixed form.
      const count = seenShort.get(short) ?? 0;
      seenShort.set(short, count + 1);
      const description = t.description?.trim() || `${row.server} → ${t.name}`;
      if (count === 0) {
        out.push({
          name: short,
          description,
          kind: "mcp-server",
          target: `${row.server}:${t.name}`,
        });
      }
      out.push({
        name: `/${row.server}:${t.name}`,
        description,
        kind: "mcp-server",
        target: `${row.server}:${t.name}`,
      });
    }
  }
  return out;
}

/** Mention-picker entries — one per (server, tool) pair. Shape is
 *  flatter than SlashCommand because the picker only needs label +
 *  description + target tuple. */
export type McpMentionItem = {
  /** Display label, e.g. `atlassian:create-issue`. */
  label: string;
  server: string;
  tool: string;
  description: string;
};

export function mcpMentionItems(rows: McpServerToolList[]): McpMentionItem[] {
  const out: McpMentionItem[] = [];
  for (const row of rows) {
    if (!row.ok) continue;
    for (const t of row.tools) {
      out.push({
        label: `${row.server}:${t.name}`,
        server: row.server,
        tool: t.name,
        description: t.description?.trim() || `${row.server} → ${t.name}`,
      });
    }
  }
  return out;
}

/** Filter mention items against a `@server:tool` query (the bit after
 *  the `@`, no leading sigil). Match either the full label or the
 *  tool-only suffix so the user can type `@create-issue` without
 *  remembering which server hosts it. */
export function filterMcpMentions(
  query: string,
  items: McpMentionItem[],
): McpMentionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, 12);
  return items
    .filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        it.tool.toLowerCase().startsWith(q),
    )
    .slice(0, 12);
}
