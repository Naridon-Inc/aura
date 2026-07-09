// Plugin runtime — spawns and supervises the execution contexts of
// every enabled native plugin (W2 of the plugin platform).
//
// The earlier waves built the pieces; this module makes them run:
//
//   • contributes snapshot (pluginContributesStore) says WHAT is
//     installed + enabled and what each plugin declared;
//   • `PluginBridge` + transports (pluginBridge/) say HOW a sandbox
//     talks to the host, capability-checked per call;
//   • cmd_plugin_proxy.rs re-checks fs/net/kv server-side so the
//     renderer is never the last line of defense.
//
// One plugin can own several sandboxes: at most one Worker (its
// manifest `entry`, logic only) plus one sandboxed iframe per mounted
// right-rail panel. Each sandbox gets its own `PluginBridge` sharing
// the same parsed `CapabilitySet` and the singleton `MethodRouter`.
//
// Lifecycle: `reconcilePluginRuntime(rows)` diffs the desired set
// (enabled native plugins) against what's running — spawning new
// workers, tearing down removed/disabled ones, and restarting on a
// version change. The contributes store calls it after every refresh,
// so Settings toggles and `plugin_rescan` propagate without a reload.

import {
  CapabilitySet,
  MethodRouter,
  PluginBridge,
  createIframeTransport,
  createWorkerTransport,
} from "./pluginBridge";
import { api, type PluginContributesRow } from "./api";

// ── host method catalog ───────────────────────────────────────────────
//
// The router is module-level and registered exactly once. Method names
// are `family.verb`; the bridge maps them onto the plugin's declared
// `family:verb[:scope]` capabilities before these handlers run, and the
// fs/net/kv handlers delegate to the Rust proxy which re-checks against
// the registry (defense in depth).

let repoRootGetter: () => string | null = () => null;

/** Host context the runtime needs from the app shell. Called once at
 *  boot; the getter keeps the runtime workspace-agnostic. */
export function configurePluginRuntime(opts: { getRepoRoot: () => string | null }) {
  repoRootGetter = opts.getRepoRoot;
}

export type PluginToast = {
  pluginId: string;
  message: string;
  kind: "info" | "warn" | "error";
};

const router = new MethodRouter();

router.register("ui.toast", async (args, ctx) => {
  const a = (args ?? {}) as { message?: unknown; kind?: unknown };
  const message = typeof a.message === "string" ? a.message.slice(0, 500) : "";
  if (!message) throw new Error("ui.toast: missing message");
  const kind =
    a.kind === "warn" || a.kind === "error" ? a.kind : ("info" as const);
  const toast: PluginToast = { pluginId: ctx.pluginId, message, kind };
  window.dispatchEvent(new CustomEvent("aura:plugin-toast", { detail: toast }));
  return { shown: true };
});

router.register("storage.kv", async (args, ctx) => {
  const a = (args ?? {}) as {
    op?: unknown;
    key?: unknown;
    value?: unknown;
  };
  const key = typeof a.key === "string" ? a.key : "";
  if (!key) throw new Error("storage.kv: missing key");
  if (a.op === "set") {
    await api.pluginKvSet(ctx.pluginId, key, a.value ?? null);
    return { ok: true };
  }
  return { value: await api.pluginKvGet(ctx.pluginId, key) };
});

router.register("fs.read", async (args, ctx) => {
  const a = (args ?? {}) as { path?: unknown };
  const path = typeof a.path === "string" ? a.path : "";
  if (!path) throw new Error("fs.read: missing path");
  const root = repoRootGetter();
  if (!root) throw new Error("fs.read: no workspace open");
  // Rust re-checks the capability scope against the path + denylist.
  const body = await api.pluginProxyFsRead(ctx.pluginId, root, path);
  return { body };
});

router.register("net.fetch", async (args, ctx) => {
  const a = (args ?? {}) as {
    url?: unknown;
    method?: unknown;
    headers?: unknown;
    body?: unknown;
  };
  const url = typeof a.url === "string" ? a.url : "";
  if (!url) throw new Error("net.fetch: missing url");
  return api.pluginProxyNetFetch(ctx.pluginId, {
    url,
    method: typeof a.method === "string" ? a.method : undefined,
    headers: Array.isArray(a.headers)
      ? (a.headers as [string, string][])
      : undefined,
    body: typeof a.body === "string" ? a.body : undefined,
  });
});

router.register("aura.status", async () => {
  // Read-only repo overview — same payload the StatusBar trusts.
  return api.auraStatus();
});

