// The one place an Aura update shows up: a toast in the bottom-right stack.
//
//   launch (and hourly) → check → download
//     → "Downloading update…"  a bar + "34% · 19 of 56 MB"   ⓧ = Hide
//         (the server sent no size → the bar slides, "19 MB so far")
//     → "Couldn't download the update"  [Retry]
//     → "Ready — restart to update" + the release's first line
//         [See changes]  [Restart]        ⓧ = Later
//     → while an agent or a terminal is working:
//         [See changes]  [Restart when idle]  [Restart]
//     → once "Restart when idle" is set:
//         "Will restart when all agents are idle"  [Cancel]  [Restart now]
//
// The bar moves on the updater's own byte counts (`lib/updater.ts`
// `downloadUpdate`), redrawn only when the line under it changes
// (`lib/updateProgress.ts`). Hiding it does not stop the download: the toast
// comes back as "Ready", or as the failure if it fails. All of these faces are
// the same toast, replaced in place.
//
// Restart installs the bundle that was already downloaded and relaunches onto
// it — the only click that touches the running app. "Restart when idle" does
// the same thing later: it watches the agents' turns and the app's terminals
// and restarts once all of them have been quiet for a few seconds
// (`lib/updateToast.ts` decides when). Closing the toast is
// "Later": that version stays quiet for a day (`lib/updateToast.ts`), while a
// newer release, or "Check for Updates" from the Aura menu, shows it again.
//
// A manual check always answers, so the menu click never looks like it did
// nothing: "Checking for updates…" turns into the download's own progress (or
// "Ready" when it is already in), "You're up to date!" or "Aura couldn't check
// for updates".

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  checkForUpdate,
  downloadUpdate,
  installAndRestart,
  openManualDownload,
  UpdateRequiresManualInstall,
  type UpdateInfo,
} from "../lib/updater";
import { api, type LivePlainPtySession, type LivePtySession } from "../lib/api";
import { toast, type ToastInput } from "../lib/toast";
import { useFleetActivity } from "../lib/useFleetActivity";
import {
  DOWNLOAD_START,
  downloadLabel,
  downloadPercent,
  nextProgress,
  updateToastView,
  type DownloadProgress,
  type DownloadState,
} from "../lib/updateProgress";
import {
  busyTerminals,
  IDLE_WAIT_START,
  isSnoozed,
  releaseHeadline,
  releaseNotesUrl,
  shouldShowUpdateToast,
  snoozeVersion,
  stepIdleWait,
  updateOffer,
  UPDATE_CHECK_EVENT,
  UPDATE_CHECK_TOAST_ID,
  UPDATE_PREVIEW_EVENT,
  UPDATE_TOAST_ID,
  type IdleWait,
  type SnoozeStore,
} from "../lib/updateToast";
import { LiveToast } from "./LiveToast";
import { Button } from "./ui/button";
import { AsciiSpinner } from "./ui/ascii-spinner";
import { Progress } from "./ui/progress";

/** A release that's downloaded and waiting. `info` is null only for the
 *  development preview, whose Restart installs nothing. */
type Ready = { version: string; notes: string | null; info: UpdateInfo | null };

/** The download being narrated, with the release behind it so Retry can ask
 *  for it again. */
type Download = DownloadState & { info: UpdateInfo };

const BOOT_DELAY_MS = 1500;
/** `checkForUpdate(false)` itself holds this to once per 6 hours; the tick
 *  just makes sure a window left open for days still hears about a release. */
const RECHECK_EVERY_MS = 60 * 60 * 1000;
/** How often the terminals are asked whether they are printing: now and then
 *  while the toast is up, so it knows whether to offer "Restart when idle",
 *  and every second once a restart is waiting on them. Both lists live in
 *  memory on the native side, so a read is cheap. */
const TERMINAL_POLL_MS = 5000;
const WAITING_POLL_MS = 1000;

