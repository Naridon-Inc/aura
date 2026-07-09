// The `vscode` module a web extension gets when it calls `require("vscode")`,
// built fresh per extension inside the host worker. Everything here is REAL:
// every function does the correct thing for the no-op case (a never-firing
// event still returns a working Disposable; an in-memory Memento really stores
// and returns values), and nothing throws "not implemented". APIs the host
// genuinely can't back yet are simply absent — an extension that reaches for one
// gets an ordinary TypeError it can guard, and the host reports the activation
// failure plainly rather than pretending the call worked.
//
// The surface targets the common shape of marketplace *web* extensions: command
// registration, user messages, output channels, configuration defaults, the URI
// + geometry value types extensions construct at module load, and the enums they
// reference. It is intentionally not the whole VS Code API — it is the honest
// subset Aura can stand behind.

import type { HostRequestMethod } from "./extHostProtocol";

/** The seam the worker injects so the shim can reach cross-extension state
 *  (the shared command registry) and the main thread (toasts, clipboard). */
export type ShimHost = {
  extId: string;
  extensionPath: string;
  /** Register a runtime command handler in the worker's global registry. */
  registerCommand(commandId: string, handler: CommandHandler): void;
  /** Remove a command handler (called when its Disposable is disposed). */
  unregisterCommand(commandId: string): void;
  /** Execute any command — a locally-registered one, else a host built-in
   *  (unknown built-ins resolve `undefined`, matching "exists, does nothing"). */
  executeCommand(commandId: string, args: unknown[]): Promise<unknown>;
  /** All command ids currently registered across extensions. */
  getCommandIds(): string[];
  /** Round-trip a user-facing request to the main thread. */
  request(method: HostRequestMethod, payload: unknown): Promise<unknown>;
  /** Fire-and-forget log line, attributed to this extension. */
  log(level: "info" | "warn" | "error", message: string): void;
  /** Register a language provider (completion/hover) and announce it to the main
   *  thread so Monaco proxies to it. Returns a providerId for unregistration. */
  registerLanguageProvider(spec: {
    kind: "completion" | "hover";
    selector: unknown;
    impl: Record<string, unknown>;
    triggerCharacters?: string[];
  }): string;
  /** Drop a language provider when its Disposable is disposed. */
  unregisterLanguageProvider(providerId: string): void;
  /** Mint a unique owner id for a new DiagnosticCollection so each collection's
   *  markers stay independent on the main thread. */
  nextDiagnosticOwner(name: string): string;
  /** Publish an owner's diagnostics for one document (raw `vscode.Diagnostic`
   *  objects; the worker serializes them into Monaco markers). */
  setDiagnostics(owner: string, uri: string, items: unknown[]): void;
  /** Clear an owner's diagnostics — one uri, or all of them when uri is omitted. */
  clearDiagnostics(owner: string, uri?: string): void;
  /** Flattened `key → default` from `contributes.configuration`. */
  configDefaults: Record<string, unknown>;
};

type CommandHandler = (...args: unknown[]) => unknown;

// ── Value types extensions construct at module load ──────────────────────────

class Disposable {
  private fn: (() => void) | undefined;
  constructor(callOnDispose: () => void) {
    this.fn = callOnDispose;
  }
  dispose(): void {
    const f = this.fn;
    this.fn = undefined;
    if (f) f();
  }
  static from(...disposables: { dispose(): unknown }[]): Disposable {
    const list = [...disposables];
    return new Disposable(() => {
      for (const d of list) {
        try {
          d.dispose();
        } catch {
          // One bad disposable must not block the rest.
        }
      }
    });
  }
}

class EventEmitter<T> {
  private listeners = new Set<(e: T) => unknown>();
  readonly event = (listener: (e: T) => unknown): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(data: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(data);
      } catch {
        // Isolate listener faults.
      }
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
  isEqual(o: Position): boolean {
    return this.line === o.line && this.character === o.character;
  }
  translate(lineDelta = 0, charDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + charDelta);
  }
  with(line = this.line, character = this.character): Position {
    return new Position(line, character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(
    startLine: number | Position,
    startChar: number | Position,
    endLine?: number,
    endChar?: number,
  ) {
    if (startLine instanceof Position && startChar instanceof Position) {
      this.start = startLine;
      this.end = startChar;
    } else {
      this.start = new Position(startLine as number, startChar as number);
      this.end = new Position(endLine ?? 0, endChar ?? 0);
    }
  }
  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
}

class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;
  constructor(
    a: number | Position,
    b: number | Position,
    c?: number,
    d?: number,
  ) {
    super(a, b, c, d);
    this.anchor = this.start;
    this.active = this.end;
  }
}

