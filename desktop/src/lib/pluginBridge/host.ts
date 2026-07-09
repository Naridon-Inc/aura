// Plugin bridge host — the renderer-side dispatcher.
//
// One `PluginBridge` instance per running plugin. The bridge owns:
//
//   • a transport (worker for logic-only plugins, iframe for plugins
//     that contribute UI), abstracted behind `BridgeTransport`;
//   • the plugin's `CapabilitySet`, so every inbound `call` is checked
//     before the host handler runs;
//   • a `MethodRouter`, the host's surface area (`aura.intent.read`,
//     `net.fetch`, `host.workflow.trigger`, …). Methods are registered
//     by the shell's lib.tsx at boot; the host SDK (W5.x) maintains
//     this catalog.
//
// The bridge purposely doesn't *know* anything about iframes vs workers
// — that's a `BridgeTransport` detail. Tests use a `MemoryTransport` so
// the protocol can be exercised without DOM globals.

import {
  BRIDGE_PROTOCOL_VERSION,
  ErrorCode,
  type PluginCallEnvelope,
  type PluginEnvelope,
  type PluginError,
  type PluginEventEnvelope,
  type PluginResultEnvelope,
  isPluginEnvelope,
} from "./protocol";
import { CapabilitySet } from "./capability";

/** Anything that can ferry envelopes both ways. The iframe and worker
 *  hosts each implement this; tests build a memory-backed one. */
export type BridgeTransport = {
  /** Push an envelope into the plugin. Implementations should be
   *  resilient to the plugin being torn down mid-send (resolves to
   *  void either way). */
  postToPlugin: (env: PluginEnvelope) => void;
  /** Register the inbound listener. The bridge wires the *single*
   *  listener returned by `start()`; transports must call it exactly
   *  once per inbound envelope. Return a tear-down. */
  onFromPlugin: (cb: (env: unknown) => void) => () => void;
  /** Kill the underlying worker/iframe. Idempotent. */
  destroy: () => void;
};

/** Host method handler. `target` carries the scope segment from the
 *  capability check (e.g. for `net:fetch:api.linear.app` the host
 *  handler receives target="api.linear.app"). */
export type HostMethod = (
  args: unknown,
  ctx: HostCallContext,
) => Promise<unknown>;

export type HostCallContext = {
  pluginId: string;
  /** The original scope segment, if any. Verified by the bridge. */
  target: string | undefined;
  /** Signal that fires when the plugin is being torn down — handlers
   *  should abort outstanding work to free resources promptly. */
  signal: AbortSignal;
};

/** Catalog of host methods registered by the shell's plugin host
 *  surfaces (intent reader, fs, fetch proxy, workflow runner, …).
 *  Single instance per shell — shared across all running plugins. */
export class MethodRouter {
  private readonly handlers = new Map<string, HostMethod>();

  register(method: string, handler: HostMethod) {
    if (this.handlers.has(method)) {
      throw new Error(`duplicate host method: ${method}`);
    }
    this.handlers.set(method, handler);
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  get(method: string): HostMethod | undefined {
    return this.handlers.get(method);
  }
}

export type PluginBridgeOptions = {
  pluginId: string;
  hostVersion: string;
  capabilities: CapabilitySet;
  transport: BridgeTransport;
  router: MethodRouter;
  /** Optional callback for telemetry / "plugin requested capability"
   *  prompts. Fires on every denied call. */
  onCapabilityDenied?: (info: {
    method: string;
    target?: string;
    error: PluginError;
  }) => void;
};

export class PluginBridge {
  private readonly opts: PluginBridgeOptions;
  private readonly abort = new AbortController();
  private detach: (() => void) | null = null;
  private destroyed = false;
  /** Channels the plugin has subscribed to via host emit. Used so the
   *  shell can broadcast `aura.intent.committed` only to interested
   *  plugins. */
  private readonly subscriptions = new Set<string>();

  constructor(opts: PluginBridgeOptions) {
    this.opts = opts;
  }

