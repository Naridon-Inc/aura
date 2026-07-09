"use strict";
// The `vscode` module a Node extension gets when it calls `require("vscode")`.
//
// This is the Node-host twin of the web worker's `vscodeShim.ts`: the same value
// types (Position/Range/Uri/CompletionItem/Diagnostic/…), the same enums, and the
// same "every no-op is a REAL no-op" discipline — a never-firing event still
// returns a working Disposable, an in-memory Memento really stores values, and an
// API the host can't back is simply absent rather than a lie.
//
// What differs from the web shim: this runs in Node, so `workspace.fs` is real
// (backed by `node:fs`), `workspace.workspaceFolders` reflects the open repo, and
// `window.withProgress` actually runs the task. Crucially, a *language* extension
// almost never touches `vscode.languages.register*` directly — it constructs a
// `LanguageClient` (see `languageclient-shim.js`), which is where the LSP bridge
// lives. So `vscode.languages` only needs real completion+hover+diagnostics for
// the rarer extension that registers a provider by hand; everything else is an
// honest, disposable no-op.

const fs = require("fs");
const path = require("path");

// ── Value types extensions construct ─────────────────────────────────────────

class Disposable {
  constructor(callOnDispose) {
    this._fn = callOnDispose;
  }
  dispose() {
    const f = this._fn;
    this._fn = undefined;
    if (f) f();
  }
  static from(...disposables) {
    const list = [...disposables];
    return new Disposable(() => {
      for (const d of list) {
        try {
          d && d.dispose && d.dispose();
        } catch {
          // One bad disposable must not block the rest.
        }
      }
    });
  }
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener) => {
      this._listeners.add(listener);
      return new Disposable(() => this._listeners.delete(listener));
    };
  }
  fire(data) {
    for (const l of [...this._listeners]) {
      try {
        l(data);
      } catch {
        // Isolate listener faults.
      }
    }
  }
  dispose() {
    this._listeners.clear();
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
  isEqual(o) {
    return this.line === o.line && this.character === o.character;
  }
  isBefore(o) {
    return this.line < o.line || (this.line === o.line && this.character < o.character);
  }
  isBeforeOrEqual(o) {
    return this.isBefore(o) || this.isEqual(o);
  }
  isAfter(o) {
    return !this.isBeforeOrEqual(o);
  }
  translate(lineDelta = 0, charDelta = 0) {
    return new Position(this.line + lineDelta, this.character + charDelta);
  }
  with(line = this.line, character = this.character) {
    return new Position(line, character);
  }
  compareTo(o) {
    if (this.isBefore(o)) return -1;
    if (this.isEqual(o)) return 0;
    return 1;
  }
}

class Range {
  constructor(startLine, startChar, endLine, endChar) {
    if (startLine instanceof Position && startChar instanceof Position) {
      this.start = startLine;
      this.end = startChar;
    } else {
      this.start = new Position(startLine, startChar);
      this.end = new Position(endLine ?? 0, endChar ?? 0);
    }
  }
  get isEmpty() {
    return this.start.isEqual(this.end);
  }
  get isSingleLine() {
    return this.start.line === this.end.line;
  }
  contains(posOrRange) {
    const p = posOrRange instanceof Position ? posOrRange : posOrRange.start;
    return !p.isBefore(this.start) && !p.isAfter(this.end);
  }
  with(start = this.start, end = this.end) {
    return new Range(start, end);
  }
}

class Selection extends Range {
  constructor(a, b, c, d) {
    super(a, b, c, d);
    this.anchor = this.start;
    this.active = this.end;
  }
}

class Uri {
  constructor(scheme, authority, p, query, fragment) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = p;
    this.query = query;
    this.fragment = fragment;
  }
  get fsPath() {
    return this.path;
  }
  with(change) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
  toString() {
    let s = `${this.scheme}://${this.authority}${this.path}`;
    if (this.query) s += `?${this.query}`;
    if (this.fragment) s += `#${this.fragment}`;
    return s;
  }
  toJSON() {
    return { scheme: this.scheme, path: this.path };
  }
  static file(p) {
    return new Uri("file", "", p && p.startsWith("/") ? p : `/${p || ""}`, "", "");
  }
  static parse(value) {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (!m) return new Uri("file", "", value, "", "");
    return new Uri(m[1], m[2] ?? "", m[3] ?? "", m[4] ?? "", m[5] ?? "");
  }
  static joinPath(base, ...segments) {
    const joined = [base.path, ...segments].join("/").replace(/\/+/g, "/");
    return base.with({ path: joined });
  }
}

