// Main-thread controller for the Node extension host (Tier 2).
//
// This is the Node-host twin of `extHostRuntime.ts` (which drives the Web-Worker
// host for web extensions). Where that one talks to a `Worker`, this one talks to
// a real Node sidecar process (`src-tauri/resources/ext-host/host.js`) over Tauri
// IPC: it pushes JSON-line protocol messages with `api.extHostSend` and listens to
// `ext-host:msg` / `ext-host:exit` / `ext-host:log` for the host's replies.
//
// It exists because the interesting "unsupported" VS Code extensions — Python,
// rust-analyzer, gopls, ESLint — are LANGUAGE extensions: they declare their
// language server programmatically inside `activate()` (never in package.json), so
// the only way to run them is to actually run their Node program. host.js does
// that and spawns the LSP server; this module:
//   • decides which installed extensions are Node extensions (a `main` entry, no
//     `browser`) and loads/unloads them as the enabled set changes,
//   • boots the sidecar lazily (nothing runs when no Node extension is enabled),
//   • bridges the host's completion / hover / diagnostics announcements into the
//     SAME Monaco bridges the worker uses — only tagged `source: "node"` so the two
//     hosts' providers never collide,
//   • streams open-document changes to the host so a language server can publish
//     diagnostics as you type, and
//   • surfaces the extensions' commands to the Command Palette.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { stripJsonc } from "../vscodeTheme";
import {
  ensureInstalledLoaded,
  getEnabledExtensions,
  subscribeInstalled,
} from "./vsixStore";
import {
  setExtCommandsForSource,
  type ExtCommand,
} from "./extCommandStore";
import {
  clearAllNodeProviders,
  registerNodeProvider,
  setExtHostNodeLangBridge,
  unregisterNodeProvider,
} from "./extHostMonacoLang";
import {
  clearExtHostDiagnostics,
  setExtHostDiagnostics,
} from "./extHostMonacoDiag";
import type {
  LangProviderKind,
  WireCompletionContext,
  WireCompletionItem,
  WireCompletionList,
  WireDiagnostic,
  WireDoc,
  WireHover,
  WirePos,
} from "./langFeatures";
import type { InstalledExtension } from "./vsixTypes";

// ── Host→frontend message shapes (mirror what host.js emits) ─────────────────
// These match the web worker's `WorkerToHost` family verbatim, plus `activated`
// carrying the command ids that actually registered.

type HostMsg =
  | { type: "ready" }
  | { type: "activated"; id: string; ok: boolean; error?: string; commands: string[] }
  | { type: "executeResult"; reqId: number; ok: boolean; value?: unknown; error?: string }
  | { type: "hostRequest"; reqId: number; method: string; payload: unknown }
  | { type: "log"; id: string; level: string; message: string }
  | {
      type: "registerLanguageProvider";
      providerId: string;
      extId: string;
      kind: LangProviderKind;
      languages: string[];
      triggerCharacters?: string[];
      hasResolve?: boolean;
    }
  | { type: "unregisterLanguageProvider"; providerId: string }
  | { type: "provideResult"; reqId: number; ok: boolean; value?: unknown; error?: string }
  | { type: "setDiagnostics"; owner: string; uri: string; items: WireDiagnostic[] }
  | { type: "clearDiagnostics"; owner: string; uri?: string };

// ── Sidecar lifecycle ────────────────────────────────────────────────────────

let started = false; // we asked Rust to spawn (or it's spawning)
let ready = false; // the sidecar is up and draining our queue
let booted = false; // bootNodeExtensionHost() ran once
const sendQueue: unknown[] = [];
let unlisteners: UnlistenFn[] = [];

// ── Crash-loop circuit breaker ───────────────────────────────────────────────
// A sidecar that dies the instant it starts would otherwise loop forever:
// exit → resetHost → reconcile → ensureHost → spawn → exit … spamming processes.
// Count restarts within a rolling window; trip after a burst and stop auto-
// respawning until the user changes the enabled set (a deliberate retry signal).
const RESTART_WINDOW_MS = 10_000;
const RESTART_BURST_LIMIT = 5;
let restartWindowStart = 0;
let restartCount = 0;
let respawnDisabled = false;
// Whether we've already surfaced a "host couldn't start" toast for the current
// failure. Gated so a string of reconcile retries (one per enabled-set change)
// doesn't spam the same message; cleared on a successful start or a user retry.
let startErrorNotified = false;

