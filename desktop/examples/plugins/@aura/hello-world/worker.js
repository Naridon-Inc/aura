// @aura/hello-world — logic sandbox (the manifest `entry`).
//
// This file is deliberately written against the RAW bridge protocol
// (see aura-shell/src/lib/pluginBridge/protocol.ts) so plugin authors
// can see exactly what crosses the wire. A future @aura/plugin-sdk
// wraps all of this in `host.invoke()` / `host.on()` sugar.
//
// Runs as a blob Worker: no DOM, no Tauri IPC — postMessage to the
// host bridge is the ONLY channel. Every call below is checked against
// the capabilities declared in aura.plugin.json (ui:toast, storage:kv,
// aura:status, mcp:call:echo); anything else gets a capability_denied
// result.

const V = 1; // BRIDGE_PROTOCOL_VERSION

let nextId = 1;
const pending = new Map();

/** Promise-shaped call envelope. The host replies with a `result`
 *  envelope echoing our id. */
function call(method, args, target) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, { resolve, reject });
    self.postMessage({ v: V, kind: "call", id, method, target, args });
  });
}

self.onmessage = (ev) => {
  const env = ev.data;
  if (!env || typeof env !== "object") return;

  if (env.kind === "handshake/hello") {
    self.postMessage({
      v: V,
      kind: "handshake/ready",
      pluginId: "@aura/hello-world",
      sdkVersion: "0.1.0-raw",
    });
    boot().catch((e) => console.error("[hello-world] boot failed", e));
    return;
  }

  if (env.kind === "result") {
    const p = pending.get(env.id);
    if (!p) return;
    pending.delete(env.id);
    if (env.ok) p.resolve(env.value);
    else p.reject(new Error(env.error ? env.error.message : "call failed"));
    return;
  }

  if (env.kind === "event") {
    if (env.channel === "aura.ui.slash") {
      onSlash(env.payload).catch(() => {});
    } else if (env.channel === "aura.ui.tile-click") {
      onTileClick(env.payload).catch(() => {});
    }
  }
};

async function boot() {
  // Prefix subscription: "aura.ui" matches aura.ui.slash,
  // aura.ui.tile-click, aura.ui.pill-click.
  await call("host.event.subscribe", { channel: "aura.ui" });

  // KV round-trip: count boots across app restarts.
  const got = await call("storage.kv", { op: "get", key: "boots" });
  const boots = (typeof got.value === "number" ? got.value : 0) + 1;
  await call("storage.kv", { op: "set", key: "boots", value: boots });

  await call("ui.toast", {
    message: `hello-world is alive (boot #${boots})`,
    kind: "info",
  });
}

async function onSlash(payload) {
  // payload = { commandId, text } — the full composer text is handed
  // over so commands can take arguments: "/hello loudly".
  if (payload.commandId === "hello-mcp") {
    return onSlashMcp(payload);
  }
  const status = await call("aura.status", {});
  const summary = JSON.stringify(status).slice(0, 140);
  await call("ui.toast", {
    message: `/${payload.commandId} → aura.status: ${summary}…`,
    kind: "info",
  });
}

async function onSlashMcp(payload) {
  // mcp.call routes to THIS bundle's aura.mcp.json server — a plugin
  // can never name a server, only a tool on its own bundled one. The
  // THIRD param is the envelope `target` and must equal the tool name:
  // the ACL checks `mcp:call:echo` against it, and the host re-checks
  // target === args.tool so you can't declare one tool and call another.
  const text = (payload.text || "").replace(/^\/hello-mcp\s*/, "").trim();
  const res = await call("mcp.call", { tool: "echo", args: { text } }, "echo");
  await call("ui.toast", {
    message: `/hello-mcp → ${res.text}`,
    kind: "info",
  });
}

async function onTileClick(payload) {
  await call("ui.toast", {
    message: `rail tile "${payload.tileId}" clicked`,
    kind: "info",
  });
}