// `realtime.channel` — rail-backed plugin↔plugin messaging (Commons
// W3a). The capability scope is the TOPIC (`realtime:channel:game-*`),
// and the envelope target the ACL checked must equal the topic actually
// sent — the same equality rule as `mcp.call`. Rust re-validates the
// capability, topic grammar, payload size and rate limit; on success we
// loopback-emit the event to the sender's own sandboxes so its other
// panel (or a solo workspace) sees the message without waiting a poll
// tick. Remote deliveries arrive via the module poller below as
// `realtime.<topic>` events with `self: false`.
router.register("realtime.channel", async (args, ctx) => {
  const a = (args ?? {}) as { op?: unknown; topic?: unknown; payload?: unknown };
  if (a.op !== undefined && a.op !== "send") {
    throw new Error(`realtime.channel: unknown op ${String(a.op)}`);
  }
  const topic = typeof a.topic === "string" ? a.topic : "";
  if (!topic) throw new Error("realtime.channel: missing topic");
  if (ctx.target !== topic) {
    throw new Error(
      `realtime.channel: envelope target (${ctx.target ?? "none"}) must equal the topic (${topic})`,
    );
  }
  const root = repoRootGetter();
  if (!root) throw new Error("realtime.channel: no workspace open");
  const ev = await api.pluginRtSend(ctx.pluginId, root, topic, a.payload ?? null);
  broadcast(ctx.pluginId, `realtime.${ev.topic}`, {
    topic: ev.topic,
    payload: ev.payload,
    from: { device: ev.from_device, display: ev.from_display },
    ts: ev.ts,
    self: true,
  });
  return { sent: true, ts: ev.ts };
});

// `mcp.call` — invoke a tool on the MCP server bundled in the SAME
// plugin bundle (`aura.mcp.json` sibling). Routing is host-decided:
// the plugin never names a server, only a tool, and the bridge ACL
// requires capability `mcp:call:<tool>`. The envelope target the ACL
// checked must equal the tool actually invoked — otherwise a plugin
// could declare one tool and call another.
router.register("mcp.call", async (args, ctx) => {
  const a = (args ?? {}) as { tool?: unknown; args?: unknown };
  const tool = typeof a.tool === "string" ? a.tool.trim() : "";
  if (!tool) throw new Error("mcp.call: missing tool");
  if (ctx.target !== tool) {
    throw new Error(
      `mcp.call: envelope target (${ctx.target ?? "none"}) must equal the tool name (${tool})`,
    );
  }
  const serverId = mcpRoute.get(ctx.pluginId);
  if (!serverId) {
    throw new Error(
      "mcp.call: this plugin bundle has no enabled MCP server (aura.mcp.json)",
    );
  }
  const res = await api.mcpToolInvoke(serverId, tool, a.args ?? {});
  if (!res.ok) throw new Error(res.error ?? "MCP tool call failed");
  return { text: res.text, raw: res.raw };
});

// ── running set ───────────────────────────────────────────────────────

type RunningPlugin = {
  pluginId: string;
  version: string;
  capabilities: CapabilitySet;
  /** Logic sandbox (manifest `entry`). Absent when the entry failed to
   *  load — panels can still run. */
  worker: Worker | null;
  workerBridge: PluginBridge | null;
  blobUrl: string | null;
  /** UI sandboxes, one bridge per mounted panel iframe. */
  panelBridges: Map<HTMLIFrameElement, PluginBridge>;
  /** Declares `realtime:channel` → the module poller serves it. */
  wantsRealtime: boolean;
};

const running = new Map<string, RunningPlugin>();

/** pluginId → bundled MCP server id. Refreshed on every reconcile (a
 *  Settings toggle of the sibling server updates routing without
 *  restarting the worker). Absent/null = no enabled bundled server. */
const mcpRoute = new Map<string, string | null>();

function parseCaps(row: PluginContributesRow): CapabilitySet {
  const r = CapabilitySet.fromManifestStrings(row.capabilities);
  // The registry already validated these at scan time; a parse failure
  // here means the renderer saw rows the registry would have rejected.
  // Fail closed with an empty set (plugin runs, every host call denies).
  return r instanceof CapabilitySet ? r : new CapabilitySet();
}

/** Raw-string probe rather than `CapabilitySet.allows` — a scoped grant
 *  (`realtime:channel:game-*`) deliberately denies an unscoped query,
 *  but here we only ask "does this plugin do realtime at all?". */
