// @aura/tic-tac-toe — logic sandbox (the manifest `entry`).
//
// The game itself lives in panel.html; this worker's job is presence:
// it subscribes to the plugin's realtime events and toasts when a peer
// sits down at the board, so you notice an invitation even when the
// panel is closed. Written against the RAW bridge protocol like
// @aura/hello-world — no build step, no SDK.
//
// Realtime events arrive on channel `realtime.<topic>` with payload
// { topic, payload, from: { device, display }, ts, self }. `self: true`
// is the host's loopback echo of our own send — presence ignores it.

const V = 1; // BRIDGE_PROTOCOL_VERSION

let nextId = 1;
const pending = new Map();

function call(method, args, target) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, { resolve, reject });
    self.postMessage({ v: V, kind: "call", id, method, target, args });
  });
}

// One toast per session id per window — a peer rejoining after a
// reload shouldn't re-announce every few seconds.
const TOAST_WINDOW_MS = 5 * 60 * 1000;
const greeted = new Map(); // sid -> last toast ts

self.onmessage = (ev) => {
  const env = ev.data;
  if (!env || typeof env !== "object") return;

  if (env.kind === "handshake/hello") {
    self.postMessage({
      v: V,
      kind: "handshake/ready",
      pluginId: "@aura/tic-tac-toe",
      sdkVersion: "0.1.0-raw",
    });
    boot().catch((e) => console.error("[tic-tac-toe] boot failed", e));
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

  if (env.kind === "event" && env.channel === "realtime.tictactoe") {
    onRealtime(env.payload).catch(() => {});
  }
};

async function boot() {
  // Prefix subscription: "realtime" matches realtime.tictactoe. The
  // capability gate is on SENDING and POLLING (Rust side, per topic);
  // subscribing is just routing — we only ever see topics our own
  // capability scope let the host poll for this plugin.
  await call("host.event.subscribe", { channel: "realtime" });
}

async function onRealtime(evt) {
  if (!evt || evt.self === true) return;
  const msg = evt.payload;
  if (!msg || msg.t !== "join") return;
  const sid = typeof msg.sid === "string" ? msg.sid : "?";
  const now = Date.now();
  const last = greeted.get(sid);
  if (last !== undefined && now - last < TOAST_WINDOW_MS) return;
  greeted.set(sid, now);
  const who =
    evt.from && evt.from.display ? evt.from.display : "A teammate";
  await call("ui.toast", {
    message: `${who} is at the tic-tac-toe board`,
    kind: "info",
  });
}