/** Clear the breaker — the user changed which extensions are enabled, so an
 *  earlier crash-loop shouldn't keep the host down for a now-different set. */
function resetCircuitBreaker(): void {
  respawnDisabled = false;
  restartCount = 0;
  restartWindowStart = 0;
  startErrorNotified = false;
}

/** extId → loaded version (what the sidecar currently holds). */
const loaded = new Map<string, string>();
/** extId → its display name + declared palette commands (parsed from package.json). */
const manifests = new Map<string, { extName: string; commands: ExtCommand[] }>();
/** Command ids owned by Node extensions, for `executeExtCommand` routing. */
const nodeCommandIds = new Set<string>();

// The open workspace folder, handed to the host's `init` so a language server
// gets a sane rootUri / workspaceFolders.
let workspaceRoot: string | null = null;

// Open documents we've told (or will tell) the host about, so a freshly-(re)started
// sidecar can be replayed the current editor state and diagnostics flow at once.
const openDocs = new Map<string, WireDoc>();
/** Diagnostic owners the Node host published, so an exit clears only ITS markers
 *  (not the web worker's) — the shared diag bridge isn't source-aware. */
const nodeDiagOwners = new Set<string>();

// Outbound command executions + provider calls, each correlated by its own reqId.
let execSeq = 1;
const pendingExec = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();
let provideSeq = 1;
const pendingProvide = new Map<
  number,
  { resolve: (v: WireCompletionList | WireHover | WireCompletionItem | null) => void; reject: (e: unknown) => void }
>();

function postRaw(msg: unknown): void {
  if (ready) {
    void api.extHostSend(JSON.stringify(msg)).catch((e) => {
      console.error("[node-ext-host] send failed:", e);
    });
  } else {
    sendQueue.push(msg);
  }
}

/** A Node extension is one with a `main` (Node) entry and no `browser` web entry —
 *  the web ones are handled by the worker host. This is what routes Python /
 *  rust-analyzer / gopls / ESLint here. */
function isNodeExtension(ext: InstalledExtension): boolean {
  return !!ext.contributes.hasMain && !ext.contributes.hasBrowser;
}

/** Bring the sidecar up if it isn't already, attaching the IPC listeners exactly
 *  once. Resolves when the process is spawned; messages queued meanwhile flush in
 *  order (the OS pipe buffers our writes until host.js attaches its reader). */
async function ensureHost(): Promise<void> {
  if (started) return;
  if (respawnDisabled) return; // breaker tripped — wait for a user-driven retry
  started = true;
  try {
    if (unlisteners.length === 0) {
      unlisteners = await Promise.all([
        listen<string>("ext-host:msg", (e) => onHostLine(e.payload)),
        listen<unknown>("ext-host:exit", () => resetHost("the extension host exited")),
        listen<string>("ext-host:log", (e) => console.debug(`[node-ext-host] ${e.payload}`)),
      ]);
    }
    await api.extHostStart();
    // The process is up. Drain anything queued before we send `init`.
    ready = true;
    startErrorNotified = false; // a clean start clears any earlier failure notice
    postRaw({ type: "init", workspaceRoot });
    for (const m of sendQueue.splice(0)) postRaw(m);
    // Replay the editor's open documents so a language server has them immediately.
    for (const doc of openDocs.values()) postRaw({ type: "doc", action: "open", doc });
  } catch (e) {
    started = false;
    ready = false;
    console.error("[node-ext-host] failed to start:", e);
    // Surface it — our audience never opens the dev console. The common failure
    // (no Node on the machine) already carries a plain-language, actionable
    // message from `resolve_node` ("Node.js wasn't found… Install Node…"). Show
    // it ONCE per failure so a burst of reconcile retries doesn't spam.
    if (!startErrorNotified) {
      startErrorNotified = true;
      toast("error", `Couldn't start extension support: ${firstLine(String(e instanceof Error ? e.message : e))}`);
    }
  }
}

/** The sidecar died (or we tore it down). Settle every in-flight call, drop the
 *  Monaco proxies + markers it backed, forget what it held, and reconcile — which
 *  respawns a fresh host and reloads the enabled Node extensions if any remain. */