function declaresRealtime(row: PluginContributesRow): boolean {
  return row.capabilities.some(
    (c) => c === "realtime:channel" || c.startsWith("realtime:channel:"),
  );
}

function onDenied(pluginId: string) {
  return (info: { method: string; target?: string }) => {
    // Surfaced for plugin authors; the Settings → Plugins pane reads
    // the same event to show a "requested permission" hint.
    window.dispatchEvent(
      new CustomEvent("aura:plugin-capability-denied", {
        detail: { pluginId, method: info.method, target: info.target },
      }),
    );
  };
}

async function spawnWorker(p: RunningPlugin, row: PluginContributesRow) {
  if (!row.entry) return;
  let code: string;
  try {
    code = (await api.pluginAssetRead(row.plugin_id, row.entry)).body;
  } catch (e) {
    console.warn(`[pluginRuntime] ${row.plugin_id}: entry load failed`, e);
    return;
  }
  // Blob workers run same-origin but have NO Tauri IPC (no `window`),
  // so the bridge is their only host channel.
  const blobUrl = URL.createObjectURL(
    new Blob([code], { type: "text/javascript" }),
  );
  const worker = new Worker(blobUrl);
  const bridge = new PluginBridge({
    pluginId: row.plugin_id,
    hostVersion: row.version,
    capabilities: p.capabilities,
    transport: createWorkerTransport(worker),
    router,
    onCapabilityDenied: onDenied(row.plugin_id),
  });
  bridge.start();
  p.worker = worker;
  p.workerBridge = bridge;
  p.blobUrl = blobUrl;
}

function teardown(p: RunningPlugin) {
  p.workerBridge?.destroy(); // also terminates the worker via transport
  if (p.blobUrl) URL.revokeObjectURL(p.blobUrl);
  for (const bridge of p.panelBridges.values()) bridge.destroy();
  p.panelBridges.clear();
  running.delete(p.pluginId);
}

/** Bring the running set in line with the latest contributes snapshot.
 *  Idempotent; cheap when nothing changed. */
export function reconcilePluginRuntime(rows: PluginContributesRow[]) {
  const desired = new Map(rows.map((r) => [r.plugin_id, r]));

  // Refresh MCP routing for the whole desired set first — `mcp.call`
  // reads this map live, so toggling a bundled server in Settings takes
  // effect on the very next call.
  mcpRoute.clear();
  for (const row of rows) mcpRoute.set(row.plugin_id, row.mcp_server_id);

  // Stop what's gone (disabled, uninstalled) or version-changed.
  for (const p of [...running.values()]) {
    const row = desired.get(p.pluginId);
    if (!row || row.version !== p.version) teardown(p);
  }

  // Start what's new.
  for (const row of rows) {
    if (running.has(row.plugin_id)) continue;
    const p: RunningPlugin = {
      pluginId: row.plugin_id,
      version: row.version,
      capabilities: parseCaps(row),
      worker: null,
      workerBridge: null,
      blobUrl: null,
      panelBridges: new Map(),
      wantsRealtime: declaresRealtime(row),
    };
    running.set(row.plugin_id, p);
    void spawnWorker(p, row);
  }

  syncRealtimePoller();
}

/** Tear everything down (window unload, tests). */
export function stopPluginRuntime() {
  for (const p of [...running.values()]) teardown(p);
  mcpRoute.clear();
  syncRealtimePoller();
}

// ── panel iframes ─────────────────────────────────────────────────────

/** Wire a mounted panel iframe into its plugin's bridge. Called from
 *  the panel frame's load handler; returns a detach fn for unmount, or
 *  `null` when the plugin isn't running yet (reconcile still in flight)
 *  — callers retry briefly. Panels are srcdoc-sandboxed
 *  (`allow-scripts`, no same-origin), so their window origin is the
 *  literal string "null" — the transport's `source` identity check is
 *  the strong filter. */
export function attachPanelBridge(
  iframe: HTMLIFrameElement,
  pluginId: string,
): (() => void) | null {
  const p = running.get(pluginId);
  if (!p) return null;
  const bridge = new PluginBridge({
    pluginId,
    hostVersion: p.version,
    capabilities: p.capabilities,
    transport: createIframeTransport({ iframe, expectedOrigin: "null" }),
    router,
    onCapabilityDenied: onDenied(pluginId),
  });
  bridge.start();
  p.panelBridges.set(iframe, bridge);
  return () => {
    const cur = running.get(pluginId);
    const b = cur?.panelBridges.get(iframe);
    if (b) {
      b.destroy();
      cur?.panelBridges.delete(iframe);
    }
  };
}

