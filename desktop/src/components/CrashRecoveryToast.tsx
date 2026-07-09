// Mounts once at app start. Reads ~/.aura/aura-shell-crashes/ via the
// crashlytics Tauri commands; if any reports are newer than the
// last-acknowledged ts in localStorage, surfaces a fixed-bottom toast
// with the most recent panic message + a "View" button that opens the
// raw JSON in a small inline drawer. Dismiss persists ack so the same
// crash doesn't pop again on the next launch.
//
// Zero network. All open-source. Pairs with `src-tauri/src/crash.rs`.

import { useEffect, useState } from "react";
import { api, type CrashSummary } from "../lib/api";

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
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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
      setReportText(`Failed to read crash report: ${String(e)}`);
      setReportPath(path);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 9999,
        maxWidth: 480,
        background: "#1a1a1a",
        border: "1px solid #d97706",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        color: "#e5e7eb",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
      }}
    >
      {top && !reportText && (
        <div style={{ padding: "12px 14px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <span style={{ color: "#fbbf24", fontWeight: 600 }}>
              ⚠ Aura crashed
            </span>
            <span style={{ color: "#9ca3af" }}>
              {formatAge(top.timestamp_ms)}
            </span>
            {unacked.length > 1 && (
              <span style={{ color: "#9ca3af" }}>
                (+{unacked.length - 1} more)
              </span>
            )}
          </div>
          <div
            style={{
              color: "#f3f4f6",
              marginBottom: 6,
              wordBreak: "break-word",
            }}
          >
            {top.panic_message}
          </div>
          {top.location && (
            <div style={{ color: "#9ca3af", marginBottom: 10 }}>
              at {top.location}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => void view(top.path)}
              style={{
                background: "#374151",
                color: "#e5e7eb",
                border: "1px solid #4b5563",
                borderRadius: 4,
                padding: "4px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
              }}
            >
              View report
            </button>
            <button
              type="button"
              onClick={dismissAll}
              style={{
                background: "transparent",
                color: "#9ca3af",
                border: "1px solid #4b5563",
                borderRadius: 4,
                padding: "4px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {reportText && (
        <div style={{ padding: "12px 14px", maxWidth: 480 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <span style={{ color: "#fbbf24", fontWeight: 600 }}>
              Crash report
            </span>
            <span
              style={{
                color: "#6b7280",
                fontSize: 10,
                wordBreak: "break-all",
              }}
            >
              {reportPath}
            </span>
          </div>
          <pre
            style={{
              background: "#0f0f0f",
              color: "#d1d5db",
              border: "1px solid #2a2a2a",
              borderRadius: 4,
              padding: 8,
              maxHeight: 320,
              overflow: "auto",
              fontSize: 11,
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {reportText}
          </pre>
          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              marginTop: 10,
            }}
          >
            <button
              type="button"
              onClick={dismissAll}
              style={{
                background: "#374151",
                color: "#e5e7eb",
                border: "1px solid #4b5563",
                borderRadius: 4,
                padding: "4px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
              }}
            >
              Dismiss all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
