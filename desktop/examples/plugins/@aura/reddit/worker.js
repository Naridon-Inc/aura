// @aura/reddit — logic sandbox (the manifest `entry`).
//
// Like the Gemini sample, the Reddit reader does all its work in the app.html
// iframe (it owns the UI and makes the net.fetch calls), so this worker is
// intentionally tiny: it exists only to satisfy the required `entry` and to
// complete the bridge handshake. It holds no state and opens no channels.
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
      pluginId: "@aura/reddit",
      sdkVersion: "0.1.0-raw",
    });
  }
};
