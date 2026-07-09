"use strict";
// The Node extension host — one process that runs every enabled Node VS Code
// extension, mirroring VS Code's single shared extension host.
//
// It does four things:
//   1. Intercepts `require("vscode")` and `require("vscode-languageclient[/node]")`
//      so an extension gets Aura's shims instead of the (absent) real modules.
//   2. Loads + activates extensions (reads their package.json, runs `main`,
//      calls `activate(context)`).
//   3. Keeps a provider registry — both DIRECT providers (an extension that calls
//      `vscode.languages.register*Provider`) and LSP providers (a LanguageClient
//      that spawned a language server) funnel into one map, dispatched by
//      providerId on a `provide`/`provideResolve` request.
//   4. Speaks the JSON-lines protocol to Rust (`protocol.js`), emitting the SAME
//      message shapes the web worker emits so the frontend's Monaco bridge is
//      reused verbatim.
//
// Everything heavy (the LSP transport, serialization, the vscode surface) lives in
// the sibling modules; this file is the wiring.

const fs = require("fs");
const path = require("path");
const Module = require("module");

const { send, logErr, onLine } = require("./protocol");
const { EventEmitter, createVscodeApi, createExtensionContext } = require("./vscode-shim");
const { makeTextDocument } = require("./text-document");
const { makeLanguageClientModule } = require("./languageclient-shim");
const serialize = require("./serialize");

// ── Global state ─────────────────────────────────────────────────────────────

const extensions = new Map(); // id → { id, extensionPath, packageJSON, configDefaults, exports, context, vscodeApi, activated }
const commands = new Map(); // commandId → handler
const commandOwner = new Map(); // commandId → extId
const providerHandlers = new Map(); // providerId → { extId, kind, languages, handler }
const docStore = new Map(); // uri → { uri, languageId, version, text }
const heldDirectItems = new Map(); // handle → { providerId, item }
let directHandleSeq = 1;
let diagSeq = 1;
let reqSeq = 1;
const pendingHostRequests = new Map(); // reqId → { resolve, reject }

// Stack of extension ids currently being loaded/activated, so a nested
// `require("vscode")` resolves to the right extension's api.
const loadingStack = [];
function currentExtId() {
  return loadingStack.length ? loadingStack[loadingStack.length - 1] : null;
}

// The open workspace root (file path), set by the `init` message. Drives an LSP
// server's rootUri/workspaceFolders.
let workspaceRoot = null;

// ── Host seam shared by every LanguageClient ─────────────────────────────────

const clientsByExt = new Map(); // extId → Set<LanguageClient>

const lcHost = {
  get workspaceRoot() {
    return workspaceRoot;
  },
  makeEmitter() {
    return new EventEmitter();
  },
  currentExtId,
  log(extId, level, message) {
    send({ type: "log", id: extId || "ext-host", level, message: String(message) });
  },
  registerHostProvider(spec) {
    providerHandlers.set(spec.providerId, {
      extId: spec.extId,
      kind: spec.kind,
      languages: spec.languages,
      handler: spec.handler,
    });
    if (spec.languages && spec.languages.length > 0) {
      send({
        type: "registerLanguageProvider",
        providerId: spec.providerId,
        extId: spec.extId,
        kind: spec.kind,
        languages: spec.languages,
        triggerCharacters: spec.kind === "completion" ? spec.triggerCharacters : undefined,
        hasResolve: spec.kind === "completion" ? !!spec.hasResolve : undefined,
      });
    }
  },
  unregisterHostProvider(providerId) {
    if (providerHandlers.delete(providerId)) {
      send({ type: "unregisterLanguageProvider", providerId });
    }
  },
  setDiagnosticsWire(owner, uri, items) {
    send({ type: "setDiagnostics", owner, uri, items });
  },
  clearDiagnostics(owner, uri) {
    send({ type: "clearDiagnostics", owner, uri });
  },
  trackClient(extId, client) {
    let set = clientsByExt.get(extId);
    if (!set) {
      set = new Set();
      clientsByExt.set(extId, set);
    }
    set.add(client);
  },
  replayOpenDocs(cb) {
    for (const doc of docStore.values()) {
      try {
        cb(Object.assign({ action: "open" }, doc));
      } catch (e) {
        logErr("replayOpenDocs: " + (e && e.message));
      }
    }
  },
};

// Patch the LanguageClient to remember its owning extension + register itself,
// without the shim needing to know host internals.
const languageClientModule = makeLanguageClientModule(lcHost);
const BaseLanguageClient = languageClientModule.LanguageClient;
languageClientModule.LanguageClient = class extends BaseLanguageClient {
  constructor(...args) {
    super(...args);
    this._ownerExtId = currentExtId() || this.id;
    lcHost.trackClient(this._ownerExtId, this);
  }
};

