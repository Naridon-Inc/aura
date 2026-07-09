"use strict";
// The `vscode-languageclient` module an extension gets when it does
//   const { LanguageClient } = require("vscode-languageclient/node")
//
// This is the heart of "make unsupported extensions run". A VS Code language
// extension never declares its server in package.json — it constructs a
// `LanguageClient` inside `activate()` and calls `.start()`. So our LanguageClient
// shim IS the LSP bridge:
//
//   1. read `clientOptions.documentSelector` → the languages this server covers,
//   2. spawn the server from `serverOptions` (a NodeModule → `node module --stdio`,
//      or an Executable → spawn the binary with its own args),
//   3. speak LSP JSON-RPC over the server's stdio (`lsp-client.js`),
//   4. `initialize` → read the server's capabilities (resolve support, trigger
//      characters, hover),
//   5. register host language providers for those languages, so Monaco proxies
//      completion/hover into this client,
//   6. sync documents (didOpen/didChange/didClose) so the server has the text,
//   7. on a provide request, send `textDocument/completion` | `hover` and
//      serialize the LSP reply to the wire,
//   8. forward `publishDiagnostics` → host `setDiagnosticsWire`.
//
// Built per-host (closes over the host seam) so every client shares one diagnostic
// channel and one provider registry.

const cp = require("child_process");
const { LspClient } = require("./lsp-client");
const { logErr } = require("./protocol");
const { selectorLanguages, lspCompletionToWire, lspItemToWire, lspHoverToWire, lspDiagnosticsToWire } = require("./serialize");

const TransportKind = { stdio: 0, ipc: 1, pipe: 2, socket: 3 };
const RevealOutputChannelOn = { Info: 1, Warn: 2, Error: 3, Never: 4 };
const State = { Stopped: 1, Running: 2, Starting: 3 };
const ErrorAction = { Continue: 1, Shutdown: 2 };
const CloseAction = { DoNotRestart: 1, Restart: 2 };

/** Reduce a `serverOptions` value to a concrete `{ run|debug } | Executable |
 *  NodeModule`, preferring the production (`run`) entry. */
function pickServer(serverOptions) {
  let so = serverOptions;
  if (so && typeof so === "object" && (so.run || so.debug)) so = so.run || so.debug;
  return so;
}

/** Turn a resolved server descriptor into a spawnable `{ command, args, options }`.
 *  NodeModule servers are launched with the host's node and forced onto a stdio
 *  transport (the universal one `vscode-languageserver` understands). Executable
 *  servers are spawned exactly as the extension specified — it knows its own
 *  server's transport flags. */
function buildSpawn(so) {
  const nodeBin = process.env.AURA_EXT_HOST_NODE || process.execPath;
  if (so && typeof so.module === "string") {
    const opts = so.options || {};
    const execArgv = Array.isArray(opts.execArgv) ? opts.execArgv : [];
    const userArgs = Array.isArray(so.args) ? so.args : [];
    const args = [...execArgv, so.module, ...userArgs];
    const hasTransport = userArgs.some((a) => /^--(stdio|node-ipc|socket=|pipe=|port=)/.test(String(a)));
    if (!hasTransport) args.push("--stdio");
    return { command: nodeBin, args, options: opts };
  }
  if (so && typeof so.command === "string") {
    return { command: so.command, args: Array.isArray(so.args) ? so.args : [], options: so.options || {} };
  }
  return null;
}

/** Build the `initialize` params with the capabilities we actually back. */
function initParams(rootUri) {
  return {
    processId: process.pid,
    clientInfo: { name: "Aura", version: "1.0.0" },
    rootUri: rootUri || null,
    rootPath: rootUri ? rootUri.replace(/^file:\/\//, "") : null,
    workspaceFolders: rootUri ? [{ uri: rootUri, name: "workspace" }] : null,
    capabilities: {
      textDocument: {
        synchronization: { dynamicRegistration: false, didSave: true },
        completion: {
          dynamicRegistration: false,
          contextSupport: true,
          completionItem: {
            snippetSupport: true,
            commitCharactersSupport: true,
            documentationFormat: ["markdown", "plaintext"],
            deprecatedSupport: true,
            preselectSupport: true,
            tagSupport: { valueSet: [1] },
            insertReplaceSupport: true,
            labelDetailsSupport: true,
            resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
          },
          completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
        },
        hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
        publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, versionSupport: false },
      },
      workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: false } },
      window: { workDoneProgress: true },
    },
    initializationOptions: undefined,
  };
}