function resetHost(reason: string): void {
  started = false;
  ready = false;
  sendQueue.length = 0;
  for (const [, p] of pendingExec) p.reject(new Error(reason));
  pendingExec.clear();
  for (const [, p] of pendingProvide) p.resolve(null);
  pendingProvide.clear();
  clearAllNodeProviders();
  for (const owner of nodeDiagOwners) clearExtHostDiagnostics(owner);
  nodeDiagOwners.clear();
  loaded.clear();
  manifests.clear();
  nodeCommandIds.clear();
  rebuildPaletteCommands();

  // Trip the breaker on a burst of restarts so a host that dies on startup can't
  // spin up processes forever. A successful run that lasts past the window resets
  // the counter naturally (the window is re-based on the next exit).
  const now = Date.now();
  if (now - restartWindowStart > RESTART_WINDOW_MS) {
    restartWindowStart = now;
    restartCount = 0;
  }
  restartCount += 1;
  if (restartCount > RESTART_BURST_LIMIT) {
    respawnDisabled = true;
    toast(
      "error",
      "An extension kept crashing, so smart code help is paused. Turn the extension off and on to try again.",
    );
    return; // don't reconcile — that would respawn immediately
  }
  void reconcile();
}

/** Fully stop the sidecar (last Node extension disabled) and clear its state. */
async function stopHost(): Promise<void> {
  if (!started) return;
  try {
    await api.extHostStop();
  } catch {
    // best effort
  }
  // Don't trigger a reconcile-respawn here (there's nothing left to host); just
  // clear our mirror of its state.
  ready = false;
  started = false;
  sendQueue.length = 0;
  for (const [, p] of pendingExec) p.reject(new Error("extension host stopped"));
  pendingExec.clear();
  for (const [, p] of pendingProvide) p.resolve(null);
  pendingProvide.clear();
  clearAllNodeProviders();
  for (const owner of nodeDiagOwners) clearExtHostDiagnostics(owner);
  nodeDiagOwners.clear();
  loaded.clear();
  manifests.clear();
  nodeCommandIds.clear();
  rebuildPaletteCommands();
}

// ── Inbound message handling ─────────────────────────────────────────────────

function onHostLine(line: string): void {
  let msg: HostMsg;
  try {
    msg = JSON.parse(line) as HostMsg;
  } catch (e) {
    console.error("[node-ext-host] bad message:", e, line.slice(0, 200));
    return;
  }
  onHostMessage(msg);
}

function onHostMessage(msg: HostMsg): void {
  switch (msg.type) {
    case "ready":
      // We already mark ready when extHostStart resolves; this is a belt-and-braces
      // flush in case the host announced before that resolved.
      ready = true;
      for (const m of sendQueue.splice(0)) postRaw(m);
      break;
    case "activated":
      if (!msg.ok && msg.error) {
        toast("warn", `An extension failed to start: ${firstLine(msg.error)}`);
      }
      break;
    case "executeResult": {
      const p = pendingExec.get(msg.reqId);
      if (p) {
        pendingExec.delete(msg.reqId);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error));
      }
      break;
    }
    case "hostRequest":
      void fulfillHostRequest(msg.reqId, msg.method, msg.payload);
      break;
    case "log":
      console.debug(`[ext:${msg.id}] ${msg.message}`);
      break;
    case "registerLanguageProvider":
      registerNodeProvider({
        providerId: msg.providerId,
        extId: msg.extId,
        kind: msg.kind,
        languages: msg.languages,
        triggerCharacters: msg.triggerCharacters,
        hasResolve: msg.hasResolve,
      });
      break;
    case "unregisterLanguageProvider":
      unregisterNodeProvider(msg.providerId);
      break;
    case "provideResult": {
      const p = pendingProvide.get(msg.reqId);
      if (p) {
        pendingProvide.delete(msg.reqId);
        if (msg.ok) p.resolve(msg.value as WireCompletionList | WireHover | WireCompletionItem | null);
        else p.reject(new Error(msg.error));
      }
      break;
    }
    case "setDiagnostics":
      nodeDiagOwners.add(msg.owner);
      setExtHostDiagnostics(msg.owner, msg.uri, msg.items);
      break;
    case "clearDiagnostics":
      clearExtHostDiagnostics(msg.owner, msg.uri);
      break;
  }
}

// ── Language-provider bridge (Monaco ⇆ sidecar) ──────────────────────────────