// ── require() interception ───────────────────────────────────────────────────

const defaultVscodeApi = createVscodeApi(makeShimHost("aura.ext-host", process.cwd(), {}, {}));

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return vscodeApiForParent(parent);
  }
  if (request === "vscode-languageclient" || request.startsWith("vscode-languageclient/")) {
    return languageClientModule;
  }
  return origLoad.apply(this, arguments);
};

/** Resolve which extension's `vscode` api a `require("vscode")` belongs to:
 *  prefer the extension currently activating, else the one whose path contains
 *  the requiring file, else a generic api. */
function vscodeApiForParent(parent) {
  const cur = currentExtId();
  if (cur && extensions.has(cur)) return extensions.get(cur).vscodeApi;
  const file = parent && parent.filename;
  if (file) {
    for (const ext of extensions.values()) {
      if (file.startsWith(ext.extensionPath)) return ext.vscodeApi;
    }
  }
  return defaultVscodeApi;
}

// ── Per-extension shim host (the seam vscode-shim.js calls back into) ────────

function makeShimHost(extId, extensionPath, configDefaults, packageJSON) {
  return {
    extId,
    extensionPath,
    configDefaults,
    packageJSON,
    workspaceRoot,
    registerCommand(commandId, handler) {
      commands.set(commandId, handler);
      commandOwner.set(commandId, extId);
    },
    unregisterCommand(commandId) {
      commands.delete(commandId);
      commandOwner.delete(commandId);
    },
    async executeCommand(commandId, args) {
      const fn = commands.get(commandId);
      if (typeof fn !== "function") return undefined; // exists-but-unknown → undefined
      return fn(...(args || []));
    },
    getCommandIds() {
      return [...commands.keys()];
    },
    request(method, payload) {
      const reqId = reqSeq++;
      return new Promise((resolve, reject) => {
        pendingHostRequests.set(reqId, { resolve, reject });
        send({ type: "hostRequest", reqId, method, payload });
      });
    },
    log(level, message) {
      send({ type: "log", id: extId, level, message: String(message) });
    },
    registerLanguageProvider(spec) {
      const kind = spec.kind;
      const providerId = `${extId}::${kind}::${diagSeq++}`;
      const languages = serialize.selectorLanguages(spec.selector);
      providerHandlers.set(providerId, {
        extId,
        kind,
        languages,
        handler: makeDirectHandler(providerId, kind, spec.impl),
      });
      if (languages.length > 0) {
        send({
          type: "registerLanguageProvider",
          providerId,
          extId,
          kind,
          languages,
          triggerCharacters: kind === "completion" ? spec.triggerCharacters : undefined,
          hasResolve: kind === "completion" && typeof spec.impl.resolveCompletionItem === "function",
        });
      }
      return providerId;
    },
    unregisterLanguageProvider(providerId) {
      if (providerHandlers.delete(providerId)) send({ type: "unregisterLanguageProvider", providerId });
    },
    nextDiagnosticOwner(name) {
      return `${extId}::diag::${name || "_"}::${diagSeq++}`;
    },
    setDiagnostics(owner, uri, rawItems) {
      send({ type: "setDiagnostics", owner, uri, items: serialize.serializeProviderDiagnostics(rawItems) });
    },
    clearDiagnostics(owner, uri) {
      send({ type: "clearDiagnostics", owner, uri });
    },
  };
}

/** A provider-handler that runs an extension's DIRECT provider object (the rare
 *  extension that didn't go through a LanguageClient). */
function makeDirectHandler(providerId, kind, impl) {
  return {
    async provide(reqKind, doc, position, context) {
      const document = makeTextDocument(doc);
      const pos = { line: position.line, character: position.character };
      const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
      if (kind === "completion") {
        const fn = impl.provideCompletionItems;
        if (typeof fn !== "function") return null;
        const ctx = context || { triggerKind: 0, triggerCharacter: undefined };
        const raw = await Promise.resolve(fn.call(impl, document, pos, token, ctx));
        const hasResolve = typeof impl.resolveCompletionItem === "function";
        return serialize.serializeCompletions(raw, providerId, hasResolve ? holdDirectItem : null);
      }
      const fn = impl.provideHover;
      if (typeof fn !== "function") return null;
      const raw = await Promise.resolve(fn.call(impl, document, pos, token));
      return serialize.serializeHover(raw);
    },
    async resolve(handle) {
      const held = heldDirectItems.get(handle);
      if (!held || held.providerId !== providerId) return null;
      if (typeof impl.resolveCompletionItem !== "function") return null;
      const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
      try {
        const resolved = await Promise.resolve(impl.resolveCompletionItem(held.item, token));
        const item = resolved && typeof resolved === "object" ? resolved : held.item;
        return serialize.serializeCompletionItem(item, null);
      } catch {
        return null;
      }
    },
  };
}