/** Load a panel's HTML for srcdoc mounting. Entry is resolved + jailed
 *  by the Rust side. Returns null when unavailable (plugin disabled
 *  mid-flight, missing file). */
export async function loadPanelHtml(
  pluginId: string,
  entry: string,
): Promise<string | null> {
  try {
    return (await api.pluginAssetRead(pluginId, entry)).body;
  } catch (e) {
    console.warn(`[pluginRuntime] ${pluginId}: panel load failed`, e);
    return null;
  }
}

// ── realtime poller (Commons W3a) ─────────────────────────────────────
//
// One module-level interval serves every running plugin that declares
// `realtime:channel`. Cursors are per-plugin cloud `seq` values; the
// first poll (null cursor) only fast-forwards to the rail head —
// realtime is ephemeral, history never replays. Rust re-checks the
// plugin's capability per topic on every poll, so this loop stays dumb:
// fetch, advance cursor, fan out. ~2s latency is the contract — this
// lane is for turn-based collaboration, not twitch input.

const RT_POLL_MS = 2_000;
let rtTimer: number | null = null;
let rtBusy = false;
const rtCursors = new Map<string, number | null>();

/** Start/stop the interval to match the running set; drop cursors of
 *  plugins that left. Called from reconcile + stopPluginRuntime. */
function syncRealtimePoller() {
  const wants = [...running.values()].some((p) => p.wantsRealtime);
  if (wants && rtTimer === null) {
    rtTimer = window.setInterval(() => void rtTick(), RT_POLL_MS);
  } else if (!wants && rtTimer !== null) {
    window.clearInterval(rtTimer);
    rtTimer = null;
  }
  for (const id of [...rtCursors.keys()]) {
    if (!running.get(id)?.wantsRealtime) rtCursors.delete(id);
  }
}

async function rtTick() {
  if (rtBusy) return; // a slow rail fetch must not stack ticks
  const root = repoRootGetter();
  if (!root) return;
  rtBusy = true;
  try {
    for (const p of [...running.values()]) {
      if (!p.wantsRealtime) continue;
      try {
        const res = await api.pluginRtPoll(
          p.pluginId,
          root,
          rtCursors.get(p.pluginId) ?? null,
        );
        rtCursors.set(p.pluginId, res.next_seq);
        for (const ev of res.events) {
          broadcast(p.pluginId, `realtime.${ev.topic}`, {
            topic: ev.topic,
            payload: ev.payload,
            from: { device: ev.from_device, display: ev.from_display },
            ts: ev.ts,
            self: false,
          });
        }
      } catch {
        // No cloud room yet / transient network — next tick retries.
      }
    }
  } finally {
    rtBusy = false;
  }
}

// ── host → plugin dispatch ────────────────────────────────────────────

function broadcast(pluginId: string, channel: string, payload: unknown) {
  const p = running.get(pluginId);
  if (!p) return false;
  p.workerBridge?.emit(channel, payload);
  for (const b of p.panelBridges.values()) b.emit(channel, payload);
  return true;
}

/** Route a `/command` typed in a composer to the owning plugin. The
 *  plugin sees an `aura.ui.slash` event (it must have subscribed). */
export function dispatchPluginSlash(
  pluginId: string,
  commandId: string,
  text: string,
): boolean {
  return broadcast(pluginId, "aura.ui.slash", { commandId, text });
}

/** Route a second-rail tile click. */
export function dispatchPluginTileClick(
  pluginId: string,
  tileId: string,
): boolean {
  return broadcast(pluginId, "aura.ui.tile-click", { tileId });
}

/** Route a status-bar pill click. */
export function dispatchPluginPillClick(
  pluginId: string,
  pillId: string,
): boolean {
  return broadcast(pluginId, "aura.ui.pill-click", { pillId });
}

/** Decode the synthetic slash target minted by pluginSlashCommands():
 *  `plugin:<pluginId>:<commandId>` (plugin ids contain `/` but no `:`).
 */
export function parsePluginSlashTarget(
  target: string,
): { pluginId: string; commandId: string } | null {
  if (!target.startsWith("plugin:")) return null;
  const rest = target.slice("plugin:".length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { pluginId: rest.slice(0, sep), commandId: rest.slice(sep + 1) };
}