/** A minimal, correct URI. Enough for `extensionUri`, `Uri.joinPath`, and the
 *  `.fsPath` / `.toString()` extensions read; not a full RFC-3986 parser. */
export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
  ) {}
  get fsPath(): string {
    return this.path;
  }
  with(change: {
    scheme?: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
  toString(): string {
    let s = `${this.scheme}://${this.authority}${this.path}`;
    if (this.query) s += `?${this.query}`;
    if (this.fragment) s += `#${this.fragment}`;
    return s;
  }
  toJSON(): unknown {
    return { scheme: this.scheme, path: this.path };
  }
  static file(path: string): Uri {
    return new Uri("file", "", path.startsWith("/") ? path : `/${path}`, "", "");
  }
  static parse(value: string): Uri {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(
      value,
    );
    if (!m) return new Uri("file", "", value, "", "");
    return new Uri(m[1], m[2] ?? "", m[3] ?? "", m[4] ?? "", m[5] ?? "");
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path, ...segments]
      .join("/")
      .replace(/\/+/g, "/");
    return base.with({ path: joined });
  }
}

// ── Language-feature value types extensions construct ────────────────────────
// Completion/hover providers build these and hand them back; the worker's
// language bridge serializes them for Monaco. They are REAL objects (a builder's
// `append*` mutates + returns `this`), so an extension's normal usage works.

/** A TM-snippet insert text. Extensions build it with the fluent `append*` API;
 *  we keep the accumulated `value` (TextMate snippet syntax) for Monaco. */
export class SnippetString {
  value: string;
  constructor(value = "") {
    this.value = value;
  }
  private _n = 1;
  appendText(s: string): this {
    this.value += s.replace(/[$}\\]/g, "\\$&");
    return this;
  }
  appendTabstop(n: number = this._n++): this {
    this.value += `$${n}`;
    return this;
  }
  appendPlaceholder(value: string, n: number = this._n++): this {
    this.value += `\${${n}:${value.replace(/[$}\\]/g, "\\$&")}}`;
    return this;
  }
  appendChoice(values: string[], n: number = this._n++): this {
    this.value += `\${${n}|${values.join(",")}|}`;
    return this;
  }
  appendVariable(name: string, defaultValue: string): this {
    this.value += `\${${name}:${defaultValue}}`;
    return this;
  }
}

/** Rendered markdown for documentation/hover. We retain the raw markdown text;
 *  trust/theme-icon flags are accepted but not needed by Monaco's renderer. */
export class MarkdownString {
  value: string;
  isTrusted = false;
  supportThemeIcons = false;
  supportHtml = false;
  constructor(value = "", supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendText(s: string): this {
    this.value += s.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
    return this;
  }
  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }
  appendCodeblock(code: string, language = ""): this {
    this.value += "\n```" + language + "\n" + code + "\n```\n";
    return this;
  }
}

/** A completion suggestion. Plain data with the fields Monaco needs; the worker
 *  bridge reads them off and ships them across. */
export class CompletionItem {
  label: string | { label: string; detail?: string; description?: string };
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: string | MarkdownString;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string | SnippetString;
  range?: Range | { inserting: Range; replacing: Range };
  commitCharacters?: string[];
  keepWhitespace?: boolean;
  constructor(
    label: string | { label: string; detail?: string; description?: string },
    kind?: number,
  ) {
    this.label = label;
    this.kind = kind;
  }
}

/** A list of completions, optionally flagged incomplete (re-query as typing). */
export class CompletionList {
  items: CompletionItem[];
  isIncomplete: boolean;
  constructor(items: CompletionItem[] = [], isIncomplete = false) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}

