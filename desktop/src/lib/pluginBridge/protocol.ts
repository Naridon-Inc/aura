// Plugin bridge wire protocol.
//
// All host ↔ plugin (worker, iframe) communication goes through a single
// JSON envelope shape so we have exactly one place to validate, version,
// and ACL-check. The plugin SDK (`@aura/plugin-host`, W1.2) writes the
// other end of this protocol — keep it forward-compatible.
//
// Versioning:
//   `v` is bumped only on breaking changes. Additive fields (new
//   methods, new event channels) do NOT bump it — the host ignores
//   unknown method names with a clean ErrorCode.UnknownMethod reply.

export const BRIDGE_PROTOCOL_VERSION = 1;

/** Plugin → host call. The host replies with a matching `result`
 *  envelope keyed by `id`. `method` follows `family:verb` (matching the
 *  capability ACL); `target` is the optional scope segment (`api.linear.app`
 *  for a `net:fetch` call). */
export type PluginCallEnvelope = {
  v: number;
  kind: "call";
  /** Monotonic id allocated by the plugin SDK. Host echoes it back. */
  id: string;
  /** `family:verb`. Matches CapabilitySet parsing on both sides. */
  method: string;
  /** Optional scope (domain, resource id) used for ACL match. */
  target?: string;
  /** Method-specific argument shape; host validators sit per-method. */
  args: unknown;
};

/** Host → plugin response. `id` matches the originating `call`. */
export type PluginResultEnvelope =
  | {
      v: number;
      kind: "result";
      id: string;
      ok: true;
      value: unknown;
    }
  | {
      v: number;
      kind: "result";
      id: string;
      ok: false;
      error: PluginError;
    };

/** Host → plugin push, or plugin → host emit. Used for streaming
 *  (terminal output, intent log tail) and for the host's pub/sub
 *  channels (`aura.intent.committed`, `aura.session.started`, …). */
export type PluginEventEnvelope = {
  v: number;
  kind: "event";
  /** Hierarchical channel name; subscriptions match by prefix. */
  channel: string;
  payload: unknown;
};

/** Initial handshake. Host emits this once the worker/iframe signals
 *  ready; plugin replies with `ready` containing its declared
 *  contributes block (for late-binding host UI). */
export type PluginHandshakeEnvelope =
  | {
      v: number;
      kind: "handshake/hello";
      pluginId: string;
      hostVersion: string;
    }
  | {
      v: number;
      kind: "handshake/ready";
      pluginId: string;
      sdkVersion: string;
    };

export type PluginEnvelope =
  | PluginCallEnvelope
  | PluginResultEnvelope
  | PluginEventEnvelope
  | PluginHandshakeEnvelope;

export type PluginError = {
  code: ErrorCode;
  message: string;
  /** Optional capability string that was missing — surfaces in the
   *  "plugin needs permission" UI so the user can grant on demand. */
  capability?: string;
};

export enum ErrorCode {
  /** ACL denied the method:target combination. */
  CapabilityDenied = "capability_denied",
  /** Host has no handler for this method. */
  UnknownMethod = "unknown_method",
  /** Plugin sent malformed envelope. */
  BadEnvelope = "bad_envelope",
  /** Handler threw / rejected. */
  HandlerError = "handler_error",
  /** Plugin timed out or was killed mid-call. */
  Aborted = "aborted",
}

// ── envelope guards ────────────────────────────────────────────────
//
// Anything coming off `postMessage` is `unknown` until proven well-
// formed. These guards live here (not in the host/worker modules) so
// the iframe + worker paths share the exact same parse semantics.

export function isPluginEnvelope(raw: unknown): raw is PluginEnvelope {
  if (!raw || typeof raw !== "object") return false;
  const env = raw as { v?: unknown; kind?: unknown };
  if (typeof env.v !== "number") return false;
  if (typeof env.kind !== "string") return false;
  switch (env.kind) {
    case "call":
    case "result":
    case "event":
    case "handshake/hello":
    case "handshake/ready":
      return true;
    default:
      return false;
  }
}
