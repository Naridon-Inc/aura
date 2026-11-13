// The update toast, rendered on its own while a release downloads.
//
// Dev-server only — reached at /update-toast-harness.html?scene=<name>, never
// bundled. The toast, `lib/updater.ts` and the updater plugin's own JavaScript
// are the real ones; only the native side is stood in for: its `check` answers
// with one release, and its `download` streams that release's events down the
// plugin's channel the way the Rust side does — a size, then chunks. Nothing
// is fetched and nothing is installed.
//
//   downloading   A 56.3 MB release, held at 34% so it can be looked at.
//   unknown-size  The server sends no size: the bar slides, "19 MB so far".
//   ready         The download runs to the end: "Ready — restart to update".
//   failed        The connection drops at 41%: the failure with Retry. Retry
//                 streams the whole release and lands on "Ready".
//
// `&hold=<percent>` holds `downloading` somewhere else; `&theme=light` for the
// light palette.

import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import "../../styles.css";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "downloading";
if (params.get("theme") === "light") document.documentElement.classList.add("light");

const SIZE = 56_300_000;
const CHUNK = 512 * 1024;
const TICK_MS = 30;

type Channel = { onmessage: (event: unknown) => void };
type Plan = { announce: boolean; stopAt: number; fail: boolean };

/** How the download in this scene goes. `attempt` counts downloads, so the
 *  failed scene's Retry is a second attempt that goes through. */
function planFor(attempt: number): Plan {
  switch (scene) {
    case "unknown-size":
      return { announce: false, stopAt: 19_200_000, fail: false };
    case "ready":
      return { announce: true, stopAt: SIZE, fail: false };
    case "failed":
      return attempt === 1
        ? { announce: true, stopAt: Math.floor(SIZE * 0.41), fail: true }
        : { announce: true, stopAt: SIZE, fail: false };
    default: {
      const hold = Number(params.get("hold") ?? 34);
      return { announce: true, stopAt: Math.floor((SIZE * Math.min(100, hold)) / 100) + 1, fail: false };
    }
  }
}

let attempts = 0;
/** Streams one download down `channel`. Resolves once every byte is in,
 *  rejects when the plan drops the connection, and otherwise stays pending
 *  where the plan holds it — a download that is still coming in. */
function streamDownload(channel: Channel): Promise<number> {
  attempts += 1;
  const plan = planFor(attempts);
  channel.onmessage({ event: "Started", data: { contentLength: plan.announce ? SIZE : undefined } });
  return new Promise((resolve, reject) => {
    let sent = 0;
    const tick = window.setInterval(() => {
      const chunk = Math.min(CHUNK, plan.stopAt - sent);
      if (chunk > 0) {
        sent += chunk;
        channel.onmessage({ event: "Progress", data: { chunkLength: chunk } });
        return;
      }
      window.clearInterval(tick);
      if (plan.fail) {
        reject(new Error("error sending request for url (https://updates.example/aura.tar.gz): connection reset by peer"));
      } else if (sent >= SIZE) {
        channel.onmessage({ event: "Finished" });
        resolve(2);
      }
      // Otherwise held: the promise stays pending, as a slow download would.
    }, TICK_MS);
  });
}

const callbacks = new Map<number, (payload: unknown) => void>();
let nextCallback = 1;

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "plugin:updater|check":
        return {
          rid: 1,
          currentVersion: "0.20.2",
          version: "0.20.3",
          date: "2026-11-11T09:00:00Z",
          body: "## Comments, reactions and @mentions in cloud workspaces",
          rawJson: {},
        };
      case "plugin:updater|download":
        return streamDownload(args.onEvent as Channel);
      case "plugin:event|listen":
        return nextCallback++;
      case "pty_list_alive":
      case "pty_list_alive_plain":
        return [];
      default:
        throw new Error(`command ${cmd} not found`);
    }
  },
  transformCallback: (cb: (payload: unknown) => void) => {
    const id = nextCallback++;
    callbacks.set(id, cb);
    return id;
  },
  unregisterCallback: (id: number) => callbacks.delete(id),
};

async function mount() {
  const [{ Toaster }, { UpdateToast }] = await Promise.all([
    import("../Toaster"),
    import("../UpdateToast"),
  ]);
  ReactDOM.createRoot(document.getElementById("update-toast-harness")!).render(
    <StrictMode>
      <div style={{ height: "100vh" }} className="bg-bg-content" />
      <Toaster />
      <UpdateToast />
    </StrictMode>,
  );
}

void mount();
