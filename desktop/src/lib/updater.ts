// Auto-update flow. Checks for a release on boot (then at most once per
// 6 hours) and downloads it; `UpdateToast` shows the download's progress, then
// a "Ready — restart to update" toast with a Restart button. Only that click
// installs the downloaded bundle (tauri-plugin-updater) and relaunches the
// app (tauri-plugin-process).
//
// The endpoint + signing pubkey are configured in
// `src-tauri/tauri.conf.json::plugins.updater`. Releases come out of
// the GitHub Actions workflow under `.github/workflows/release.yml` —
// it builds, signs, and uploads `latest.json` + the platform bundles.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api";

const LAST_CHECK_KEY = "aura.updater.lastCheckedAt";
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export type UpdateInfo = {
  version: string;
  notes: string | null;
  date: string | null;
  update: Update;
};

let inflightCheck: Promise<UpdateInfo | null> | null = null;
// Reset to false on every app launch (fresh JS context). Guarantees the
// first probe per launch actually hits the server even if the *previous*
// launch checked within the debounce window — `lastCheckedAt` lives in
// localStorage and persists across launches, so without this a user who
// relaunches inside 6h would never re-check. That was the "stuck on an old
// version, relaunch doesn't help" bug.
let didBootProbe = false;

/** Check for an update. Probes once per app launch (the "check on boot"
 *  behaviour), then debounces subsequent non-forced checks to once per 6
 *  hours so we don't hammer the endpoint mid-session. `force` (the manual
 *  "Check for updates" button) always probes. Resolves to null when no
 *  update is available — caller can then show "you're up to date" if they
 *  were prompted explicitly. */
export async function checkForUpdate(
  force = false,
): Promise<UpdateInfo | null> {
  const isBootProbe = !didBootProbe;
  didBootProbe = true;
  if (!force && !isBootProbe) {
    const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0);
    if (Date.now() - last < SIX_HOURS_MS) return null;
  }
  if (inflightCheck) return inflightCheck;
  inflightCheck = (async () => {
    try {
      const update = await check();
      try {
        localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
      } catch {
        /* localStorage may be locked */
      }
      if (!update) return null;
      return {
        version: update.version,
        notes: update.body ?? null,
        date: update.date ?? null,
        update,
      };
    } catch (err) {
      // Endpoint unreachable, signature mismatch, dev build pointed
      // at a non-release endpoint. For a background probe we stay quiet
      // — log and back off. But a *forced* check is the user explicitly
      // asking "is there an update?"; swallowing the error there makes
      // the UI claim "you're on the latest" when we actually never
      // reached the server (this exact lie hid a 404 that froze every
      // user at one version). On a forced check, surface the failure so
      // the caller can say "couldn't check" instead of "up to date".
      console.warn("update check failed:", err);
      if (force) throw err instanceof Error ? err : new Error(String(err));
      return null;
    } finally {
      inflightCheck = null;
    }
  })();
  return inflightCheck;
}

/** EXDEV: tauri-updater renames the new bundle over the install path; on
 *  Intel Macs with /Applications on a separate volume the rename crosses
 *  filesystems and dies with `Cross-device link (os error 18)`. */
function isCrossDeviceError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /cross-device link|os error 18/i.test(msg);
}

/** Download the update bundle in the background. The plugin verifies the
 *  signature against the pubkey baked into the app at build time. Nothing
 *  is installed yet — the bytes wait in the updater until `installAndRestart`
 *  runs, so the app is never swapped from under the person (and on Windows,
 *  where installing closes the app, it only happens when they click). */
export async function downloadUpdate(
  info: UpdateInfo,
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;
  try {
    await info.update.download((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
        onProgress?.(0, total);
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        onProgress?.(downloaded, total);
      } else if (event.event === "Finished") {
        onProgress?.(total ?? downloaded, total);
      }
    });
  } catch (e: unknown) {
    if (isCrossDeviceError(e)) throw new UpdateRequiresManualInstall(info.version);
    throw e;
  }
}

/** Install a bundle `downloadUpdate` already fetched, then relaunch onto it.
 *  Throws `UpdateRequiresManualInstall` when this machine can't replace the
 *  app in place, so the caller can offer the manual download instead. */
export async function installAndRestart(info: UpdateInfo): Promise<void> {
  try {
    await info.update.install();
  } catch (e: unknown) {
    // Falls back to opening the download page in the browser so the person
    // can install manually rather than getting stuck.
    if (isCrossDeviceError(e)) throw new UpdateRequiresManualInstall(info.version);
    throw e;
  }
  await restartIntoUpdate();
}

/** Relaunch the app onto the freshly-downloaded update. Run the PTY
 *  daemon handshake first so any live agent sessions get a chance to
 *  detach into the long-running daemon process before we kill this
 *  shell. */
export async function restartIntoUpdate(): Promise<void> {
  // Pre-relaunch handshake — if the user has the aura-pty-daemon
  // running (AURA_USE_PTY_DAEMON=1), live agent PTY sessions are
  // owned by that long-lived process and will survive the
  // forthcoming `relaunch()`. Tell the daemon now so it has a
  // chance to flush bookkeeping; the count comes back so we know
  // how many sessions to surface for reattach on the next launch.
  //
  // Best-effort: a daemon-down error is logged but doesn't block
  // the relaunch. The user accepted the update; we don't want to
  // strand them on an old version because a daemon RPC tripped.
  try {
    const survivors = await api.ptyPreRelaunchSignal();
    if (survivors > 0) {
      console.info(
        `[updater] aura-pty-daemon will keep ${survivors} agent session(s) alive across relaunch`,
      );
    }
  } catch (err) {
    console.warn(
      "[updater] pre-relaunch PTY daemon handshake failed; " +
        "in-flight agent sessions will be terminated by relaunch",
      err,
    );
  }
  await relaunch();
}

/** Thrown when auto-install isn't viable on this machine. UpdateToast
 *  catches it and offers the manual download instead. */
export class UpdateRequiresManualInstall extends Error {
  readonly version: string;
  constructor(version: string) {
    super(
      "Auto-install isn't supported on this drive. " +
        "Opening the download page in your browser instead.",
    );
    this.name = "UpdateRequiresManualInstall";
    this.version = version;
  }
}

/** Open the platform-specific DMG download for a given version in the user's
 *  browser. Surfaces both arch URLs since detecting Intel-via-Rosetta vs
 *  native arm64 from the renderer is brittle. */
export async function openManualDownload(version: string): Promise<void> {
  // Open the version directory; nginx autoindex (or a landing page) lists
  // both DMGs side by side. Falls back to the latest manifest if the dir
  // listing isn't enabled.
  const url = `https://auravcs.com/updates/${version}/`;
  await openUrl(url);
}