class SnippetString {
  constructor(value = "") {
    this.value = value;
    this._n = 1;
  }
  appendText(s) {
    this.value += s.replace(/[$}\\]/g, "\\$&");
    return this;
  }
  appendTabstop(n = this._n++) {
    this.value += `$${n}`;
    return this;
  }
  appendPlaceholder(value, n = this._n++) {
    this.value += `\${${n}:${String(value).replace(/[$}\\]/g, "\\$&")}}`;
    return this;
  }
  appendChoice(values, n = this._n++) {
    this.value += `\${${n}|${values.join(",")}|}`;
    return this;
  }
  appendVariable(name, defaultValue) {
    this.value += `\${${name}:${defaultValue}}`;
    return this;
  }
}

class MarkdownString {
  constructor(value = "", supportThemeIcons = false) {
    this.value = value;
    this.isTrusted = false;
    this.supportThemeIcons = supportThemeIcons;
    this.supportHtml = false;
  }
  appendText(s) {
    this.value += s.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
    return this;
  }
  appendMarkdown(s) {
    this.value += s;
    return this;
  }
  appendCodeblock(code, language = "") {
    this.value += "\n```" + language + "\n" + code + "\n```\n";
    return this;
  }
}

class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
  }
}

class CompletionList {
  constructor(items = [], isIncomplete = false) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}

class Hover {
  constructor(contents, range) {
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}

class Location {
  constructor(uri, range) {
    this.uri = uri;
    this.range = range;
  }
}

class DiagnosticRelatedInformation {
  constructor(location, message) {
    this.location = location;
    this.message = message;
  }
}

class Diagnostic {
  constructor(range, message, severity = 0) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
  }
}

class TextEdit {
  constructor(range, newText) {
    this.range = range;
    this.newText = newText;
  }
  static replace(range, newText) {
    return new TextEdit(range, newText);
  }
  static insert(position, newText) {
    return new TextEdit(new Range(position, position), newText);
  }
  static delete(range) {
    return new TextEdit(range, "");
  }
}

class WorkspaceEdit {
  constructor() {
    this._edits = new Map();
  }
  set(uri, edits) {
    this._edits.set(String(uri), edits);
  }
  replace(uri, range, newText) {
    const k = String(uri);
    const arr = this._edits.get(k) || [];
    arr.push(new TextEdit(range, newText));
    this._edits.set(k, arr);
  }
  get(uri) {
    return this._edits.get(String(uri)) || [];
  }
}

class RelativePattern {
  constructor(base, pattern) {
    this.baseUri = base instanceof Uri ? base : Uri.file(typeof base === "string" ? base : (base && base.uri && base.uri.fsPath) || "");
    this.pattern = pattern;
  }
}

class CancellationTokenSource {
  constructor() {
    this._emitter = new EventEmitter();
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: this._emitter.event,
    };
  }
  cancel() {
    this.token.isCancellationRequested = true;
    this._emitter.fire(undefined);
  }
  dispose() {
    this._emitter.dispose();
  }
}

// ── Enums ────────────────────────────────────────────────────────────────────

const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
const StatusBarAlignment = { Left: 1, Right: 2 };
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const UIKind = { Desktop: 1, Web: 2 };
const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };
const EndOfLine = { LF: 1, CRLF: 2 };
const CompletionItemKind = {
  Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5,
  Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11,
  Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17,
  Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22,
  Operator: 23, TypeParameter: 24, User: 25, Issue: 26,
};
const CompletionItemTag = { Deprecated: 1 };
const CompletionTriggerKind = { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 };
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
const DiagnosticTag = { Unnecessary: 1, Deprecated: 2 };
const SymbolKind = {
  File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6,
  Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12,
  Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17,
};
const CodeActionKind = {
  Empty: "", QuickFix: "quickfix", Refactor: "refactor", Source: "source",
  SourceOrganizeImports: "source.organizeImports", SourceFixAll: "source.fixAll",
};
const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

