// @aura/gemini — logic sandbox (the manifest `entry`).
//
// The Gemini app does all of its work in the app.html iframe (it owns the
// UI and makes the net.fetch calls), so this worker is intentionally tiny:
// it exists only to satisfy the required `entry` and to complete the bridge
// handshake. It holds no secrets and opens no channels — the credential
// never touches plugin code at all; the host attaches it to the outbound
// request (see `netAuth` in aura.plugin.json).
//
// Written against the RAW bridge protocol (see
// aura-shell/src/lib/pluginBridge/protocol.ts) so there is no build step.

const V = 1; // BRIDGE_PROTOCOL_VERSION

self.onmessage = (ev) => {
  const env = ev.data;
  if (!env || typeof env !== "object") return;
  if (env.kind === "handshake/hello") {
    self.postMessage({
      v: V,
      kind: "handshake/ready",
      pluginId: "@aura/gemini",
      sdkVersion: "0.1.0-raw",
    });
  }
};