/** Construct the `vscode-languageclient` module bound to one host seam. */
function makeLanguageClientModule(host) {
  let clientSeq = 0;

  class LanguageClient {
    constructor(arg1, arg2, arg3, arg4) {
      // Overloads: (id, name, serverOptions, clientOptions) OR
      //            (id, serverOptions, clientOptions).
      if (arg2 && typeof arg2 === "object" && (arg2.run || arg2.command || arg2.module || typeof arg2 === "function")) {
        this.id = String(arg1);
        this.name = String(arg1);
        this._serverOptions = arg2;
        this._clientOptions = arg3 || {};
      } else {
        this.id = String(arg1);
        this.name = String(arg2 || arg1);
        this._serverOptions = arg3;
        this._clientOptions = arg4 || {};
      }
      this._clientId = `lsp-${++clientSeq}-${(this.id || "client").replace(/[^a-z0-9_-]/gi, "")}`;
      this._languages = selectorLanguages(this._clientOptions.documentSelector);
      this._lsp = null;
      this._child = null;
      this._state = State.Stopped;
      this._opened = new Map(); // uri → version we've sent to the server
      this._heldItems = new Map(); // handle → original LSP item (for resolve)
      this._handleSeq = 1;
      this._caps = {};
      this._diagOwner = `${this._clientId}::diag`;
      this._providerIds = [];
      this._stateEmitter = host.makeEmitter();
      this.onDidChangeState = this._stateEmitter.event;
    }

    get state() {
      return this._state;
    }

    _setState(s) {
      const old = this._state;
      this._state = s;
      try {
        this._stateEmitter.fire({ oldState: old, newState: s });
      } catch {
        // ignore
      }
    }

    async start() {
      if (this._state !== State.Stopped) return;
      if (this._languages.length === 0) {
        host.log(this.id, "warn", `language client "${this.name}" has no concrete document languages — not started`);
        return;
      }
      this._setState(State.Starting);
      const so = buildSpawn(pickServer(this._serverOptions));
      if (!so) {
        this._setState(State.Stopped);
        host.log(this.id, "error", `cannot start "${this.name}": unsupported serverOptions (need a NodeModule or Executable)`);
        return;
      }

      const env = Object.assign({}, process.env, (so.options && so.options.env) || {});
      let child;
      try {
        child = cp.spawn(so.command, so.args, {
          cwd: (so.options && so.options.cwd) || host.workspaceRoot || undefined,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e) {
        this._setState(State.Stopped);
        host.log(this.id, "error", `failed to spawn server for "${this.name}": ${(e && e.message) || e}`);
        return;
      }
      this._child = child;
      child.on("error", (e) => host.log(this.id, "error", `server error (${this.name}): ${(e && e.message) || e}`));
      child.on("exit", (code, signal) => {
        host.log(this.id, code === 0 ? "info" : "warn", `server "${this.name}" exited (code ${code}${signal ? ", " + signal : ""})`);
        this._setState(State.Stopped);
        // A deliberate stop() nulls `_child` before the kill lands, so `=== child`
        // is only true on an UNEXPECTED exit (the server crashed). Tear it down so
        // we don't leave stale providers/diagnostics or hang the next completion
        // request for 15s writing into a dead pipe.
        if (this._child === child) this._cleanupDeadServer();
      });
      if (child.stderr) {
        child.stderr.on("data", (d) => logErr(`[${this.id}:server] ${String(d).trimEnd()}`));
      }

      this._lsp = new LspClient(child, (method, params) => this._onServerNotify(method, params));

      const rootUri = host.workspaceRoot ? "file://" + host.workspaceRoot : null;
      try {
        const initResult = await this._lsp.request("initialize", initParams(rootUri), 20000);
        this._caps = (initResult && initResult.capabilities) || {};
        this._lsp.notify("initialized", {});
        try {
          this._lsp.notify("workspace/didChangeConfiguration", { settings: {} });
        } catch {
          // optional
        }
      } catch (e) {
        host.log(this.id, "error", `initialize failed for "${this.name}": ${(e && e.message) || e}`);
        this.stop();
        return;
      }

      this._registerProviders();
      this._setState(State.Running);
      host.log(this.id, "info", `language server "${this.name}" running for ${this._languages.join(", ")}`);

      // The server is up — push any documents the host already knows about so
      // diagnostics flow immediately (not only after the first completion).
      host.replayOpenDocs((doc) => this.syncDoc(doc));
    }

    _registerProviders() {
      const compCap = this._caps.completionProvider;
      const triggerCharacters = compCap && Array.isArray(compCap.triggerCharacters) ? compCap.triggerCharacters : undefined;
      const hasResolve = !!(compCap && compCap.resolveProvider);

      // Completion (most servers advertise it).
      if (compCap) {
        const pid = `${this._clientId}::completion`;
        this._providerIds.push(pid);
        host.registerHostProvider({
          providerId: pid,
          extId: this.id,
          kind: "completion",
          languages: this._languages,
          triggerCharacters,
          hasResolve,
          handler: {
            provide: (kind, doc, position, context) => this._provideCompletion(doc, position, context),
            resolve: (handle) => this._resolveCompletion(handle),
          },
        });
      }
      // Hover.
      if (this._caps.hoverProvider) {
        const pid = `${this._clientId}::hover`;
        this._providerIds.push(pid);
        host.registerHostProvider({
          providerId: pid,
          extId: this.id,
          kind: "hover",
          languages: this._languages,
          handler: { provide: (kind, doc, position) => this._provideHover(doc, position) },
        });
      }
    }

    _covers(languageId) {
      return this._languages.includes(languageId);
    }

    /** Ensure the server has the current text of `doc` before a request. */
    _ensureSynced(doc) {
      if (!this._lsp || !this._covers(doc.languageId)) return;
      const known = this._opened.get(doc.uri);
      if (known === undefined) {
        this._opened.set(doc.uri, doc.version);
        this._lsp.notify("textDocument/didOpen", {
          textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text },
        });
      } else if (known !== doc.version) {
        this._opened.set(doc.uri, doc.version);
        this._lsp.notify("textDocument/didChange", {
          textDocument: { uri: doc.uri, version: doc.version },
          contentChanges: [{ text: doc.text }], // full-document sync
        });
      }
    }

    /** Public doc lifecycle, driven by the host's `doc` messages. */
    syncDoc(doc) {
      if (!this._lsp || this._state !== State.Running) return;
      if (!this._covers(doc.languageId)) return;
      if (doc.action === "close") {
        if (this._opened.has(doc.uri)) {
          this._opened.delete(doc.uri);
          this._lsp.notify("textDocument/didClose", { textDocument: { uri: doc.uri } });
        }
        return;
      }
      this._ensureSynced(doc);
    }

    async _provideCompletion(doc, position, context) {
      if (!this._lsp) return null;
      this._ensureSynced(doc);
      const params = {
        textDocument: { uri: doc.uri },
        position: { line: position.line, character: position.character },
      };
      if (context) {
        params.context = {
          triggerKind: typeof context.triggerKind === "number" ? context.triggerKind + 1 : 1, // VS Code 0-based → LSP 1-based
          triggerCharacter: context.triggerCharacter,
        };
      }
      const result = await this._lsp.request("textDocument/completion", params);
      const hasResolve = !!(this._caps.completionProvider && this._caps.completionProvider.resolveProvider);
      return lspCompletionToWire(result, hasResolve ? (it) => this._hold(it) : null);
    }

    async _resolveCompletion(handle) {
      const item = this._heldItems.get(handle);
      if (!item || !this._lsp) return null;
      try {
        const resolved = await this._lsp.request("completionItem/resolve", item, 8000);
        return lspItemToWire(resolved && typeof resolved === "object" ? resolved : item, null);
      } catch {
        return lspItemToWire(item, null);
      }
    }

    async _provideHover(doc, position) {
      if (!this._lsp) return null;
      this._ensureSynced(doc);
      const result = await this._lsp.request("textDocument/hover", {
        textDocument: { uri: doc.uri },
        position: { line: position.line, character: position.character },
      });
      return lspHoverToWire(result);
    }

    _hold(item) {
      const handle = this._handleSeq++;
      this._heldItems.set(handle, item);
      if (this._heldItems.size > 3000) {
        const drop = this._heldItems.size - 2000;
        let i = 0;
        for (const k of this._heldItems.keys()) {
          if (i++ >= drop) break;
          this._heldItems.delete(k);
        }
      }
      return handle;
    }

    /** Tear down after the server process died on its own (crash / killed). Mirrors
     *  stop()'s cleanup but never tries to talk to the dead process. Leaves the
     *  client in Stopped state with no registered providers, so Monaco stops
     *  proxying into it and pending requests reject at once instead of timing out. */
    _cleanupDeadServer() {
      for (const pid of this._providerIds) host.unregisterHostProvider(pid);
      this._providerIds = [];
      host.clearDiagnostics(this._diagOwner);
      if (this._lsp) {
        this._lsp.dispose(); // rejects in-flight requests + kills the (already-dead) child
        this._lsp = null;
      }
      this._child = null;
      this._opened.clear();
      this._heldItems.clear();
    }

    _onServerNotify(method, params) {
      if (method === "textDocument/publishDiagnostics" && params && typeof params.uri === "string") {
        host.setDiagnosticsWire(this._diagOwner, params.uri, lspDiagnosticsToWire(params.diagnostics));
      }
      // window/logMessage, telemetry, etc. — surfaced as logs, never modals.
      else if (method === "window/logMessage" && params && typeof params.message === "string") {
        host.log(this.id, "info", `[server] ${params.message}`);
      }
    }

    async stop() {
      for (const pid of this._providerIds) host.unregisterHostProvider(pid);
      this._providerIds = [];
      host.clearDiagnostics(this._diagOwner);
      if (this._lsp) {
        try {
          await this._lsp.request("shutdown", null, 2000).catch(() => {});
          this._lsp.notify("exit", null);
        } catch {
          // best effort
        }
        this._lsp.dispose();
        this._lsp = null;
      }
      if (this._child) {
        try {
          this._child.kill();
        } catch {
          // ignore
        }
        this._child = null;
      }
      this._opened.clear();
      this._heldItems.clear();
      this._setState(State.Stopped);
    }

    // vscode-languageclient compatibility surface used in activate():
    onReady() {
      return Promise.resolve();
    }
    onNotification() {
      return { dispose() {} };
    }
    onRequest() {
      return { dispose() {} };
    }
    sendNotification(method, params) {
      if (this._lsp) this._lsp.notify(method, params);
    }
    sendRequest(method, params) {
      return this._lsp ? this._lsp.request(method, params) : Promise.resolve(null);
    }
    dispose() {
      return this.stop();
    }
  }

  // Some extensions import `LanguageClient` from the base package and the node
  // transport types from `/node`; both resolve to this module, so expose the full
  // commonly-imported surface.
  return {
    LanguageClient,
    TransportKind,
    RevealOutputChannelOn,
    State,
    ErrorAction,
    CloseAction,
    // Settled-state monitors some clients construct; harmless real objects.
    SettingMonitor: class SettingMonitor {
      constructor(client) {
        this._client = client;
      }
      start() {
        if (this._client && this._client.start) this._client.start();
        return { dispose() {} };
      }
    },
  };
}

module.exports = { makeLanguageClientModule };