function provideViaNode(
  providerId: string,
  kind: LangProviderKind,
  doc: WireDoc,
  position: WirePos,
  context?: WireCompletionContext,
): Promise<WireCompletionList | WireHover | null> {
  const reqId = provideSeq++;
  return new Promise((resolve, reject) => {
    pendingProvide.set(reqId, {
      resolve: (v) => resolve(v as WireCompletionList | WireHover | null),
      reject,
    });
    postRaw({ type: "provide", reqId, providerId, kind, doc, position, context });
  });
}

function resolveViaNode(providerId: string, handle: number): Promise<WireCompletionItem | null> {
  const reqId = provideSeq++;
  return new Promise((resolve, reject) => {
    pendingProvide.set(reqId, {
      resolve: (v) => resolve(v as WireCompletionItem | null),
      reject,
    });
    postRaw({ type: "provideResolve", reqId, providerId, handle });
  });
}

// ── Fulfilling host → frontend requests (toast / clipboard / open url) ───────

async function fulfillHostRequest(reqId: number, method: string, payload: unknown): Promise<void> {
  const reply = (ok: boolean, valueOrError: unknown) =>
    postRaw(
      ok
        ? { type: "hostResult", reqId, ok: true, value: valueOrError }
        : { type: "hostResult", reqId, ok: false, error: String(valueOrError) },
    );
  try {
    switch (method) {
      case "window.showMessage": {
        const p = payload as { kind?: "info" | "warn" | "error"; message?: string };
        toast(p.kind ?? "info", p.message ?? "");
        reply(true, undefined);
        break;
      }
      case "env.clipboard.writeText": {
        await navigator.clipboard.writeText((payload as { text?: string }).text ?? "");
        reply(true, undefined);
        break;
      }
      case "env.clipboard.readText": {
        reply(true, await navigator.clipboard.readText());
        break;
      }
      case "env.openExternal": {
        const url = (payload as { url?: string }).url ?? "";
        const opened = typeof url === "string" && url ? window.open(url, "_blank") : null;
        reply(true, opened != null);
        break;
      }
      default:
        reply(false, `unsupported host request: ${method}`);
    }
  } catch (e) {
    reply(false, e instanceof Error ? e.message : String(e));
  }
}

function toast(kind: "info" | "warn" | "error", message: string): void {
  window.dispatchEvent(
    new CustomEvent("aura:plugin-toast", {
      detail: { pluginId: "extension", message, kind },
    }),
  );
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i < 0 ? s : s.slice(0, i);
}

// ── Manifest parsing (titles for the palette) ────────────────────────────────

/** Read a Node extension's package.json for its display name + contributed
 *  command titles. The host runs the extension itself; we only need the labels. */
async function readManifest(
  ext: InstalledExtension,
): Promise<{ extName: string; commands: ExtCommand[] }> {
  const extName = ext.displayName || ext.name;
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(stripJsonc(await api.vsixReadText(ext.id, "package.json"))) as Record<string, unknown>;
  } catch {
    return { extName, commands: [] };
  }
  const contributes = (pkg.contributes ?? {}) as Record<string, unknown>;
  const commands = parseCommands(contributes.commands).map<ExtCommand>((c) => ({
    command: c.command,
    title: c.category ? `${c.category}: ${c.title}` : c.title,
    extId: ext.id,
    extName,
    source: "node",
  }));
  return { extName, commands };
}

function parseCommands(raw: unknown): { command: string; title: string; category?: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { command: string; title: string; category?: string }[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const command = typeof o.command === "string" ? o.command : "";
    const title = typeof o.title === "string" ? o.title : "";
    if (!command || !title) continue;
    out.push({ command, title, category: typeof o.category === "string" ? o.category : undefined });
  }
  return out;
}

// ── Reconcile ────────────────────────────────────────────────────────────────

let reconciling: Promise<void> | null = null;
let reconcileQueued = false;

/** Bring the sidecar's loaded set in line with the enabled Node extensions. Safe
 *  to call often; concurrent calls coalesce and a change mid-flight re-runs. */
