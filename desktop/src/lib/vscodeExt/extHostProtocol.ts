// Wire protocol between the main thread and the VS Code web-extension host
// worker (Tier 1). This is deliberately its OWN small protocol rather than the
// Aura plugin bridge: Aura plugins carry a capability manifest and a family:verb
// host surface, while a VS Code extension expects a `vscode`-shaped API and has
// no Aura manifest. Forcing one through the other would muddy both, so the web
// extension host runs in a dedicated worker with the narrow message set below.
//
// Correlation is by `reqId` (a monotonic counter on whichever side opened the
// request). Everything that can fail carries an `ok` discriminator + an `error`
// string so the surface can show an honest, plain-language failure instead of a
// silent dead command.

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

/** The slice of a `.vsix`'s `extension/package.json` the host actually runs on.
 *  Parsed on the main thread (we already read the manifest there for themes) and
 *  shipped into the worker with the bundle so the worker can route + lazily
 *  activate without another IPC round-trip. */
export type WebExtManifest = {
  /** `<namespace>.<name>` — canonical VS Code extension id. */
  id: string;
  displayName: string;
  version: string;
  /** Absolute path to the extracted bundle root's `extension/` dir, for
   *  `context.extensionPath` / `asAbsolutePath`. */
  extensionPath: string;
  /** Relative path of the web entry (`browser` field), e.g. `dist/web/ext.js`. */
  browserEntry: string;
  /** `activationEvents` verbatim (`onCommand:…`, `onStartupFinished`, `*`, …). */
  activationEvents: string[];
  /** `contributes.commands[]` — id + human title for the palette. */
  commands: ContributedCommand[];
  /** `contributes.configuration` default values, flattened to `key → default`,
   *  so `workspace.getConfiguration().get(key)` returns the declared default. */
  configDefaults: Record<string, unknown>;
};

/** One command an extension declares in `contributes.commands`. */
export type ContributedCommand = {
  /** The command id, e.g. `helloworld-web-sample.helloWorld`. */
  command: string;
  /** The palette title, e.g. `Hello World`. */
  title: string;
  /** Optional category prefix shown as `Category: Title` in the palette. */
  category?: string;
};

// ── Main thread → worker ─────────────────────────────────────────────────────

export type HostToWorker =
  /** Load (and register routing for) one extension's bundle. Does NOT activate
   *  unless an eager activation event (`*` / `onStartupFinished`) is present. */
  | { type: "load"; manifest: WebExtManifest; code: string }
  /** Drop an extension: dispose its subscriptions + forget its commands. */
  | { type: "unload"; id: string }
  /** Run a command id (lazily activating its owning extension first). */
  | { type: "execute"; reqId: number; command: string; args: unknown[] }
  /** A response to a worker→host request (toast shown, clipboard read, …). */
  | { type: "hostResult"; reqId: number; ok: true; value: unknown }
  | { type: "hostResult"; reqId: number; ok: false; error: string }
  /** Ask a registered language provider for completions/hover at a position.
   *  The worker runs the extension's provider against the shipped document and
   *  replies with `provideResult`. */
  | {
      type: "provide";
      reqId: number;
      providerId: string;
      kind: LangProviderKind;
      doc: WireDoc;
      position: WirePos;
      context?: WireCompletionContext;
    }
  /** Lazily enrich one completion item (VS Code `resolveCompletionItem`) when
   *  Monaco focuses it. `handle` identifies the item the worker kept. */
  | { type: "provideResolve"; reqId: number; providerId: string; handle: number };

// ── Worker → main thread ─────────────────────────────────────────────────────

export type WorkerToHost =
  /** Worker booted and is ready to accept `load`. */
  | { type: "ready" }
  /** An extension finished (or failed) activation. `commands` is the set of
   *  command ids it registered at runtime, so the host can reconcile the palette
   *  against what's actually runnable. */
  | { type: "activated"; id: string; ok: boolean; error?: string; commands: string[] }
  /** Result of an `execute`. */
  | { type: "executeResult"; reqId: number; ok: true; value: unknown }
  | { type: "executeResult"; reqId: number; ok: false; error: string }
  /** The extension asked the host to do something user-facing (show a message,
   *  read the clipboard, …). The host fulfils it and replies with `hostResult`. */
  | { type: "hostRequest"; reqId: number; method: HostRequestMethod; payload: unknown }
  /** A log line (output channel / console) — surfaced in the dev log, never a
   *  modal. Carries the extension id so logs stay attributable. */
  | { type: "log"; id: string; level: "info" | "warn" | "error"; message: string }
  /** An extension registered a language provider at activation. The main thread
   *  attaches a Monaco provider for each language that proxies back here. */
  | {
      type: "registerLanguageProvider";
      providerId: string;
      extId: string;
      kind: LangProviderKind;
      /** Concrete Monaco language ids this provider targets. */
      languages: string[];
      /** Characters that should trigger completion (completion only). */
      triggerCharacters?: string[];
      /** True when the provider can lazily enrich an item (`resolveCompletionItem`). */
      hasResolve?: boolean;
    }
  /** A provider's Disposable was disposed — drop its Monaco registrations. */
  | { type: "unregisterLanguageProvider"; providerId: string }
  /** Result of a `provide` / `provideResolve`. `value` is null when the provider
   *  returned nothing (no completions / no hover / no enrichment). */
  | { type: "provideResult"; reqId: number; ok: true; value: WireCompletionList | WireHover | WireCompletionItem | null }
  | { type: "provideResult"; reqId: number; ok: false; error: string }
  /** An extension published diagnostics (squiggles) for a document. `owner`
   *  identifies its DiagnosticCollection so collections stay independent. */
  | { type: "setDiagnostics"; owner: string; uri: string; items: WireDiagnostic[] }
  /** Clear an owner's diagnostics — for one uri, or all of them when uri is absent. */
  | { type: "clearDiagnostics"; owner: string; uri?: string };

/** The user-facing actions an extension can ask the host to perform. Kept tiny
 *  and explicit so the host stays in control of every side effect. */
export type HostRequestMethod =
  | "window.showMessage" // { kind: "info"|"warn"|"error"; message: string }
  | "env.clipboard.writeText" // { text: string }
  | "env.clipboard.readText" // {} → string
  | "env.openExternal"; // { url: string } → boolean

/** Payload of a `window.showMessage` host request. */
export type ShowMessagePayload = {
  kind: "info" | "warn" | "error";
  message: string;
};
