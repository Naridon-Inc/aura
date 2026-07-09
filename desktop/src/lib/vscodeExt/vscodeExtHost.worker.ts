/// <reference lib="webworker" />
//
// The VS Code web-extension host worker. One worker hosts every enabled
// `browser`-field extension (mirroring VS Code's single web extension host), so
// commands can route across extensions and a shared `vscode` surface stays
// consistent. The main thread (extHostRuntime.ts) reads each extension's
// manifest + bundle off disk and ships them in via `load`; this worker runs the
// bundle as CommonJS, hands it a real `vscode` shim, and lazily activates an
// extension the first time one of its commands runs.
//
// Isolation: the worker has no DOM, no Tauri IPC, no `window`. Every user-facing
// side effect (a toast, a clipboard read) is a `hostRequest` the main thread
// fulfils. That keeps the host in control of everything the extension can touch.

import {
  type HostToWorker,
  type HostRequestMethod,
  type WebExtManifest,
  type WorkerToHost,
} from "./extHostProtocol";
import {
  createExtensionContext,
  createVscodeApi,
  type ShimHost,
} from "./vscodeShim";
import {
  clearDiagnostics,
  disposeExtensionDiagnostics,
  disposeExtensionProviders,
  handleProvide,
  handleResolve,
  nextDiagnosticOwner,
  pushDiagnostics,
  registerProvider,
  unregisterProvider,
} from "./vscodeExtHostLang";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerToHost): void {
  ctx.postMessage(msg);
}

// ── Cross-extension state ────────────────────────────────────────────────────

type CommandReg = { extId: string; handler: (...args: unknown[]) => unknown };

/** Every command id registered at runtime → its handler + owning extension. */
const commands = new Map<string, CommandReg>();

/** Command id → extension id that should be activated before the command can
 *  run. Built from `onCommand:` activation events and `contributes.commands`. */
const triggers = new Map<string, string>();

type ExtRecord = {
  manifest: WebExtManifest;
  code: string;
  activated: boolean;
  activating: Promise<void> | null;
  context: Record<string, unknown> | null;
  exports: Record<string, unknown> | null;
};

const extensions = new Map<string, ExtRecord>();

// Outbound host requests (worker → main thread), correlated by reqId.
let hostReqSeq = 1;
const pendingHostReqs = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();

function hostRequest(method: HostRequestMethod, payload: unknown): Promise<unknown> {
  const reqId = hostReqSeq++;
  return new Promise((resolve, reject) => {
    pendingHostReqs.set(reqId, { resolve, reject });
    post({ type: "hostRequest", reqId, method, payload });
  });
}

// ── Module loading (CommonJS) ────────────────────────────────────────────────

/** Run an extension bundle as CommonJS, returning its `module.exports`.
 *  `require("vscode")` yields the per-extension shim; any other module id is an
 *  honest error (the web host provides only `vscode`). */
function evalCommonJs(
  extId: string,
  code: string,
  vscodeApi: Record<string, unknown>,
): Record<string, unknown> {
  const module: { exports: Record<string, unknown> } = { exports: {} };
  const requireFn = (id: string): unknown => {
    if (id === "vscode") return vscodeApi;
    throw new Error(
      `Cannot find module '${id}'. Aura's web extension host provides only the 'vscode' API.`,
    );
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "module",
    "exports",
    "require",
    `${code}\n//# sourceURL=vsext://${extId}/extension.js`,
  );
  fn(module, module.exports, requireFn);
  return module.exports;
}

/** Build the ShimHost seam for one extension — command registration attributes
 *  to this extension, and host requests round-trip to the main thread. */
function makeShimHost(manifest: WebExtManifest): ShimHost {
  return {
    extId: manifest.id,
    extensionPath: manifest.extensionPath,
    registerCommand(commandId, handler) {
      commands.set(commandId, { extId: manifest.id, handler });
    },
    unregisterCommand(commandId) {
      const reg = commands.get(commandId);
      if (reg && reg.extId === manifest.id) commands.delete(commandId);
    },
    executeCommand(commandId, args) {
      return runCommand(commandId, args);
    },
    getCommandIds() {
      return [...commands.keys()];
    },
    registerLanguageProvider(spec) {
      return registerProvider(
        manifest.id,
        spec.kind,
        spec.selector,
        spec.impl,
        spec.triggerCharacters,
        post,
      );
    },
    unregisterLanguageProvider(providerId) {
      unregisterProvider(providerId, post);
    },
    nextDiagnosticOwner(name) {
      return nextDiagnosticOwner(manifest.id, name);
    },
    setDiagnostics(owner, uri, items) {
      pushDiagnostics(owner, uri, items, post);
    },
    clearDiagnostics(owner, uri) {
      clearDiagnostics(owner, uri, post);
    },
    request(method, payload) {
      return hostRequest(method, payload);
    },
    log(level, message) {
      post({ type: "log", id: manifest.id, level, message });
    },
    configDefaults: manifest.configDefaults,
  };
}

// ── Activation ───────────────────────────────────────────────────────────────

async function activate(extId: string): Promise<void> {
  const rec = extensions.get(extId);
  if (!rec) throw new Error(`extension not loaded: ${extId}`);
  if (rec.activated) return;
  if (rec.activating) return rec.activating;

  rec.activating = (async () => {
    const host = makeShimHost(rec.manifest);
    const api = createVscodeApi(host);
    const context = createExtensionContext(host);
    rec.context = context;

    const exports = evalCommonJs(rec.manifest.id, rec.code, api);
    rec.exports = exports;

    const activateFn = exports.activate;
    if (typeof activateFn === "function") {
      // The activate() result may be a thenable (async activation) or the
      // extension's public API; awaiting a non-thenable is harmless.
      await Promise.resolve(activateFn(context));
    }
    rec.activated = true;
  })();

  try {
    await rec.activating;
  } finally {
    rec.activating = null;
  }
}