async function reconcile(): Promise<void> {
  if (reconciling) {
    reconcileQueued = true;
    return reconciling;
  }
  reconciling = (async () => {
    const enabled = getEnabledExtensions().filter(isNodeExtension);

    // Nothing to host: stop the sidecar (if any) and clear the palette slot.
    if (enabled.length === 0) {
      if (started || loaded.size > 0) await stopHost();
      return;
    }

    await ensureHost();
    if (!ready) return; // start failed — leave it; a later toggle retries

    const desired = new Map(enabled.map((e) => [e.id, e.version]));

    // Unload anything removed, disabled, or version-changed.
    for (const [id, ver] of [...loaded]) {
      if (desired.get(id) !== ver) {
        postRaw({ type: "unload", id });
        loaded.delete(id);
        manifests.delete(id);
      }
    }

    // Load anything new (or freshly re-added after a version change).
    for (const ext of enabled) {
      if (loaded.has(ext.id)) continue;
      const manifest = await readManifest(ext);
      postRaw({ type: "load", id: ext.id, extensionPath: `${ext.installDir}/extension` });
      loaded.set(ext.id, ext.version);
      manifests.set(ext.id, manifest);
    }

    rebuildPaletteCommands();
  })();

  try {
    await reconciling;
  } finally {
    reconciling = null;
    if (reconcileQueued) {
      reconcileQueued = false;
      void reconcile();
    }
  }
}

function rebuildPaletteCommands(): void {
  const all: ExtCommand[] = [];
  nodeCommandIds.clear();
  for (const m of manifests.values()) {
    for (const c of m.commands) {
      all.push(c);
      nodeCommandIds.add(c.command);
    }
  }
  setExtCommandsForSource("node", all);
}

// ── Public surface ───────────────────────────────────────────────────────────

/** Boot the Node host controller once: wire the Monaco bridge, then reconcile on
 *  every change to the enabled set (the sidecar itself only spawns when there's a
 *  Node extension to run). Idempotent. */
export function bootNodeExtensionHost(): void {
  if (booted) return;
  booted = true;
  setExtHostNodeLangBridge({ provide: provideViaNode, resolve: resolveViaNode });
  subscribeInstalled(() => {
    // A change to the enabled set is a deliberate user action — treat it as a
    // retry signal that clears any crash-loop breaker from a previous bad host.
    resetCircuitBreaker();
    void reconcile();
  });
  void ensureInstalledLoaded().then(() => reconcile());
}

/** Set / refresh the workspace folder a language server should treat as its root.
 *  Cheap + idempotent; re-`init`s a running host when the folder actually changes. */
export function setNodeWorkspaceRoot(root: string | null): void {
  const next = root || null;
  if (next === workspaceRoot) return;
  workspaceRoot = next;
  if (ready) postRaw({ type: "init", workspaceRoot });
}

/** Tell the host a document opened / changed, so its language servers stay in sync
 *  and publish diagnostics as you type. Tracked even before the host is up, so a
 *  later-started sidecar gets replayed the current state. */
export function nodeDocChanged(doc: WireDoc): void {
  openDocs.set(doc.uri, doc);
  if (ready) postRaw({ type: "doc", action: "change", doc });
}

/** Tell the host a document opened (first sync of its text). */
export function nodeDocOpened(doc: WireDoc): void {
  openDocs.set(doc.uri, doc);
  if (ready) postRaw({ type: "doc", action: "open", doc });
}

/** Tell the host a document closed. */
export function nodeDocClosed(uri: string): void {
  if (!openDocs.has(uri)) return;
  openDocs.delete(uri);
  if (ready) postRaw({ type: "doc", action: "close", doc: { uri } });
}

/** Whether a command belongs to a Node extension (drives palette routing). */
export function hasNodeCommand(command: string): boolean {
  return nodeCommandIds.has(command);
}

/** Run a Node-extension command (lazily activating its extension via the host). */
export async function executeNodeCommand(command: string): Promise<void> {
  await ensureHost();
  if (!started && respawnDisabled) {
    toast("error", "That extension is paused after repeated crashes. Turn it off and on to retry.");
    return;
  }
  // Host failed to start (e.g. no Node on the machine): `ensureHost` set `started`
  // true then reset it to false in its catch, and already toasted the reason. Bail
  // rather than queue an `execute` that would never resolve (a forever-spinning
  // command). `started && !ready` (a start in flight from another caller) is NOT
  // this case — there we let `postRaw` queue and flush when the host comes up.
  if (!started && !ready) return;
  const reqId = execSeq++;
  try {
    await new Promise<unknown>((resolve, reject) => {
      pendingExec.set(reqId, { resolve, reject });
      postRaw({ type: "execute", reqId, command, args: [] });
    });
  } catch (e) {
    toast("error", `That command couldn't run: ${e instanceof Error ? e.message : String(e)}`);
  }
}