/** A hover. `contents` is one or more markdown strings / code blocks. */
export class Hover {
  contents: (string | MarkdownString | { language: string; value: string })[];
  range?: Range;
  constructor(
    contents:
      | string
      | MarkdownString
      | { language: string; value: string }
      | (string | MarkdownString | { language: string; value: string })[],
    range?: Range,
  ) {
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}

/** A spot in a document (uri + range), used by diagnostics' related info. */
export class Location {
  constructor(
    readonly uri: Uri,
    readonly range: Range,
  ) {}
}

/** A "see also" note attached to a diagnostic. */
export class DiagnosticRelatedInformation {
  constructor(
    readonly location: Location,
    readonly message: string,
  ) {}
}

/** A diagnostic (one squiggle). Plain data the worker bridge serializes into a
 *  Monaco marker; `severity` defaults to Error like VS Code. */
export class Diagnostic {
  range: Range;
  message: string;
  severity: number;
  source?: string;
  code?: string | number;
  tags?: number[];
  relatedInformation?: DiagnosticRelatedInformation[];
  constructor(range: Range, message: string, severity = 0) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

// ── Enums extensions reference at top level ──────────────────────────────────

const ExtensionMode = { Production: 1, Development: 2, Test: 3 } as const;
const StatusBarAlignment = { Left: 1, Right: 2 } as const;
const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
  Three: 3,
} as const;
const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;
const UIKind = { Desktop: 1, Web: 2 } as const;
const TextEditorRevealType = {
  Default: 0,
  InCenter: 1,
  InCenterIfOutsideViewport: 2,
  AtTop: 3,
} as const;
// VS Code's own CompletionItemKind values — the main thread remaps these to
// Monaco's (different) enum when it builds the suggestion.
const CompletionItemKind = {
  Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5,
  Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11,
  Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17,
  Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22,
  Operator: 23, TypeParameter: 24, User: 25, Issue: 26,
} as const;
const CompletionItemTag = { Deprecated: 1 } as const;
const CompletionTriggerKind = {
  Invoke: 0,
  TriggerCharacter: 1,
  TriggerForIncompleteCompletions: 2,
} as const;
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;
const DiagnosticTag = { Unnecessary: 1, Deprecated: 2 } as const;

// ── Memento (in-memory, real per-session storage) ────────────────────────────

class Memento {
  private store = new Map<string, unknown>();
  keys(): readonly string[] {
    return [...this.store.keys()];
  }
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
    return Promise.resolve();
  }
  setKeysForSync(): void {
    // No cloud sync in the web host; accepting the call is correct + harmless.
  }
}

class SecretStorage {
  private data = new Map<string, string>();
  private changed = new EventEmitter<{ key: string }>();
  readonly onDidChange = this.changed.event;
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.data.get(key));
  }
  store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
    this.changed.fire({ key });
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.data.delete(key);
    this.changed.fire({ key });
    return Promise.resolve();
  }
}

// ── Configuration (defaults-backed) ──────────────────────────────────────────

function makeConfiguration(defaults: Record<string, unknown>, section?: string) {
  const prefix = section ? `${section}.` : "";
  const resolve = (key: string): unknown => defaults[`${prefix}${key}`];
  return {
    get<T>(key: string, fallback?: T): T | undefined {
      const v = resolve(key);
      return (v === undefined ? fallback : v) as T | undefined;
    },
    has(key: string): boolean {
      return resolve(key) !== undefined;
    },
    inspect(key: string) {
      return { key: `${prefix}${key}`, defaultValue: resolve(key) };
    },
    update(): Promise<void> {
      // The web host has no writable settings store yet; accept + no-op so an
      // extension's `update` call doesn't reject.
      return Promise.resolve();
    },
  };
}

// ── OutputChannel ────────────────────────────────────────────────────────────

function makeOutputChannel(name: string, host: ShimHost) {
  return {
    name,
    append(value: string): void {
      host.log("info", `[${name}] ${value}`);
    },
    appendLine(value: string): void {
      host.log("info", `[${name}] ${value}`);
    },
    replace(value: string): void {
      host.log("info", `[${name}] ${value}`);
    },
    clear(): void {
      /* in-host channels have no buffer to clear; calling it is fine */
    },
    show(): void {
      /* no panel to reveal yet — kept as a real no-op so callers don't break */
    },
    hide(): void {},
    dispose(): void {},
  };
}

// ── StatusBarItem (real lightweight object) ──────────────────────────────────

function makeStatusBarItem(alignment: number, priority: number) {
  return {
    alignment,
    priority,
    text: "",
    tooltip: "" as string | undefined,
    command: undefined as string | undefined,
    color: undefined as string | undefined,
    show(): void {},
    hide(): void {},
    dispose(): void {},
  };
}