function storage(): SnoozeStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function showManualInstall(version: string) {
  // Auto-install can't work from this location (a read-only mounted disk
  // image, or /Applications on a separate volume).
  toast.show({
    id: "update-manual-install",
    tone: "warning",
    title: `Install Aura ${version} to keep it updated`,
    message:
      "Aura can’t update itself from its current location. Drag Aura " +
      "into your Applications folder and open it from there, then " +
      "updates install on their own.",
    durationMs: null,
    actions: [
      {
        label: `Download ${version}`,
        variant: "primary",
        onClick: () => openManualDownload(version),
      },
    ],
  });
}

/** The bar and the line under it while a release comes in. */
function DownloadMeter({ version, progress }: { version: string; progress: DownloadProgress }) {
  const label = downloadLabel(progress);
  return (
    <span className="mt-[2px] block text-xs">
      <span className="block tabular-nums">{label}</span>
      <Progress
        className="aura-toast-progress"
        value={downloadPercent(progress)}
        aria-label={`Downloading Aura ${version}`}
        aria-valuetext={label}
      />
    </span>
  );
}

/** Whether any agent anywhere is mid-turn — reported only when that flips.
 *  The fleet stores tick on every streamed chunk; this probe takes those
 *  re-renders so the toast, which re-sends itself on each render, does not. */
function AgentsBusyProbe({ onChange }: { onChange: (busy: boolean) => void }) {
  const { working } = useFleetActivity();
  useEffect(() => onChange(working), [working, onChange]);
  return null;
}

/** Every terminal the app is running — agent sessions and plain shells — and
 *  how long since each one printed. Never throws: a window that cannot ask
 *  (no native side, a daemon that is down) has no terminals to wait on. */
async function terminalIdleTimes(): Promise<Array<number | null>> {
  const [agents, shells] = await Promise.all([
    api.ptyListAlive().catch((): LivePtySession[] => []),
    api.ptyListAlivePlain().catch((): LivePlainPtySession[] => []),
  ]);
  return [...agents, ...shells].map((s) => s.idle_ms);
}

