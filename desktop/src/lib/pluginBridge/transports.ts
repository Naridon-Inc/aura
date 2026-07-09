// Concrete `BridgeTransport` implementations.
//
// Three flavours:
//
//   • WorkerTransport — for logic-only plugins (hooks, brains, analyzers).
//     The plugin's worker.js (built by the SDK in W1.2) postMessages
//     directly to the renderer. Cheap, no DOM cost, but no UI surface.
//
//   • IframeTransport — for plugins that contribute panels / rail tiles.
//     The iframe is sandboxed (`allow-scripts`, no `allow-same-origin`)
//     and loaded from a content URL the host owns. Inbound messages
//     are filtered by `source` so cross-iframe noise can't spoof.
//
//   • MemoryTransport — pure in-process channel for unit tests. Both
//     ends are JS callbacks; no DOM, no globals.
//
// All three honour the same `BridgeTransport` shape, so `PluginBridge`
// doesn't have a branch on plugin kind.

import type { BridgeTransport, PluginBridge } from "./host";
import type { PluginEnvelope } from "./protocol";

// ── worker (logic-only) ────────────────────────────────────────────

export function createWorkerTransport(worker: Worker): BridgeTransport {
  let listener: ((env: unknown) => void) | null = null;
  const onMessage = (ev: MessageEvent) => {
    listener?.(ev.data);
  };
  worker.addEventListener("message", onMessage);
  return {
    postToPlugin(env: PluginEnvelope) {
      worker.postMessage(env);
    },
    onFromPlugin(cb) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    destroy() {
      worker.removeEventListener("message", onMessage);
      worker.terminate();
    },
  };
}

// ── iframe (UI plugin) ─────────────────────────────────────────────

export type IframeTransportOptions = {
  iframe: HTMLIFrameElement;
  /** Origin of the iframe content. Used to filter inbound messages
   *  so we don't process noise from sibling iframes. Plugins are
   *  loaded over `plugin-fs://<plugin-id>` so each gets a unique
   *  origin — this guards against the host accidentally trusting
   *  another plugin's window. */
  expectedOrigin: string;
};

export function createIframeTransport(
  opts: IframeTransportOptions,
): BridgeTransport {
  let listener: ((env: unknown) => void) | null = null;
  const onWindowMessage = (ev: MessageEvent) => {
    // Filter by origin first — cheap reject for sibling iframes.
    if (ev.origin !== opts.expectedOrigin) return;
    if (ev.source !== opts.iframe.contentWindow) return;
    listener?.(ev.data);
  };
  window.addEventListener("message", onWindowMessage);
  return {
    postToPlugin(env: PluginEnvelope) {
      // Iframe may have been pulled from the DOM mid-call; guard.
      const target = opts.iframe.contentWindow;
      if (!target) return;
      // Opaque origins (the literal "null", e.g. sandboxed srcdoc
      // panels) cannot be named as a postMessage targetOrigin — the
      // spec requires "*" or a parseable URL, so passing "null" throws.
      // "*" is safe here because we hold a direct reference to this
      // iframe's own contentWindow; the envelope can't be delivered
      // anywhere else.
      const targetOrigin =
        opts.expectedOrigin === "null" ? "*" : opts.expectedOrigin;
      target.postMessage(env, targetOrigin);
    },
    onFromPlugin(cb) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    destroy() {
      window.removeEventListener("message", onWindowMessage);
      // Detaching the src triggers the browser to terminate the
      // iframe's JS context. Caller is responsible for actually
      // removing the element from the DOM if they want it gone.
      opts.iframe.src = "about:blank";
    },
  };
}

// ── memory (tests + the "preview without spawning" surface) ───────

export type MemoryTransportPair = {
  hostSide: BridgeTransport;
  /** "Other side" of the channel — push into this from the test to
   *  simulate the plugin SDK posting an envelope. */
  pluginPostToHost: (env: PluginEnvelope) => void;
  /** Subscribe to envelopes the host pushed at the plugin. */
  onHostToPlugin: (cb: (env: PluginEnvelope) => void) => () => void;
};

export function createMemoryTransport(): MemoryTransportPair {
  let hostListener: ((env: unknown) => void) | null = null;
  let pluginListeners: ((env: PluginEnvelope) => void)[] = [];
  let destroyed = false;
  const hostSide: BridgeTransport = {
    postToPlugin(env) {
      if (destroyed) return;
      // Microtask deferral keeps host call sites from re-entering the
      // plugin synchronously — mirrors postMessage semantics.
      queueMicrotask(() => {
        for (const l of pluginListeners) l(env);
      });
    },
    onFromPlugin(cb) {
      hostListener = cb;
      return () => {
        hostListener = null;
      };
    },
    destroy() {
      destroyed = true;
      hostListener = null;
      pluginListeners = [];
    },
  };
  return {
    hostSide,
    pluginPostToHost(env) {
      if (destroyed) return;
      queueMicrotask(() => hostListener?.(env));
    },
    onHostToPlugin(cb) {
      pluginListeners.push(cb);
      return () => {
        pluginListeners = pluginListeners.filter((l) => l !== cb);
      };
    },
  };
}

// Re-export PluginBridge from the same module so consumers only import
// from one place. Side-effect free.
export type { PluginBridge };