// ── In-memory storage ────────────────────────────────────────────────────────

class Memento {
  constructor() {
    this._store = new Map();
  }
  keys() {
    return [...this._store.keys()];
  }
  get(key, defaultValue) {
    return this._store.has(key) ? this._store.get(key) : defaultValue;
  }
  update(key, value) {
    if (value === undefined) this._store.delete(key);
    else this._store.set(key, value);
    return Promise.resolve();
  }
  setKeysForSync() {}
}

class SecretStorage {
  constructor() {
    this._data = new Map();
    this._changed = new EventEmitter();
    this.onDidChange = this._changed.event;
  }
  get(key) {
    return Promise.resolve(this._data.get(key));
  }
  store(key, value) {
    this._data.set(key, value);
    this._changed.fire({ key });
    return Promise.resolve();
  }
  delete(key) {
    this._data.delete(key);
    this._changed.fire({ key });
    return Promise.resolve();
  }
}

// ── Configuration (defaults-backed) ──────────────────────────────────────────

function makeConfiguration(defaults, section) {
  const prefix = section ? `${section}.` : "";
  const resolve = (key) => defaults[`${prefix}${key}`];
  const cfg = {
    get(key, fallback) {
      const v = resolve(key);
      return v === undefined ? fallback : v;
    },
    has(key) {
      return resolve(key) !== undefined;
    },
    inspect(key) {
      return { key: `${prefix}${key}`, defaultValue: resolve(key) };
    },
    update() {
      // No writable settings store yet; accept + no-op so `update` never rejects.
      return Promise.resolve();
    },
  };
  // Also expose the flat defaults as own props so `config.<key>` reads work.
  for (const k of Object.keys(defaults)) {
    if (prefix && !k.startsWith(prefix)) continue;
    const short = prefix ? k.slice(prefix.length) : k;
    if (short && !short.includes(".") && !(short in cfg)) {
      try {
        Object.defineProperty(cfg, short, { value: defaults[k], enumerable: true });
      } catch {
        // ignore non-configurable collisions
      }
    }
  }
  return cfg;
}

// ── OutputChannel / StatusBarItem ────────────────────────────────────────────

function makeOutputChannel(name, host) {
  return {
    name,
    append(value) {
      host.log("info", `[${name}] ${value}`);
    },
    appendLine(value) {
      host.log("info", `[${name}] ${value}`);
    },
    replace(value) {
      host.log("info", `[${name}] ${value}`);
    },
    clear() {},
    show() {},
    hide() {},
    dispose() {},
  };
}

function makeStatusBarItem(alignment, priority) {
  return {
    alignment,
    priority,
    text: "",
    tooltip: undefined,
    command: undefined,
    color: undefined,
    name: undefined,
    show() {},
    hide() {},
    dispose() {},
  };
}

// ── workspace.fs (real, node-backed) ─────────────────────────────────────────

function makeFileSystem() {
  const toPath = (uri) => (uri instanceof Uri ? uri.fsPath : typeof uri === "string" ? uri : String(uri));
  return {
    async readFile(uri) {
      return new Uint8Array(await fs.promises.readFile(toPath(uri)));
    },
    async writeFile(uri, content) {
      await fs.promises.writeFile(toPath(uri), Buffer.from(content));
    },
    async stat(uri) {
      const s = await fs.promises.stat(toPath(uri));
      return {
        type: s.isDirectory() ? FileType.Directory : s.isSymbolicLink() ? FileType.SymbolicLink : FileType.File,
        ctime: s.ctimeMs,
        mtime: s.mtimeMs,
        size: s.size,
      };
    },
    async readDirectory(uri) {
      const entries = await fs.promises.readdir(toPath(uri), { withFileTypes: true });
      return entries.map((e) => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]);
    },
    async createDirectory(uri) {
      await fs.promises.mkdir(toPath(uri), { recursive: true });
    },
    async delete(uri, options) {
      await fs.promises.rm(toPath(uri), { recursive: !!(options && options.recursive), force: true });
    },
    async rename(oldUri, newUri) {
      await fs.promises.rename(toPath(oldUri), toPath(newUri));
    },
    async copy(src, dest) {
      await fs.promises.copyFile(toPath(src), toPath(dest));
    },
  };
}