function holdDirectItem(providerId, item) {
  const handle = directHandleSeq++;
  heldDirectItems.set(handle, { providerId, item });
  if (heldDirectItems.size > 3000) {
    const drop = heldDirectItems.size - 2000;
    let i = 0;
    for (const k of heldDirectItems.keys()) {
      if (i++ >= drop) break;
      heldDirectItems.delete(k);
    }
  }
  return handle;
}

// ── Extension load / unload ──────────────────────────────────────────────────

function flattenConfigDefaults(contributes) {
  const out = {};
  const cfg = contributes && contributes.configuration;
  const blocks = Array.isArray(cfg) ? cfg : cfg ? [cfg] : [];
  for (const b of blocks) {
    const props = b && b.properties;
    if (props && typeof props === "object") {
      for (const key of Object.keys(props)) {
        const def = props[key] && props[key].default;
        if (def !== undefined) out[key] = def;
      }
    }
  }
  return out;
}

async function loadExtension(id, extensionPath) {
  if (extensions.has(id)) return; // already loaded
  let packageJSON = {};
  try {
    packageJSON = JSON.parse(fs.readFileSync(path.join(extensionPath, "package.json"), "utf8"));
  } catch (e) {
    send({ type: "activated", id, ok: false, error: `cannot read package.json: ${(e && e.message) || e}`, commands: [] });
    return;
  }
  const realId = packageJSON.publisher && packageJSON.name ? `${packageJSON.publisher}.${packageJSON.name}` : id;
  const configDefaults = flattenConfigDefaults(packageJSON.contributes);
  const shimHost = makeShimHost(realId, extensionPath, configDefaults, packageJSON);
  const vscodeApi = createVscodeApi(shimHost);
  const context = createExtensionContext(shimHost);
  const record = { id: realId, extensionPath, packageJSON, configDefaults, exports: null, context, vscodeApi, activated: false };
  extensions.set(realId, record);
  if (realId !== id) extensions.set(id, record); // also reachable by the caller's id

  const mainRel = packageJSON.main || packageJSON.browser;
  if (!mainRel) {
    // No runnable entry — nothing to activate (themes/grammars are handled by the
    // contributes router, not here). Report success with no commands.
    send({ type: "activated", id: realId, ok: true, commands: [] });
    return;
  }
  const mainAbs = path.join(extensionPath, mainRel);

  loadingStack.push(realId);
  try {
    const mod = require(mainAbs);
    record.exports = mod;
    if (typeof mod.activate === "function") {
      await Promise.resolve(mod.activate(context));
    }
    record.activated = true;
    const cmds = [...commandOwner.entries()].filter(([, owner]) => owner === realId).map(([c]) => c);
    send({ type: "activated", id: realId, ok: true, commands: cmds });
  } catch (e) {
    send({ type: "activated", id: realId, ok: false, error: (e && e.stack) || String(e), commands: [] });
    logErr(`activate(${realId}) failed: ${(e && e.stack) || e}`);
  } finally {
    loadingStack.pop();
  }
}

async function unloadExtension(id) {
  const record = extensions.get(id);
  if (!record) return;
  const realId = record.id;

  // Stop any language servers this extension started.
  const set = clientsByExt.get(realId);
  if (set) {
    for (const client of set) {
      try {
        await client.stop();
      } catch {
        // ignore
      }
    }
    clientsByExt.delete(realId);
  }

  // Call deactivate + dispose its subscriptions.
  try {
    if (record.exports && typeof record.exports.deactivate === "function") {
      await Promise.resolve(record.exports.deactivate());
    }
  } catch (e) {
    logErr(`deactivate(${realId}): ${(e && e.message) || e}`);
  }
  for (const sub of record.context.subscriptions || []) {
    try {
      sub && sub.dispose && sub.dispose();
    } catch {
      // ignore
    }
  }

  // Drop its commands + any providers still registered under it.
  for (const [cmd, owner] of [...commandOwner]) {
    if (owner === realId) {
      commands.delete(cmd);
      commandOwner.delete(cmd);
    }
  }
  for (const [pid, h] of [...providerHandlers]) {
    if (h.extId === realId) {
      providerHandlers.delete(pid);
      send({ type: "unregisterLanguageProvider", providerId: pid });
    }
  }

  // Evict from the require cache so a re-enable re-runs activate cleanly.
  try {
    const mainRel = record.packageJSON.main || record.packageJSON.browser;
    if (mainRel) {
      const mainAbs = require.resolve(path.join(record.extensionPath, mainRel));
      for (const key of Object.keys(require.cache)) {
        if (key.startsWith(record.extensionPath)) delete require.cache[key];
      }
      void mainAbs;
    }
  } catch {
    // best effort
  }

  extensions.delete(id);
  if (extensions.get(realId) === record) extensions.delete(realId);
}

