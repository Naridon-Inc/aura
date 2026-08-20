// "Update available" banner — checks GitHub releases on mount via the
// updater plugin, renders a small strip when a new version exists, and
// streams a download progress fill on click. Never blocks anything;
// dismiss is session-scoped (we'll re-check after 6h on next boot).
//
// The flow is three-stage so the user is never yanked into a relaunch:
//   1. Detected     → "Aura vX is available [Download]"
//   2. Downloading  → "Aura vX downloading… NN% [in flight]"
//   3. Staged       → "Aura vX ready to install [Restart now]"
// Only the explicit "Restart now" click triggers the relaunch.
//
// The banner sits inside Layout's body slot above WorkSurface so it
// shares the rounded panel chrome with the impacts banner. Both are
// stacked when both fire, with a 1px divider — no flicker on either.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import {
  checkForUpdate,
  downloadUpdate,
  openManualDownload,
  restartIntoUpdate,
  UpdateRequiresManualInstall,
  type UpdateInfo,
} from "../lib/updater";
import { toast } from "../lib/toast";
import { AsciiSpinner } from "./ui/ascii-spinner";
import { percent } from "../lib/percent";

type Stage = "idle" | "downloading" | "staged";

// The strip's one primary affordance. Same shape whichever stage it's in, so
// the button doesn't change colour under the user's cursor mid-update.
const UPDATE_ACTION_BTN =
  "text-xs px-2.5 h-[22px] rounded bg-accent text-bg-0 font-medium " +
  "hover:opacity-90 disabled:opacity-50 transition-opacity " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// A manual "Check for Updates…" (native menu) needs a visible answer even