/** Build the `vscode` namespace object for one extension. `host` is the seam
 *  back into the Node host (commands, language providers, diagnostics, logs). */
function createVscodeApi(host) {
  const never = new EventEmitter();

  const commands = {
    registerCommand(id, callback, thisArg) {
      const bound = thisArg ? callback.bind(thisArg) : callback;
      host.registerCommand(id, bound);
      return new Disposable(() => host.unregisterCommand(id));
    },
    registerTextEditorCommand(id, callback, thisArg) {
      const bound = thisArg ? callback.bind(thisArg) : callback;
      host.registerCommand(id, (...args) => bound(undefined, undefined, ...args));
      return new Disposable(() => host.unregisterCommand(id));
    },
    executeCommand(id, ...args) {
      return host.executeCommand(id, args);
    },
    getCommands() {
      return Promise.resolve(host.getCommandIds());
    },
  };

  const showMessage = (kind) => (message, ...rest) => {
    void rest;
    return host.request("window.showMessage", { kind, message: String(message) }).then(() => undefined);
  };

  const window = {
    showInformationMessage: showMessage("info"),
    showWarningMessage: showMessage("warn"),
    showErrorMessage: showMessage("error"),
    setStatusBarMessage(text) {
      void host.request("window.showMessage", { kind: "info", message: String(text) });
      return new Disposable(() => {});
    },
    createOutputChannel(name) {
      return makeOutputChannel(name, host);
    },
    createStatusBarItem(alignment, priority) {
      return makeStatusBarItem(alignment ?? StatusBarAlignment.Left, priority ?? 0);
    },
    createTextEditorDecorationType() {
      return { key: "deco", dispose() {} };
    },
    showQuickPick() {
      return Promise.resolve(undefined);
    },
    showInputBox() {
      return Promise.resolve(undefined);
    },
    withProgress(_options, task) {
      const progress = { report() {} };
      const token = { isCancellationRequested: false, onCancellationRequested: never.event };
      return Promise.resolve(task(progress, token));
    },
    registerWebviewViewProvider() {
      return new Disposable(() => {});
    },
    registerTreeDataProvider() {
      return new Disposable(() => {});
    },
    createTreeView() {
      return { dispose() {}, reveal() {}, onDidChangeSelection: never.event, onDidChangeVisibility: never.event };
    },
    activeTextEditor: undefined,
    visibleTextEditors: [],
    onDidChangeActiveTextEditor: never.event,
    onDidChangeTextEditorSelection: never.event,
    onDidChangeVisibleTextEditors: never.event,
    onDidChangeWindowState: never.event,
    state: { focused: true },
  };

  const folders = host.workspaceRoot
    ? [{ uri: Uri.file(host.workspaceRoot), name: path.basename(host.workspaceRoot), index: 0 }]
    : undefined;

  const workspace = {
    fs: makeFileSystem(),
    getConfiguration(section) {
      return makeConfiguration(host.configDefaults, section);
    },
    workspaceFolders: folders,
    name: folders ? folders[0].name : undefined,
    rootPath: host.workspaceRoot || undefined,
    getWorkspaceFolder(uri) {
      if (!folders) return undefined;
      const p = uri instanceof Uri ? uri.fsPath : String(uri);
      return p.startsWith(host.workspaceRoot) ? folders[0] : undefined;
    },
    asRelativePath(p) {
      const s = p instanceof Uri ? p.fsPath : String(p);
      if (host.workspaceRoot && s.startsWith(host.workspaceRoot)) {
        return s.slice(host.workspaceRoot.length).replace(/^\/+/, "");
      }
      return s;
    },
    createFileSystemWatcher() {
      // A real watcher object whose events simply never fire (the host self-syncs
      // documents to language servers on demand, so missing FS events don't break
      // completion/hover/diagnostics).
      return {
        onDidCreate: never.event,
        onDidChange: never.event,
        onDidDelete: never.event,
        dispose() {},
      };
    },
    findFiles() {
      return Promise.resolve([]);
    },
    openTextDocument(uriOrOptions) {
      try {
        const p = uriOrOptions instanceof Uri ? uriOrOptions.fsPath : typeof uriOrOptions === "string" ? uriOrOptions : null;
        const text = p ? fs.readFileSync(p, "utf8") : (uriOrOptions && uriOrOptions.content) || "";
        const uri = p ? Uri.file(p) : Uri.parse("untitled:untitled-1");
        return Promise.resolve({
          uri,
          fileName: uri.fsPath,
          languageId: (uriOrOptions && uriOrOptions.language) || "plaintext",
          version: 1,
          getText: () => text,
          lineCount: text.split(/\r\n|\r|\n/).length,
          isUntitled: !p,
        });
      } catch (e) {
        return Promise.reject(e);
      }
    },
    getConfigurationDefaults() {
      return host.configDefaults;
    },
    onDidChangeConfiguration: never.event,
    onDidOpenTextDocument: never.event,
    onDidCloseTextDocument: never.event,
    onDidChangeTextDocument: never.event,
    onDidSaveTextDocument: never.event,
    onDidChangeWorkspaceFolders: never.event,
    onWillSaveTextDocument: never.event,
    textDocuments: [],
  };

  const env = {
    appName: "Aura",
    appRoot: host.extensionPath,
    appHost: "desktop",
    language: "en",
    uiKind: UIKind.Desktop,
    machineId: "aura-desktop-extension-host",
    sessionId: `aura-${host.extId}`,
    isNewAppInstall: false,
    isTelemetryEnabled: false,
    onDidChangeTelemetryEnabled: never.event,
    clipboard: {
      writeText(text) {
        return host.request("env.clipboard.writeText", { text: String(text) }).then(() => undefined);
      },
      readText() {
        return host.request("env.clipboard.readText", {}).then((v) => (typeof v === "string" ? v : ""));
      },
    },
    openExternal(target) {
      return host.request("env.openExternal", { url: String(target) }).then((v) => v === true);
    },
  };

  const noopRegister = () => new Disposable(() => {});
  const languages = {
    registerCompletionItemProvider(selector, provider, ...triggerCharacters) {
      const id = host.registerLanguageProvider({ kind: "completion", selector, impl: provider, triggerCharacters });
      return new Disposable(() => host.unregisterLanguageProvider(id));
    },
    registerHoverProvider(selector, provider) {
      const id = host.registerLanguageProvider({ kind: "hover", selector, impl: provider });
      return new Disposable(() => host.unregisterLanguageProvider(id));
    },
    registerDefinitionProvider: noopRegister,
    registerDeclarationProvider: noopRegister,
    registerTypeDefinitionProvider: noopRegister,
    registerImplementationProvider: noopRegister,
    registerReferenceProvider: noopRegister,
    registerCodeActionsProvider: noopRegister,
    registerDocumentFormattingEditProvider: noopRegister,
    registerDocumentRangeFormattingEditProvider: noopRegister,
    registerOnTypeFormattingEditProvider: noopRegister,
    registerDocumentSymbolProvider: noopRegister,
    registerWorkspaceSymbolProvider: noopRegister,
    registerRenameProvider: noopRegister,
    registerSignatureHelpProvider: noopRegister,
    registerDocumentHighlightProvider: noopRegister,
    registerDocumentLinkProvider: noopRegister,
    registerFoldingRangeProvider: noopRegister,
    registerSelectionRangeProvider: noopRegister,
    registerColorProvider: noopRegister,
    registerCodeLensProvider: noopRegister,
    registerInlineCompletionItemProvider: noopRegister,
    registerCallHierarchyProvider: noopRegister,
    registerSemanticTokensProvider: noopRegister,
    registerDocumentSemanticTokensProvider: noopRegister,
    registerDocumentRangeSemanticTokensProvider: noopRegister,
    setLanguageConfiguration: noopRegister,
    setTextDocumentLanguage(doc) {
      return Promise.resolve(doc);
    },
    match() {
      return 0;
    },
    createDiagnosticCollection(name) {
      const owner = host.nextDiagnosticOwner(name ?? "");
      const store = new Map();
      const keyOf = (uri) => {
        if (typeof uri === "string") return uri;
        if (uri && typeof uri.toString === "function") return String(uri.toString());
        return "";
      };
      const collection = {
        name: name ?? "",
        set(uriOrEntries, diagnostics) {
          if (Array.isArray(uriOrEntries) && diagnostics === undefined) {
            for (const entry of uriOrEntries) {
              if (Array.isArray(entry)) collection.set(entry[0], entry[1] ?? []);
            }
            return;
          }
          const key = keyOf(uriOrEntries);
          if (!key) return;
          const items = Array.isArray(diagnostics) ? diagnostics : [];
          if (items.length === 0) {
            store.delete(key);
            host.clearDiagnostics(owner, key);
          } else {
            store.set(key, items);
            host.setDiagnostics(owner, key, items);
          }
        },
        delete(uri) {
          const key = keyOf(uri);
          if (!key) return;
          store.delete(key);
          host.clearDiagnostics(owner, key);
        },
        clear() {
          store.clear();
          host.clearDiagnostics(owner);
        },
        get(uri) {
          return store.get(keyOf(uri));
        },
        has(uri) {
          return store.has(keyOf(uri));
        },
        forEach(cb, thisArg) {
          for (const [key, items] of store) cb.call(thisArg, Uri.parse(key), items, collection);
        },
        dispose() {
          store.clear();
          host.clearDiagnostics(owner);
        },
      };
      return collection;
    },
    getLanguages() {
      return Promise.resolve([]);
    },
    getDiagnostics() {
      return [];
    },
    onDidChangeDiagnostics: never.event,
  };

  const extensions = {
    getExtension() {
      return undefined;
    },
    all: [],
    onDidChange: never.event,
  };

  return {
    version: "1.96.0",
    Disposable,
    EventEmitter,
    CancellationTokenSource,
    Position,
    Range,
    Selection,
    Uri,
    SnippetString,
    MarkdownString,
    CompletionItem,
    CompletionList,
    Hover,
    Location,
    DiagnosticRelatedInformation,
    Diagnostic,
    CodeAction,
    TextEdit,
    WorkspaceEdit,
    RelativePattern,
    ExtensionMode,
    StatusBarAlignment,
    ViewColumn,
    ConfigurationTarget,
    UIKind,
    TextEditorRevealType,
    EndOfLine,
    CompletionItemKind,
    CompletionItemTag,
    CompletionTriggerKind,
    DiagnosticSeverity,
    DiagnosticTag,
    SymbolKind,
    CodeActionKind,
    ProgressLocation,
    FileType,
    commands,
    window,
    workspace,
    env,
    languages,
    extensions,
  };
}