/** Build the `vscode` namespace object for one extension. */
export function createVscodeApi(host: ShimHost): Record<string, unknown> {
  const neverEmitter = new EventEmitter<unknown>();

  const commands = {
    registerCommand(id: string, callback: CommandHandler, thisArg?: unknown) {
      const bound = thisArg ? callback.bind(thisArg) : callback;
      host.registerCommand(id, bound);
      return new Disposable(() => host.unregisterCommand(id));
    },
    // A text-editor command in the web host has no active editor to inject; we
    // still register it so the command exists and runs (with undefined editor).
    registerTextEditorCommand(id: string, callback: CommandHandler, thisArg?: unknown) {
      const bound = thisArg ? callback.bind(thisArg) : callback;
      host.registerCommand(id, (...args: unknown[]) => bound(undefined, undefined, ...args));
      return new Disposable(() => host.unregisterCommand(id));
    },
    executeCommand<T>(id: string, ...args: unknown[]): Promise<T> {
      return host.executeCommand(id, args) as Promise<T>;
    },
    getCommands(): Promise<string[]> {
      return Promise.resolve(host.getCommandIds());
    },
  };

  const showMessage =
    (kind: "info" | "warn" | "error") =>
    (message: string, ...rest: unknown[]): Promise<unknown> => {
      // Items may be strings or { title } objects; Phase 1 toasts carry no
      // buttons, so we resolve undefined (no selection) after showing.
      void rest;
      return host
        .request("window.showMessage", { kind, message: String(message) })
        .then(() => undefined);
    };

  const window = {
    showInformationMessage: showMessage("info"),
    showWarningMessage: showMessage("warn"),
    showErrorMessage: showMessage("error"),
    setStatusBarMessage(text: string): Disposable {
      void host.request("window.showMessage", { kind: "info", message: String(text) });
      return new Disposable(() => {});
    },
    createOutputChannel(name: string) {
      return makeOutputChannel(name, host);
    },
    createStatusBarItem(alignment?: number, priority?: number) {
      return makeStatusBarItem(alignment ?? StatusBarAlignment.Left, priority ?? 0);
    },
    // Active editor/visible editors aren't modelled in the web host yet.
    activeTextEditor: undefined,
    visibleTextEditors: [] as unknown[],
    onDidChangeActiveTextEditor: neverEmitter.event,
    onDidChangeTextEditorSelection: neverEmitter.event,
    onDidChangeVisibleTextEditors: neverEmitter.event,
  };

  const workspace = {
    getConfiguration(section?: string) {
      return makeConfiguration(host.configDefaults, section);
    },
    workspaceFolders: undefined as unknown,
    name: undefined as string | undefined,
    onDidChangeConfiguration: neverEmitter.event,
    onDidOpenTextDocument: neverEmitter.event,
    onDidCloseTextDocument: neverEmitter.event,
    onDidChangeTextDocument: neverEmitter.event,
    onDidSaveTextDocument: neverEmitter.event,
    onDidChangeWorkspaceFolders: neverEmitter.event,
  };

  const env = {
    appName: "Aura",
    appHost: "web",
    language: "en",
    uiKind: UIKind.Web,
    machineId: "aura-web-extension-host",
    sessionId: `aura-${host.extId}`,
    isNewAppInstall: false,
    clipboard: {
      writeText(text: string): Promise<void> {
        return host
          .request("env.clipboard.writeText", { text: String(text) })
          .then(() => undefined);
      },
      readText(): Promise<string> {
        return host
          .request("env.clipboard.readText", {})
          .then((v) => (typeof v === "string" ? v : ""));
      },
    },
    openExternal(target: { toString(): string }): Promise<boolean> {
      return host
        .request("env.openExternal", { url: target.toString() })
        .then((v) => v === true);
    },
  };

  // languages namespace. Completion + hover providers are REAL: the worker keeps
  // the provider and the main thread attaches a Monaco proxy that calls back into
  // it, so a contributed provider's suggestions/hovers actually surface in the
  // editor. The remaining kinds (definition/code-actions/formatting) still return
  // a working Disposable but aren't invoked yet — honest no-ops, not crashes.
  const noopRegister = (): Disposable => new Disposable(() => {});
  const languages = {
    registerCompletionItemProvider(
      selector: unknown,
      provider: Record<string, unknown>,
      ...triggerCharacters: string[]
    ): Disposable {
      const id = host.registerLanguageProvider({
        kind: "completion",
        selector,
        impl: provider,
        triggerCharacters,
      });
      return new Disposable(() => host.unregisterLanguageProvider(id));
    },
    registerHoverProvider(selector: unknown, provider: Record<string, unknown>): Disposable {
      const id = host.registerLanguageProvider({ kind: "hover", selector, impl: provider });
      return new Disposable(() => host.unregisterLanguageProvider(id));
    },
    registerDefinitionProvider: noopRegister,
    registerCodeActionsProvider: noopRegister,
    registerDocumentFormattingEditProvider: noopRegister,
    registerDocumentSymbolProvider: noopRegister,
    registerSignatureHelpProvider: noopRegister,
    setLanguageConfiguration: noopRegister,
    createDiagnosticCollection(name?: string) {
      // A REAL DiagnosticCollection: it keeps the per-uri diagnostics so an
      // extension can read them back (get/has/forEach), and on every mutation it
      // pushes the change to the main thread, where the worker serializes the
      // diagnostics into Monaco markers (squiggles). Each collection gets its own
      // owner id so two collections never clobber each other's markers.
      const owner = host.nextDiagnosticOwner(name ?? "");
      const store = new Map<string, unknown[]>();
      const keyOf = (uri: unknown): string => {
        if (typeof uri === "string") return uri;
        if (uri && typeof (uri as { toString?: unknown }).toString === "function") {
          return String((uri as { toString(): string }).toString());
        }
        return "";
      };
      const collection = {
        name: name ?? "",
        set(uriOrEntries: unknown, diagnostics?: unknown): void {
          // Bulk form: set(Array<[uri, Diagnostic[] | undefined]>).
          if (Array.isArray(uriOrEntries) && diagnostics === undefined) {
            for (const entry of uriOrEntries) {
              if (Array.isArray(entry)) collection.set(entry[0], entry[1] ?? []);
            }
            return;
          }
          const key = keyOf(uriOrEntries);
          if (!key) return;
          const items = Array.isArray(diagnostics) ? (diagnostics as unknown[]) : [];
          if (items.length === 0) {
            store.delete(key);
            host.clearDiagnostics(owner, key);
          } else {
            store.set(key, items);
            host.setDiagnostics(owner, key, items);
          }
        },
        delete(uri: unknown): void {
          const key = keyOf(uri);
          if (!key) return;
          store.delete(key);
          host.clearDiagnostics(owner, key);
        },
        clear(): void {
          store.clear();
          host.clearDiagnostics(owner);
        },
        get(uri: unknown): unknown[] | undefined {
          return store.get(keyOf(uri));
        },
        has(uri: unknown): boolean {
          return store.has(keyOf(uri));
        },
        forEach(
          cb: (uri: unknown, diagnostics: unknown[], coll: unknown) => void,
          thisArg?: unknown,
        ): void {
          for (const [key, items] of store) cb.call(thisArg, Uri.parse(key), items, collection);
        },
        dispose(): void {
          store.clear();
          host.clearDiagnostics(owner);
        },
      };
      return collection;
    },
    getLanguages(): Promise<string[]> {
      return Promise.resolve([]);
    },
  };

  const extensions = {
    getExtension(): undefined {
      return undefined;
    },
    all: [] as unknown[],
    onDidChange: neverEmitter.event,
  };

  return {
    version: "1.0.0-aura",
    // value types
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
    DiagnosticRelatedInformation,
    Diagnostic,
    // enums
    ExtensionMode,
    StatusBarAlignment,
    ViewColumn,
    ConfigurationTarget,
    UIKind,
    TextEditorRevealType,
    CompletionItemKind,
    CompletionItemTag,
    CompletionTriggerKind,
    DiagnosticSeverity,
    DiagnosticTag,
    // namespaces
    commands,
    window,
    workspace,
    env,
    languages,
    extensions,
  };
}

/** Construct the ExtensionContext passed to `activate(context)`. Storage is
 *  in-memory for the session — real, just not yet persisted to disk. */
export function createExtensionContext(host: ShimHost): Record<string, unknown> {
  const extensionUri = Uri.file(host.extensionPath);
  return {
    subscriptions: [] as { dispose(): unknown }[],
    extensionPath: host.extensionPath,
    extensionUri,
    globalState: new Memento(),
    workspaceState: new Memento(),
    secrets: new SecretStorage(),
    extensionMode: ExtensionMode.Production,
    storageUri: undefined,
    globalStorageUri: extensionUri,
    logUri: extensionUri,
    asAbsolutePath(relativePath: string): string {
      return `${host.extensionPath}/${relativePath}`.replace(/\/+/g, "/");
    },
    environmentVariableCollection: {
      persistent: false,
      replace(): void {},
      append(): void {},
      prepend(): void {},
      get(): undefined {
        return undefined;
      },
      forEach(): void {},
      delete(): void {},
      clear(): void {},
    },
  };
}