export function UpdateToast() {
  const [ready, setReady] = useState<Ready | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [agentsBusy, setAgentsBusy] = useState(false);
  const [terminalsBusy, setTerminalsBusy] = useState(false);
  // "Restart when idle" is set and the restart is waiting for quiet.
  const [waiting, setWaiting] = useState(false);
  const busy = agentsBusy || terminalsBusy;
  // The download on screen: coming in, or stopped by an error.
  const [download, setDownload] = useState<Download | null>(null);
  // The person hid the progress; the download carries on regardless.
  const [progressHidden, setProgressHidden] = useState(false);
  // The version being downloaded right now, and the last one that finished —
  // so a second check for the same release neither downloads it twice nor
  // waits for a download that's already done.
  const downloadingRef = useRef<string | null>(null);
  const downloadedRef = useRef<UpdateInfo | null>(null);

  // Download `info`, narrating it: progress as the bytes arrive, then ready,
  // or the failure with a Retry that comes back here.
  const fetchRelease = useRef(async (_info: UpdateInfo) => {});
  fetchRelease.current = async (info) => {
    downloadingRef.current = info.version;
    setProgressHidden(false);
    setDownload({ phase: "downloading", version: info.version, progress: DOWNLOAD_START, info });
    try {
      await downloadUpdate(info, (downloaded, total) => {
        setDownload((d) => {
          if (!d || d.phase !== "downloading" || d.version !== info.version) return d;
          const progress = nextProgress(d.progress, downloaded, total);
          return progress === d.progress ? d : { ...d, progress };
        });
      });
      downloadedRef.current = info;
      setDownload(null);
      setReady({ version: info.version, notes: info.notes, info });
    } catch (e: unknown) {
      if (e instanceof UpdateRequiresManualInstall) {
        setDownload(null);
        showManualInstall(e.version);
      } else {
        setDownload({ phase: "failed", version: info.version, reason: errorText(e), info });
      }
    } finally {
      if (downloadingRef.current === info.version) downloadingRef.current = null;
    }
  };

  // A check found `info`. Download it (unless that's done) and raise the toast.
  const offer = useRef(async (_info: UpdateInfo, _manual: boolean) => {});
  offer.current = async (info, manual) => {
    const snoozed = isSnoozed(info.version, Date.now(), storage());
    if (!shouldShowUpdateToast({ version: info.version, snoozed, manual })) return;
    const done = downloadedRef.current;
    if (done && done.version === info.version) {
      setReady({ version: done.version, notes: done.notes, info: done });
      return;
    }
    if (downloadingRef.current === info.version) {
      // Already coming in; asking again brings hidden progress back.
      if (manual) setProgressHidden(false);
      return;
    }
    await fetchRelease.current(info);
  };

  // Background checks: shortly after launch, then on the hourly tick.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      checkForUpdate(false).then((info) => {
        if (!cancelled && info) void offer.current(info, false);
      });
    };
    const boot = window.setTimeout(run, BOOT_DELAY_MS);
    const tick = window.setInterval(run, RECHECK_EVERY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(boot);
      window.clearInterval(tick);
    };
  }, []);

  // The checks someone asked for: the Aura menu's "Check for Updates…"
  // (`menu:check_for_updates`) and anything that calls `requestUpdateCheck`.
  useEffect(() => {
    let cancelled = false;
    const manualCheck = async () => {
      toast.loading("Checking for updates…", undefined, { id: UPDATE_CHECK_TOAST_ID });
      try {
        const info = await checkForUpdate(true);
        if (cancelled) return;
        if (!info) {
          toast.success("You're up to date!", "You're running the latest version of Aura.", {
            id: UPDATE_CHECK_TOAST_ID,
          });
          return;
        }
        // The update toast itself is the answer: the download's progress, or
        // "Ready" when it is already in.
        toast.dismiss(UPDATE_CHECK_TOAST_ID);
        void offer.current(info, true);
      } catch (e: unknown) {
        if (cancelled) return;
        toast.danger(
          "Aura couldn't check for updates",
          `${errorText(e)}. Check your internet connection and try again from the Aura menu.`,
          { id: UPDATE_CHECK_TOAST_ID },
        );
      }
    };
    const onWindow = () => void manualCheck();
    window.addEventListener(UPDATE_CHECK_EVENT, onWindow);
    const un = listen("menu:check_for_updates", () => void manualCheck());
    return () => {
      cancelled = true;
      window.removeEventListener(UPDATE_CHECK_EVENT, onWindow);
      un.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Development builds only: shows the toast with no release behind it, so it
  // can be looked at. Shipped builds compile this branch away.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onPreview = (e: Event) => {
      const d = (e as CustomEvent<{ version?: string; notes?: string } | undefined>).detail;
      setReady({
        version: d?.version ?? "0.0.0-preview",
        notes: d?.notes ?? "A preview of the update toast. Nothing will be installed.",
        info: null,
      });
    };
    window.addEventListener(UPDATE_PREVIEW_EVENT, onPreview);
    return () => window.removeEventListener(UPDATE_PREVIEW_EVENT, onPreview);
  }, []);

  const restartingRef = useRef(false);
  const restart = async () => {
    if (!ready || restartingRef.current) return;
    restartingRef.current = true;
    setWaiting(false);
    setRestarting(true);
    try {
      if (ready.info) {
        await installAndRestart(ready.info);
      } else {
        toast.info("Preview only", "This is a development preview, so nothing was installed.");
        setReady(null);
      }
    } catch (e: unknown) {
      if (e instanceof UpdateRequiresManualInstall) {
        setReady(null);
        showManualInstall(e.version);
      } else {
        toast.danger("Aura couldn't restart into the update", errorText(e), {
          id: "update-install-failed",
        });
      }
    } finally {
      restartingRef.current = false;
      setRestarting(false);
    }
  };
  // The wait below fires from a timer; it calls whichever `restart` the
  // latest render made, so it restarts into the release on screen now.
  const restartRef = useRef(restart);
  restartRef.current = restart;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Are the terminals printing? Asked only while there is an update to offer.
  const offering = ready != null;
  useEffect(() => {
    if (!offering) return;
    let cancelled = false;
    const read = async () => {
      const idle = await terminalIdleTimes();
      if (!cancelled) setTerminalsBusy(busyTerminals(idle) > 0);
    };
    void read();
    const tick = window.setInterval(() => void read(), waiting ? WAITING_POLL_MS : TERMINAL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
    };
  }, [offering, waiting]);

  // "Restart when idle": look once a second, and restart once everything has
  // been quiet long enough that it is not just a gap between two turns.
  useEffect(() => {
    if (!waiting) return;
    let wait: IdleWait = IDLE_WAIT_START;
    const look = () => {
      const step = stepIdleWait(wait, busyRef.current, Date.now());
      wait = step.wait;
      if (step.fire) {
        window.clearInterval(tick);
        void restartRef.current();
      }
    };
    const tick = window.setInterval(look, WAITING_POLL_MS);
    look();
    return () => window.clearInterval(tick);
  }, [waiting]);

  const view = updateToastView({
    ready: ready != null,
    download: download?.phase ?? null,
    progressHidden,
  });

  let face: ToastInput | null = null;
  if (view === "ready" && ready) {
    const mode = updateOffer({ busy, waiting });
    const headline = releaseHeadline(ready.version, ready.notes);
    face = {
      tone: "accent",
      title: "Ready — restart to update",
      dismissLabel: `Later. Aura ${ready.version} waits until tomorrow`,
      onDismiss: () => {
        snoozeVersion(ready.version, Date.now(), storage());
        setWaiting(false);
        setReady(null);
      },
      message:
        mode === "waiting" ? (
          <span className="mt-[2px] flex items-center gap-1.5 text-xs" role="status">
            <AsciiSpinner size={12} />
            {busy ? "Will restart when all agents are idle" : "All agents are idle. Restarting…"}
          </span>
        ) : (
          <span className="mt-[2px] line-clamp-2 text-xs" title={headline}>
            {headline}
          </span>
        ),
      actionRow:
        mode === "waiting" ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setWaiting(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={restarting} onClick={() => void restart()}>
              {restarting && <AsciiSpinner size={12} className="mr-1" />}
              Restart now
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                openUrl(releaseNotesUrl(ready.version)).catch(() => {});
              }}
            >
              See changes
            </Button>
            {mode === "offer-idle" && (
              <Button
                variant="outline"
                size="sm"
                disabled={restarting}
                onClick={() => setWaiting(true)}
              >
                Restart when idle
              </Button>
            )}
            <Button size="sm" disabled={restarting} onClick={() => void restart()}>
              {restarting && <AsciiSpinner size={12} className="mr-1" />}
              Restart
            </Button>
          </div>
        ),
    };
  } else if (view === "downloading" && download?.phase === "downloading") {
    face = {
      tone: "accent",
      title: "Downloading update…",
      dismissLabel: "Hide. The update keeps downloading",
      onDismiss: () => setProgressHidden(true),
      message: <DownloadMeter version={download.version} progress={download.progress} />,
    };
  } else if (view === "failed" && download?.phase === "failed") {
    const failed = download;
    face = {
      tone: "danger",
      title: "Couldn't download the update",
      onDismiss: () => setDownload(null),
      message: (
        <span className="mt-[2px] block text-xs" title={failed.reason}>
          Check your internet connection, then try again.
        </span>
      ),
      actionRow: (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void fetchRelease.current(failed.info)}>
            Retry
          </Button>
        </div>
      ),
    };
  }

  // Every face is drawn by this one <LiveToast>, so moving from one to the
  // next replaces the toast in place instead of closing it and opening another.
  return (
    <>
      {view === "ready" && <AgentsBusyProbe onChange={setAgentsBusy} />}
      {face && <LiveToast id={UPDATE_TOAST_ID} durationMs={null} {...face} />}
    </>
  );
}