/** The command ids THIS extension owns right now (declared or registered). */
function commandsOf(extId: string): string[] {
  const out = new Set<string>();
  for (const c of extensions.get(extId)?.manifest.commands ?? []) out.add(c.command);
  for (const [id, reg] of commands) if (reg.extId === extId) out.add(id);
  return [...out];
}

// ── Command execution ────────────────────────────────────────────────────────

async function runCommand(commandId: string, args: unknown[]): Promise<unknown> {
  // Lazily activate the owning extension if the handler isn't registered yet.
  if (!commands.has(commandId)) {
    const owner = triggers.get(commandId);
    if (owner) {
      try {
        await activate(owner);
      } catch (e) {
        throw new Error(`activating ${owner} failed: ${errText(e)}`);
      }
    }
  }
  const reg = commands.get(commandId);
  if (reg) return reg.handler(...args);
  // The extension DECLARED this command (it owns the trigger) but never
  // registered a handler when it activated — a genuine failure, not a
  // built-in we're tolerating. Throw so the palette pick surfaces an honest
  // toast instead of silently doing nothing (the user clicked and the dead
  // button gave no clue why).
  if (triggers.has(commandId)) {
    throw new Error(
      `"${commandId}" didn't run — its extension declares the command but never registered it.`,
    );
  }
  // Truly unknown id → no-op (resolve undefined), matching VS Code's tolerance
  // for fire-and-forget built-ins like `setContext` the web host doesn't model.
  return undefined;
}

// ── Load / unload ────────────────────────────────────────────────────────────

function load(manifest: WebExtManifest, code: string): void {
  // Map every activation trigger + declared command to this extension so the
  // command can lazily activate it. Declared (contributes.commands) ids count
  // too: modern VS Code auto-derives `onCommand:<id>` from them.
  for (const ev of manifest.activationEvents) {
    if (ev.startsWith("onCommand:")) {
      triggers.set(ev.slice("onCommand:".length), manifest.id);
    }
  }
  for (const c of manifest.commands) triggers.set(c.command, manifest.id);

  extensions.set(manifest.id, {
    manifest,
    code,
    activated: false,
    activating: null,
    context: null,
    exports: null,
  });

  const eager = manifest.activationEvents.some(
    (e) => e === "*" || e === "onStartupFinished",
  );
  if (eager) {
    activate(manifest.id)
      .then(() => post({ type: "activated", id: manifest.id, ok: true, commands: commandsOf(manifest.id) }))
      .catch((e) =>
        post({ type: "activated", id: manifest.id, ok: false, error: errText(e), commands: [] }),
      );
  } else {
    // Not activated yet, but its declared commands are already runnable (they'll
    // activate on first use). Report them so the palette lists them immediately.
    post({ type: "activated", id: manifest.id, ok: true, commands: commandsOf(manifest.id) });
  }
}

function unload(extId: string): void {
  const rec = extensions.get(extId);
  if (rec?.context) {
    const subs = rec.context.subscriptions;
    if (Array.isArray(subs)) {
      for (const d of subs) {
        try {
          (d as { dispose(): unknown }).dispose();
        } catch {
          // Keep tearing down the rest.
        }
      }
    }
    const deactivate = rec.exports?.deactivate;
    if (typeof deactivate === "function") {
      try {
        deactivate();
      } catch {
        // Best-effort deactivate.
      }
    }
  }
  for (const [id, reg] of [...commands]) if (reg.extId === extId) commands.delete(id);
  for (const [id, owner] of [...triggers]) if (owner === extId) triggers.delete(id);
  // Drop the extension's language providers too, so Monaco stops proxying to a
  // now-unloaded provider, and clear any diagnostics it published.
  disposeExtensionProviders(extId, post);
  disposeExtensionDiagnostics(extId, post);
  extensions.delete(extId);
}

// ── Message pump ─────────────────────────────────────────────────────────────

ctx.addEventListener("message", (ev: MessageEvent<HostToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "load":
      try {
        load(msg.manifest, msg.code);
      } catch (e) {
        post({ type: "activated", id: msg.manifest.id, ok: false, error: errText(e), commands: [] });
      }
      break;
    case "unload":
      unload(msg.id);
      break;
    case "execute":
      runCommand(msg.command, msg.args)
        .then((value) => post({ type: "executeResult", reqId: msg.reqId, ok: true, value }))
        .catch((e) => post({ type: "executeResult", reqId: msg.reqId, ok: false, error: errText(e) }));
      break;
    case "provide":
      void handleProvide(
        msg.reqId,
        msg.providerId,
        msg.kind,
        msg.doc,
        msg.position,
        msg.context,
        post,
      );
      break;
    case "provideResolve":
      void handleResolve(msg.reqId, msg.providerId, msg.handle, post);
      break;
    case "hostResult": {
      const pending = pendingHostReqs.get(msg.reqId);
      if (pending) {
        pendingHostReqs.delete(msg.reqId);
        if (msg.ok) pending.resolve(msg.value);
        else pending.reject(new Error(msg.error));
      }
      break;
    }
  }
});

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

post({ type: "ready" });
