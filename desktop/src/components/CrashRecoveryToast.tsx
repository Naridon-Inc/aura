// Mounts once at app start. Reads ~/.aura/aura-shell-crashes/ via the
// crashlytics Tauri commands; if any reports are newer than the
// last-acknowledged ts in localStorage, surfaces a fixed-bottom toast
// with the most recent panic message + a "View report" button that opens the
// raw JSON in a small inline drawer. Dismiss persists ack so the same
// crash doesn't pop again on the next launch.
//
// Zero network. All open-source. Pairs with `src-tauri/src/crash.rs`.

import { useEffect, useState } from "react";
import { api, type CrashSummary } from "../lib/api";
import { relativeAge } from "../lib/relativeTime";
import { ToastActionButton, ToastCard, ToastStack } from "./ui/toast";

const ACK_KEY = "aura.crashes.last_acked_ts_ms";

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

  return (
    <ToastStack>
      {reportText ? (
        <ToastCard
          tone="warning"
          title="Crash report"
          message={<span className="break-all font-mono text-xs">{reportPath}</span>}
          onDismiss={dismissAll}
          dismissTitle="Dismiss"
        >
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-line bg-bg-0 p-2 font-mono text-xs leading-[1.5] text-text-2">
            {reportText}
          </pre>
        </ToastCard>
      ) : (
        top && (
          <ToastCard
            tone="warning"
            title="Aura closed unexpectedly"
            message={
              <>
                <span className="text-text-2">{top.panic_message}</span>
                {top.location && (
                  <span className="mt-1 block font-mono text-xs text-text-4">
                    at {top.location}
                  </span>
                )}
                <span className="mt-1 block text-text-4">
                  {formatAge(top.timestamp_ms)}
                  {unacked.length > 1 && ` · ${unacked.length - 1} more`}
                </span>
              </>
            }
            onDismiss={dismissAll}
            dismissTitle="Dismiss"
            actions={
              <ToastActionButton variant="primary" onClick={() => void view(top.path)}>
                View report
              </ToastActionButton>
            }
          />
        )
      )}
    </ToastStack>
  );
}
