// Main-thread controller for the VS Code web-extension host (Tier 1).
//
// It is the bridge between three things that already exist:
//   • the install index (vsixStore — which extensions are enabled),
//   • the jailed file reader (api.vsixReadText — reads any file in a bundle),
//   • and the host worker (vscodeExtHost.worker — runs the bundle).
//
// On every change to the enabled set it reconciles: extensions whose package
// has a `browser` web entry get their manifest + bundle read off disk and loaded
// into the worker; removed/disabled ones get unloaded. The commands they declare
// flow into the Command Palette (extCommandStore); running one tells the worker
// to (lazily activate and) execute it, and any toast/clipboard the extension
// asks for is fulfilled here and handed back.
//
// The worker is spawned lazily — only when there's at least one runnable web
// extension — so a workspace with none pays nothing.

import { api } from "../api";
import { stripJsonc } from "../vscodeTheme";
import {
  ensureInstalledLoaded,
  getEnabledExtensions,
  subscribeInstalled,
} from "./vsixStore";
import {
  setExtCommands,
  type ExtCommand,
} from "./extCommandStore";
import {
  type ContributedCommand,
  type HostToWorker,
  type ShowMessagePayload,
  type WebExtManifest,
  type WorkerToHost,
} from "./extHostProtocol";
import {
  clearAllWorkerProviders,
  registerWorkerProvider,
  setExtHostLangBridge,
  unregisterWorkerProvider,
} from "./extHostMonacoLang";
import {
  clearAllDiagnostics,
  clearExtHostDiagnostics,
  setExtHostDiagnostics,
} from "./extHostMonacoDiag";
import {
  bootNodeExtensionHost,
  executeNodeCommand,
  hasNodeCommand,
} from "./extHostNodeRuntime";
import type {
  WireCompletionContext,
  WireCompletionItem,
  WireCompletionList,
  WireDoc,
  WireHover,
  WirePos,
} from "./langFeatures";
import type { InstalledExtension } from "./vsixTypes";
// Vite compiles this `.worker` module into its own bundle; `?worker` yields a
// Worker constructor (same pattern monacoEnv.ts uses for Monaco's workers).
import ExtHostWorker from "./vscodeExtHost.worker?worker";

// ── Worker lifecycle ─────────────────────────────────────────────────────────

let worker: Worker | null = null;
let ready = false;
let booted = false;
const sendQueue: HostToWorker[] = [];

/** extId → loaded version (what the worker currently holds). */
const loaded = new Map<string, string>();
/** extId → its display name + declared palette commands. */
const manifests = new Map<string, { extName: string; commands: ExtCommand[] }>();

// Outbound command executions, correlated by reqId.
let execSeq = 1;
const pendingExec = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();

// Outbound language-provider calls (completion / hover / resolve), correlated by
// their own reqId so they never collide with command executions.
let provideSeq = 1;
const pendingProvide = new Map<
  number,
  { resolve: (v: WireCompletionList | WireHover | WireCompletionItem | null) => void; reject: (e: unknown) => void }
>();

function send(msg: HostToWorker): void {
  if (worker && ready) {
    worker.postMessage(msg);
  } else {
    sendQueue.push(msg);
  }
}

function ensureWorker(): void {
  if (worker) return;
  worker = new ExtHostWorker();
  worker.addEventListener("message", (ev: MessageEvent<WorkerToHost>) =>
    onWorkerMessage(ev.data),
  );
  worker.addEventListener("error", (e) => {
    console.error("[vscode-ext-host] worker error:", e.message);
    resetWorker(e.message || "the extension host crashed");
  });
}

/** The worker died (fatal error / GC). Reject every in-flight command so no
 *  palette pick hangs forever, drop the dead handle, forget what it held, and
 *  reconcile — the next reconcile/exec respawns a fresh worker and reloads the
 *  enabled extensions into it. Without this, `executeExtCommand`'s promise would
 *  never settle and the pick would die silently (the opposite of its contract). */
function resetWorker(reason: string): void {
  if (worker) {
    try {
      worker.terminate();
    } catch {
      // already gone
    }
  }
  worker = null;
  ready = false;
  sendQueue.length = 0;
  for (const [, p] of pendingExec) p.reject(new Error(reason));
  pendingExec.clear();
  // Settle in-flight provider calls (so a pending Monaco completion resolves to
  // empty instead of hanging) and drop the Monaco proxies the dead worker backed.
  for (const [, p] of pendingProvide) p.resolve(null);
  pendingProvide.clear();
  clearAllWorkerProviders();
  clearAllDiagnostics();
  loaded.clear();
  manifests.clear();
  // Reload into a fresh worker only if there's still something to host.
  void reconcile();
}