  start() {
    this.detach = this.opts.transport.onFromPlugin((raw) => {
      this.handleInbound(raw);
    });
    // Send the hello — once the plugin's bridge SDK is up it replies
    // with `handshake/ready`. Host UI shows "loading…" until then.
    this.opts.transport.postToPlugin({
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "handshake/hello",
      pluginId: this.opts.pluginId,
      hostVersion: this.opts.hostVersion,
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    this.detach?.();
    this.detach = null;
    this.opts.transport.destroy();
    this.subscriptions.clear();
  }

  /** Broadcast a host event to the plugin if it subscribed to the
   *  channel (or a parent prefix). No-op when the bridge is dead. */
  emit(channel: string, payload: unknown) {
    if (this.destroyed) return;
    if (!this.matchesSubscription(channel)) return;
    const env: PluginEventEnvelope = {
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "event",
      channel,
      payload,
    };
    this.opts.transport.postToPlugin(env);
  }

  private matchesSubscription(channel: string): boolean {
    if (this.subscriptions.has(channel)) return true;
    // Prefix subscription: `aura.intent` matches `aura.intent.committed`.
    for (const sub of this.subscriptions) {
      if (channel.startsWith(sub + ".")) return true;
    }
    return false;
  }

  // ── inbound dispatch ──────────────────────────────────────────────

  private handleInbound(raw: unknown) {
    if (this.destroyed) return;
    if (!isPluginEnvelope(raw)) {
      // We can't reply (no id) — log + drop. The plugin SDK is the
      // only legitimate producer; malformed envelopes mean the
      // sandbox was tampered with, not a user error.
      // eslint-disable-next-line no-console
      console.warn("[pluginBridge] dropped malformed envelope", raw);
      return;
    }
    switch (raw.kind) {
      case "call":
        void this.handleCall(raw);
        break;
      case "event":
        this.handlePluginEvent(raw);
        break;
      case "handshake/ready":
        // Future: surface plugin's declared SDK version to telemetry.
        break;
      // `result` + `handshake/hello` are host→plugin only; ignore.
      case "result":
      case "handshake/hello":
        break;
    }
  }

  private async handleCall(env: PluginCallEnvelope) {
    const replyOk = (value: unknown) => {
      const out: PluginResultEnvelope = {
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "result",
        id: env.id,
        ok: true,
        value,
      };
      this.opts.transport.postToPlugin(out);
    };
    const replyErr = (error: PluginError) => {
      const out: PluginResultEnvelope = {
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "result",
        id: env.id,
        ok: false,
        error,
      };
      this.opts.transport.postToPlugin(out);
    };

    // 1. Method shape check.
    const parsed = parseMethod(env.method);
    if (!parsed) {
      replyErr({
        code: ErrorCode.BadEnvelope,
        message: `bad method format: ${env.method}`,
      });
      return;
    }

    // 2. Internal subscribe/unsubscribe — these don't go through the
    //    method router. They piggyback on `call` so the plugin's SDK
    //    can await acknowledgement.
    if (env.method === "host.event.subscribe") {
      const channel = stringArg(env.args, "channel");
      if (!channel) {
        replyErr({
          code: ErrorCode.BadEnvelope,
          message: "subscribe: missing channel",
        });
        return;
      }
      this.subscriptions.add(channel);
      replyOk({ subscribed: channel });
      return;
    }
    if (env.method === "host.event.unsubscribe") {
      const channel = stringArg(env.args, "channel");
      if (channel) this.subscriptions.delete(channel);
      replyOk({ unsubscribed: channel });
      return;
    }

    // 3. Capability ACL.
    const { family, verb } = parsed;
    if (!this.opts.capabilities.allows(family, verb, env.target)) {
      const err: PluginError = {
        code: ErrorCode.CapabilityDenied,
        message: `plugin ${this.opts.pluginId} lacks capability ${env.method}${
          env.target ? `:${env.target}` : ""
        }`,
        capability: env.target
          ? `${family}:${verb}:${env.target}`
          : `${family}:${verb}`,
      };
      this.opts.onCapabilityDenied?.({
        method: env.method,
        target: env.target,
        error: err,
      });
      replyErr(err);
      return;
    }

    // 4. Router dispatch.
    const handler = this.opts.router.get(env.method);
    if (!handler) {
      replyErr({
        code: ErrorCode.UnknownMethod,
        message: `unknown host method: ${env.method}`,
      });
      return;
    }
    try {
      const value = await handler(env.args, {
        pluginId: this.opts.pluginId,
        target: env.target,
        signal: this.abort.signal,
      });
      replyOk(value);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyErr({
        code: ErrorCode.HandlerError,
        message,
      });
    }
  }

  private handlePluginEvent(env: PluginEventEnvelope) {
    // Plugin-emitted events are not (yet) consumed by the host directly
    // — they're piped to internal listeners registered by the shell's
    // surfaces (status pills, slash commands). W1.3 adds the catalog.
    // For now we ignore them so the protocol round-trips cleanly.
    void env;
  }
}

// ── helpers ───────────────────────────────────────────────────────

type ParsedMethod = { family: string; verb: string };

/** Wire method is `family.verb` (capability scope rides in the
 *  envelope's `target` field, not in the dotted method name). We
 *  tolerate a leading `host.` purely for SDK ergonomics — e.g. the
 *  plugin author writes `host.invoke("host.fs.read", …)` and we strip
 *  the prefix here so the ACL sees `fs:read`. */
function parseMethod(raw: string): ParsedMethod | null {
  const trimmed = raw.trim();
  const stripped = trimmed.startsWith("host.") ? trimmed.slice(5) : trimmed;
  const segments = stripped.split(".");
  if (segments.length !== 2) return null;
  const [family, verb] = segments;
  if (!family || !verb) return null;
  return { family, verb };
}

function stringArg(args: unknown, key: string): string | null {
  if (!args || typeof args !== "object") return null;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}