/** The ExtensionContext passed to `activate(context)`. Storage is in-memory for
 *  the session — real, just not persisted to disk yet. */
function createExtensionContext(host) {
  const extensionUri = Uri.file(host.extensionPath);
  return {
    subscriptions: [],
    extensionPath: host.extensionPath,
    extensionUri,
    extension: { id: host.extId, extensionPath: host.extensionPath, extensionUri, packageJSON: host.packageJSON || {} },
    globalState: new Memento(),
    workspaceState: new Memento(),
    secrets: new SecretStorage(),
    extensionMode: ExtensionMode.Production,
    storageUri: undefined,
    globalStorageUri: extensionUri,
    logUri: extensionUri,
    storagePath: undefined,
    globalStoragePath: host.extensionPath,
    logPath: host.extensionPath,
    asAbsolutePath(relativePath) {
      return path.join(host.extensionPath, relativePath);
    },
    environmentVariableCollection: {
      persistent: false,
      replace() {},
      append() {},
      prepend() {},
      get() {
        return undefined;
      },
      forEach() {},
      delete() {},
      clear() {},
      getScoped() {
        return this;
      },
    },
  };
}

module.exports = {
  Disposable,
  EventEmitter,
  Position,
  Range,
  Selection,
  Uri,
  SnippetString,
  MarkdownString,
  CompletionItem,
  CompletionList,
  Hover,
  Location,
  Diagnostic,
  createVscodeApi,
  createExtensionContext,
};