function onWorkerMessage(msg: WorkerToHost): void {
  switch (msg.type) {
    case "ready":
      ready = true;
      for (const m of sendQueue.splice(0)) worker?.postMessage(m);
      break;
    case "activated":
      // The palette already lists declared commands; here we only surface an
      // honest failure if an eager-activation extension threw on startup.
      if (!msg.ok && msg.error) {
        toast("warn", `An extension failed to start: ${msg.error}`);
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
      // Extension output channels / console — dev log only, never a modal.
      console.debug(`[ext:${msg.id}] ${msg.message}`);
      break;
    case "registerLanguageProvider":
      // An extension's completion/hover provider is live — attach Monaco proxies
      // for each of its languages (queued until the editor mounts if needed).
      registerWorkerProvider({
        providerId: msg.providerId,
        extId: msg.extId,
        kind: msg.kind,
        languages: msg.languages,
        triggerCharacters: msg.triggerCharacters,
        hasResolve: msg.hasResolve,
      });
      break;
    case "unregisterLanguageProvider":
      unregisterWorkerProvider(msg.providerId);
      break;
    case "provideResult": {
      const p = pendingProvide.get(msg.reqId);
      if (p) {
        pendingProvide.delete(msg.reqId);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error));
      }
      break;
    }
    case "setDiagnostics":
      // An extension published squiggles for a document — paint them as Monaco
      // markers (held until the document's model opens if it isn't open yet).
      setExtHostDiagnostics(msg.owner, msg.uri, msg.items);
      break;
    case "clearDiagnostics":
      clearExtHostDiagnostics(msg.owner, msg.uri);
      break;
  }
}

// ── Language-provider bridge (Monaco ⇆ worker) ───────────────────────────────

/** Ask the worker to run a registered provider; resolves to the serialized
 *  completions/hover (or null). Rejection is left to the caller's try/catch — the
 *  Monaco proxy degrades to "no results" so a slow/broken provider never blocks
 *  the editor. */
function provideViaWorker(
  providerId: string,
  kind: "completion" | "hover",
  doc: WireDoc,
  position: WirePos,
  context?: WireCompletionContext,
): Promise<WireCompletionList | WireHover | null> {
  ensureWorker();
  const reqId = provideSeq++;
  return new Promise((resolve, reject) => {
    pendingProvide.set(reqId, {
      resolve: (v) => resolve(v as WireCompletionList | WireHover | null),
      reject,
    });
    send({ type: "provide", reqId, providerId, kind, doc, position, context });
  });
}

/** Ask the worker to lazily enrich one completion item. */
function resolveViaWorker(
  providerId: string,
  handle: number,
): Promise<WireCompletionItem | null> {
  ensureWorker();
  const reqId = provideSeq++;
  return new Promise((resolve, reject) => {
    pendingProvide.set(reqId, {
      resolve: (v) => resolve(v as WireCompletionItem | null),
      reject,
    });
    send({ type: "provideResolve", reqId, providerId, handle });
  });
}

// ── Fulfilling worker → host requests ────────────────────────────────────────