// when there's no update — otherwise the menu click looks like it did
// nothing. This transient strip covers the not-an-update outcomes; when an
// update *is* found, the normal banner below takes over instead.
type ManualState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate"; version: string }
  | { kind: "error"; message: string };

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState<{ done: number; total: number | null }>(
    { done: 0, total: null },
  );
  const [error, setError] = useState<string | null>(null);
  const [manualVersion, setManualVersion] = useState<string | null>(null);
  const [manual, setManual] = useState<ManualState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled) return;
      checkForUpdate(false).then((r) => {
        if (!cancelled) setInfo(r);
      });
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);

  // Native menu → forced check. The Aura menu's "Check for Updates…" emits
  // `menu:check_for_updates`; run a forced probe and surface the outcome.
  useEffect(() => {
    let cancelled = false;
    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    const un = listen("menu:check_for_updates", async () => {
      if (cancelled) return;
      if (clearTimer) clearTimeout(clearTimer);
      setManual({ kind: "checking" });
      try {
        const r = await checkForUpdate(true);
        if (cancelled) return;
        if (r) {
          // An update exists — hand off to the banner and make sure a prior
          // dismiss doesn't hide it.
          setInfo(r);
          setDismissed(false);
          setManual({ kind: "idle" });
        } else {
          let v = "";
          try {
            v = await getVersion();
          } catch {
            /* best-effort version label */
          }
          if (cancelled) return;
          setManual({ kind: "uptodate", version: v });
          clearTimer = setTimeout(() => setManual({ kind: "idle" }), 5000);
        }
      } catch (e: unknown) {
        if (cancelled) return;
        setManual({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
        clearTimer = setTimeout(() => setManual({ kind: "idle" }), 7000);
      }
    });
    return () => {
      cancelled = true;
      if (clearTimer) clearTimeout(clearTimer);
      un.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // The transient manual-check strip renders when there's no update banner to
  // show (checking / up-to-date / couldn't-check). When an update is found the
  // full banner below wins.
  if (!info || dismissed) {
    if (manual.kind === "idle") return null;
    const checking = manual.kind === "checking";
    const failed = manual.kind === "error";
    return (
      <div
        className="flex items-center gap-3 text-sm px-3 h-[28px] border-b border-line-soft"
        style={{
          // A failed check is the only one of the three that needs the reader
          // to do something, so it's the only one that gets ink. "Checking" and
          // "you're up to date" are just reports — they read on the neutral ramp.
          background: failed
            ? "color-mix(in srgb, var(--color-red) 7%, transparent)"
            : "transparent",
        }}
        role={failed ? "alert" : "status"}
      >
        {checking ? (
          <AsciiSpinner className="text-sm leading-none" />
        ) : (
          <span className={failed ? "text-red" : "text-accent-green"}>
            {failed ? "!" : "✓"}
          </span>
        )}
        <div className="flex-1 min-w-0 truncate text-text-2">
          {checking
            ? "Checking for updates…"
            : manual.kind === "uptodate"
              ? `You're on the latest version${manual.version ? ` (${manual.version})` : ""}.`
              : `Aura couldn't check for updates. ${manual.message}. Check your internet connection and try again from the Aura menu.`}
        </div>
        {!checking && (
          <button
            type="button"
            onClick={() => setManual({ kind: "idle" })}
            className="text-xs text-text-3 hover:text-text-1 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
            aria-label="Dismiss"
          >
            ×
          </button>
        )}
      </div>
    );
  }

  const pct =
    progress.total != null && progress.total > 0
      ? percent(progress.done, progress.total)
      : null;

  const onDownload = async () => {
    if (stage !== "idle") return;
    setStage("downloading");
    setError(null);
    setManualVersion(null);
    try {
      await downloadUpdate(info, (done, total) => setProgress({ done, total }));
      setStage("staged");
    } catch (e: unknown) {
      setStage("idle");
      if (e instanceof UpdateRequiresManualInstall) {
        setManualVersion(e.version);
        setError(e.message);
        // Auto-install can't work from this location (a read-only mounted DMG,
        // or /Applications on a separate volume). Surface a clear, actionable
        // toast in addition to the inline banner — the banner is thin and easy
        // to miss at the moment an update actually fails. (Issue #7.)
        toast.show({
          id: "update-manual-install",
          tone: "warning",
          title: `Install Aura ${e.version} to keep it updated`,
          message:
            "Aura can’t update itself from its current location. Drag Aura " +
            "into your Applications folder and open it from there, then " +
            "updates install on their own.",
          durationMs: null,
          actions: [
            {
              label: `Download ${e.version}`,
              variant: "primary",
              onClick: () => openManualDownload(e.version),
            },
          ],
        });
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const onRestart = async () => {
    if (stage !== "staged") return;
    try {
      await restartIntoUpdate();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onManualDownload = async () => {
    if (!manualVersion) return;
    try {
      await openManualDownload(manualVersion);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  let label: string;
  if (stage === "staged") {
    label = "ready to install";
  } else if (stage === "downloading") {
    label = pct != null ? `downloading… ${pct}%` : "downloading…";
  } else {
    label = "is available";
  }

  return (
    // One ink on this strip: the accent, on the single button that's asking to
    // be pressed. "Ready to install" is a state, so it reads as the status
    // green; a failed download reads red. Nothing else is tinted.
    <div
      className="flex items-center gap-3 text-sm px-3 h-[28px] border-b border-line-soft"
      style={{
        background:
          stage === "staged"
            ? "color-mix(in srgb, var(--color-accent-green) 8%, transparent)"
            : "transparent",
      }}
      role="status"
    >
      {stage === "downloading" ? (
        <AsciiSpinner className="text-sm leading-none" />
      ) : (
        <span className={stage === "staged" ? "text-accent-green" : "text-text-3"}>
          {stage === "staged" ? "●" : "↑"}
        </span>
      )}
      <div className="flex-1 min-w-0 truncate">
        <span className="text-text-1 font-medium">Aura {info.version}</span>{" "}
        <span className="text-text-3">{label}</span>
        {error && (
          <span className="ml-2 text-red text-xs">· {error}</span>
        )}
      </div>
      {manualVersion ? (
        <button
          type="button"
          onClick={onManualDownload}
          className={UPDATE_ACTION_BTN}
        >
          Download {manualVersion}
        </button>
      ) : stage === "staged" ? (
        <button type="button" onClick={onRestart} className={UPDATE_ACTION_BTN}>
          Restart now
        </button>
      ) : (
        <button
          type="button"
          onClick={onDownload}
          disabled={stage === "downloading"}
          className={UPDATE_ACTION_BTN}
        >
          {stage === "downloading" ? "Downloading…" : "Download"}
        </button>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        disabled={stage === "downloading"}
        className="text-xs text-text-3 hover:text-text-1 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
        aria-label="Dismiss until next launch"
      >
        ×
      </button>
    </div>
  );
}
