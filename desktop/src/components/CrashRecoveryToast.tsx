// Mounts once at app start. Reads ~/.aura/aura-shell-crashes/ via the
// crashlytics Tauri commands; if any reports are newer than the
// last-acknowledged ts in localStorage, raises a toast in the shared stack
// with the most recent panic message + a "View report" button that turns it
// into the raw JSON. Closing it persists ack so the same crash doesn't pop
// again on the next launch.
//
// Zero network. All open-source. Pairs with `src-tauri/src/crash.rs`.

import { useEffect, useState } from "react";
import { api, type CrashSummary } from "../lib/api";
import { relativeAge } from "../lib/relativeTime";
import { LiveToast } from "./LiveToast";

const ACK_KEY = "aura.crashes.last_acked_ts_ms";
const TOAST_ID = "crash-recovery";

function readAckedTs(): number {
  const raw = localStorage.getItem(ACK_KEY);
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

function setAckedTs(ts: number) {
  localStorage.setItem(ACK_KEY, String(ts));
}

function formatAge(ts: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAge(ts);
}

// Two different things land in this directory and they are not the same news.
// A panic means the shell came apart. A reclaim means macOS took the window's
// renderer for its memory while the shell kept running and the page reloaded
// itself — nothing closed, and saying it did sends whoever reads it looking
// for a bug that is not there. See src-tauri/src/renderer_recovery.rs.
function headline(kind: string): string {
  return kind === "renderer_reclaimed"
    ? "The window was restored"
    : "Aura closed unexpectedly";
}

export function CrashRecoveryToast() {
  const [unacked, setUnacked] = useState<CrashSummary[]>([]);
  const [reportText, setReportText] = useState<string | null>(null);
  const [reportPath, setReportPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.auraCrashReportsList();
        if (cancelled) return;
        const acked = readAckedTs();
        const fresh = list.filter((c) => c.timestamp_ms > acked);
        setUnacked(fresh);
      } catch {
        /* ignore — best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (unacked.length === 0 && !reportText) return null;

  const top = unacked[0];

  const dismissAll = () => {
    if (unacked.length > 0) {
      const newest = Math.max(...unacked.map((c) => c.timestamp_ms));
      setAckedTs(newest);
    }
    setUnacked([]);
    setReportText(null);
    setReportPath(null);
  };

  const view = async (path: string) => {
    try {
      const text = await api.auraCrashReportRead(path);
      setReportPath(path);
      setReportText(text);
    } catch (e) {
      setReportPath(path);
      setReportText(
        `Aura couldn't open this report. The file is at ${path}. You can open it in any text editor.\n\n${String(e)}`,
      );
    }
  };

  // Both shapes share one id, so opening the report turns the toast into it
  // in place instead of stacking a second one.
  return reportText ? (
    <LiveToast
      id={TOAST_ID}
      tone="warning"
      title="Crash report"
      durationMs={null}
      message={
        <>
          <span className="block break-all font-mono text-xs">{reportPath}</span>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-[4px] border border-[var(--aura-toast-border)] p-2 font-mono text-xs leading-[1.5] text-[var(--aura-toast-text)]">
            {reportText}
          </pre>
        </>
      }
      dismissLabel="Dismiss"
      onDismiss={dismissAll}
    />
  ) : top ? (
    <LiveToast
      id={TOAST_ID}
      tone="warning"
      title={headline(top.kind)}
      durationMs={null}
      message={
        <>
          <span className="text-[var(--aura-toast-text)]">{top.panic_message}</span>
          {top.location && (
            <span className="mt-1 block font-mono text-xs">at {top.location}</span>
          )}
          <span className="mt-1 block">
            {formatAge(top.timestamp_ms)}
            {unacked.length > 1 && ` · ${unacked.length - 1} more`}
          </span>
        </>
      }
      dismissLabel="Dismiss"
      onDismiss={dismissAll}
      actions={[
        { label: "View report", variant: "primary", keepOpen: true, onClick: () => view(top.path) },
      ]}
    />
  ) : null;
}