// ── Provide / resolve dispatch ───────────────────────────────────────────────

async function handleProvide(msg) {
  const h = providerHandlers.get(msg.providerId);
  if (!h || !h.handler || typeof h.handler.provide !== "function") {
    send({ type: "provideResult", reqId: msg.reqId, ok: true, value: null });
    return;
  }
  try {
    const value = await h.handler.provide(msg.kind, msg.doc, msg.position, msg.context);
    send({ type: "provideResult", reqId: msg.reqId, ok: true, value: value ?? null });
  } catch (e) {
    send({ type: "provideResult", reqId: msg.reqId, ok: false, error: (e && e.message) || String(e) });
  }
}

async function handleResolve(msg) {
  const h = providerHandlers.get(msg.providerId);
  if (!h || !h.handler || typeof h.handler.resolve !== "function") {
    send({ type: "provideResult", reqId: msg.reqId, ok: true, value: null });
    return;
  }
  try {
    const value = await h.handler.resolve(msg.handle);
    send({ type: "provideResult", reqId: msg.reqId, ok: true, value: value ?? null });
  } catch (e) {
    send({ type: "provideResult", reqId: msg.reqId, ok: false, error: (e && e.message) || String(e) });
  }
}

// ── Document lifecycle ───────────────────────────────────────────────────────

function handleDoc(msg) {
  const doc = msg.doc;
  if (!doc || typeof doc.uri !== "string") return;
  if (msg.action === "close") {
    docStore.delete(doc.uri);
  } else {
    docStore.set(doc.uri, { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text });
  }
  // Fan the change out to every running language client (each filters by language).
  const payload = Object.assign({ action: msg.action || "change" }, doc);
  for (const set of clientsByExt.values()) {
    for (const client of set) {
      try {
        if (typeof client.syncDoc === "function") client.syncDoc(payload);
      } catch (e) {
        logErr("syncDoc: " + (e && e.message));
      }
    }
  }
}

// ── Command execution from the frontend ──────────────────────────────────────

async function handleExecute(msg) {
  const fn = commands.get(msg.command);
  if (typeof fn !== "function") {
    send({ type: "executeResult", reqId: msg.reqId, ok: false, error: `command not found: ${msg.command}` });
    return;
  }
  try {
    const value = await Promise.resolve(fn(...(msg.args || [])));
    send({ type: "executeResult", reqId: msg.reqId, ok: true, value: value ?? null });
  } catch (e) {
    send({ type: "executeResult", reqId: msg.reqId, ok: false, error: (e && e.message) || String(e) });
  }
}

// ── Message router ───────────────────────────────────────────────────────────

// Extension load/unload mutate shared lifecycle state — `loadingStack` (which
// `require("vscode")` consults to resolve the activating extension) and the
// require cache. The protocol layer dispatches each stdin line on its OWN
// microtask (fire-and-forget), so without this a burst of `load` messages from a
// single reconcile would interleave at the `await activate()` yield point and the
// `finally { loadingStack.pop() }` could pop the wrong extension. Chain them so
// load/unload run strictly one-at-a-time; provide/resolve/doc/execute stay
// concurrent (they only read provider state, never the loading stack).
let lifecycleChain = Promise.resolve();
function enqueueLifecycle(fn) {
  // `.then(fn, fn)` keeps the chain alive even if a prior op rejected.
  lifecycleChain = lifecycleChain.then(fn, fn);
  return lifecycleChain;
}

async function onMessage(msg) {
  switch (msg && msg.type) {
    case "init":
      workspaceRoot = typeof msg.workspaceRoot === "string" ? msg.workspaceRoot : null;
      return;
    case "load":
      await enqueueLifecycle(() => loadExtension(msg.id, msg.extensionPath));
      return;
    case "unload":
      await enqueueLifecycle(() => unloadExtension(msg.id));
      return;
    case "execute":
      await handleExecute(msg);
      return;
    case "provide":
      await handleProvide(msg);
      return;
    case "provideResolve":
      await handleResolve(msg);
      return;
    case "doc":
      handleDoc(msg);
      return;
    case "hostResult": {
      const p = pendingHostRequests.get(msg.reqId);
      if (p) {
        pendingHostRequests.delete(msg.reqId);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error || "host request failed"));
      }
      return;
    }
    default:
      logErr("unknown message type: " + (msg && msg.type));
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

process.on("uncaughtException", (e) => logErr("uncaught: " + ((e && e.stack) || e)));
process.on("unhandledRejection", (e) => logErr("unhandledRejection: " + ((e && e.stack) || e)));

onLine(onMessage);
send({ type: "ready" });