async function fulfillHostRequest(
  reqId: number,
  method: string,
  payload: unknown,
): Promise<void> {
  const reply = (ok: boolean, valueOrError: unknown) =>
    send(
      ok
        ? { type: "hostResult", reqId, ok: true, value: valueOrError }
        : { type: "hostResult", reqId, ok: false, error: String(valueOrError) },
    );
  try {
    switch (method) {
      case "window.showMessage": {
        const p = payload as ShowMessagePayload;
        toast(p.kind, p.message);
        reply(true, undefined);
        break;
      }
      case "env.clipboard.writeText": {
        const text = (payload as { text?: string }).text ?? "";
        await navigator.clipboard.writeText(text);
        reply(true, undefined);
        break;
      }
      case "env.clipboard.readText": {
        const text = await navigator.clipboard.readText();
        reply(true, text);
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

/** Show a toast through the same surface Aura plugins use (PluginToastHost). */
function toast(kind: "info" | "warn" | "error", message: string): void {
  window.dispatchEvent(
    new CustomEvent("aura:plugin-toast", {
      detail: { pluginId: "extension", message, kind },
    }),
  );
}

// ── Manifest parsing (frontend — we already read package.json for themes) ────

/** Read one extension's `package.json` + web bundle and shape it for the worker.
 *  Returns null when it has no usable web entry (so the reconcile skips it). */
async function buildLoad(
  ext: InstalledExtension,
): Promise<{ manifest: WebExtManifest; code: string } | null> {
  let pkg: Record<string, unknown>;
  try {
    const raw = await api.vsixReadText(ext.id, "package.json");
    pkg = JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const browserEntry = typeof pkg.browser === "string" ? pkg.browser.trim() : "";
  if (!browserEntry) return null;

  let code: string;
  try {
    code = await api.vsixReadText(ext.id, browserEntry);
  } catch (e) {
    toast("warn", `Couldn't read ${ext.displayName || ext.name}'s program.`);
    console.error(`[vscode-ext-host] read ${ext.id}/${browserEntry}:`, e);
    return null;
  }

  const activationEvents = Array.isArray(pkg.activationEvents)
    ? (pkg.activationEvents.filter((x) => typeof x === "string") as string[])
    : [];

  const contributes = (pkg.contributes ?? {}) as Record<string, unknown>;
  const commands = parseCommands(contributes.commands);
  const configDefaults = parseConfigDefaults(contributes.configuration);

  const manifest: WebExtManifest = {
    id: ext.id,
    displayName: ext.displayName || ext.name,
    version: ext.version,
    extensionPath: `${ext.installDir}/extension`,
    browserEntry,
    activationEvents,
    commands,
    configDefaults,
  };
  return { manifest, code };
}

function parseCommands(raw: unknown): ContributedCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: ContributedCommand[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const command = typeof o.command === "string" ? o.command : "";
    const title = typeof o.title === "string" ? o.title : "";
    if (!command || !title) continue;
    out.push({
      command,
      title,
      category: typeof o.category === "string" ? o.category : undefined,
    });
  }
  return out;
}

/** Flatten `contributes.configuration` (object or array of objects) to a
 *  `fully.qualified.key → default` map the shim's getConfiguration reads. */
function parseConfigDefaults(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const blocks = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const props = (block as Record<string, unknown>).properties;
    if (!props || typeof props !== "object") continue;
    for (const [key, schema] of Object.entries(props as Record<string, unknown>)) {
      if (schema && typeof schema === "object" && "default" in schema) {
        out[key] = (schema as Record<string, unknown>).default;
      }
    }
  }
  return out;
}

// ── Reconcile ────────────────────────────────────────────────────────────────

let reconciling: Promise<void> | null = null;
let reconcileQueued = false;

/** Bring the worker's loaded set in line with the enabled web extensions. Safe
 *  to call often; concurrent calls coalesce and a change mid-flight re-runs. */
async function reconcile(): Promise<void> {
  if (reconciling) {
    reconcileQueued = true;
    return reconciling;
  }
  reconciling = (async () => {
    const enabled = getEnabledExtensions().filter((e) => e.contributes.hasBrowser);

    // Nothing to host and nothing hosted — don't even spawn a worker.
    if (enabled.length === 0 && loaded.size === 0) {
      setExtCommands([]);
      return;
    }
    ensureWorker();

    const desired = new Map(enabled.map((e) => [e.id, e.version]));

    // Unload anything removed, disabled, or version-changed.
    for (const [id, ver] of [...loaded]) {
      if (desired.get(id) !== ver) {
        send({ type: "unload", id });
        loaded.delete(id);
        manifests.delete(id);
      }
    }

    // Load anything new (or freshly re-added after a version change).
    for (const ext of enabled) {
      if (loaded.has(ext.id)) continue;
      const built = await buildLoad(ext);
      if (!built) continue;
      send({ type: "load", manifest: built.manifest, code: built.code });
      loaded.set(ext.id, ext.version);
      manifests.set(ext.id, {
        extName: built.manifest.displayName,
        commands: built.manifest.commands.map((c) => ({
          command: c.command,
          title: c.category ? `${c.category}: ${c.title}` : c.title,
          extId: ext.id,
          extName: built.manifest.displayName,
        })),
      });
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
  for (const m of manifests.values()) all.push(...m.commands);
  setExtCommands(all);
}

// ── Public surface ───────────────────────────────────────────────────────────

/** Boot the host once: load the install index, reconcile, and keep reconciling
 *  whenever the enabled set changes (install / remove / toggle). Idempotent. */
export function bootExtensionHost(): void {
  if (booted) return;
  booted = true;
  // Hand the Monaco bridge the worker callbacks once, so a contributed
  // completion/hover provider can be proxied as soon as the editor mounts.
  setExtHostLangBridge({ provide: provideViaWorker, resolve: resolveViaWorker });
  subscribeInstalled(() => void reconcile());
  void ensureInstalledLoaded().then(() => reconcile());
  // Boot the Node host alongside it — the Tier-2 twin that runs language
  // extensions (Python/rust-analyzer/…) and their LSP servers. It spawns its
  // sidecar lazily, so a workspace with no Node extension pays nothing.
  bootNodeExtensionHost();
}

/** Run a contributed extension command (lazily activating its extension). Routes
 *  to whichever host owns it — the Node host for language/program extensions, the
 *  Web-Worker host otherwise. Shows an honest toast if it fails, so a palette pick
 *  never dies silently. */
export async function executeExtCommand(command: string): Promise<void> {
  if (hasNodeCommand(command)) {
    await executeNodeCommand(command);
    return;
  }
  ensureWorker();
  const reqId = execSeq++;
  try {
    await new Promise<unknown>((resolve, reject) => {
      pendingExec.set(reqId, { resolve, reject });
      send({ type: "execute", reqId, command, args: [] });
    });
  } catch (e) {
    toast("error", `That command couldn't run: ${e instanceof Error ? e.message : String(e)}`);
  }
}
