// Hooks pane — the safety net. When this is on, Aura quietly records every
// change an agent makes the moment it commits: what changed, why, and a way
// back. It's the difference between "the AI edited my project and I have to
// trust it" and "I can see exactly what happened and undo any of it." One
// switch, plain words — no talk of git hooks unless you ask.

import { useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";

import { api, type CaptureStatus } from "../../../lib/api";
import { Switch } from "../../ui/switch";
import { Card, EmptyHint, PaneIntro, PaneScroll, PaneSpinner } from "./customizeShared";

export function HooksPane({
  repoRoot,
  capture,
  loading,
  refresh,
}: {
  repoRoot: string;
  capture: CaptureStatus | null;
  loading: boolean;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (!capture || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (capture.enabled) await api.captureDisable(repoRoot);
      else await api.captureEnable(repoRoot);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <PaneScroll>
      <PaneIntro
        title="Safety net"
        blurb="Keep a recoverable record of every change your agents make, so you can always see what happened and undo it. We recommend leaving this on."
      />

      {loading && !capture ? (
        <PaneSpinner label="Checking safety status…" />
      ) : !capture?.is_git ? (
        <EmptyHint
          icon={<ShieldCheck size={22} />}
          title="Open a project first"
          body="The safety net attaches to a project's history. Open a folder that's under version control and the switch turns on here."
        />
      ) : (
        <Card className="p-3">
          <div className="flex items-center gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{
                background: capture.enabled
                  ? "color-mix(in srgb, var(--color-accent) 16%, transparent)"
                  : "var(--color-bg-2)",
                color: capture.enabled
                  ? "var(--color-accent)"
                  : "var(--color-text-4)",
              }}
            >
              <ShieldCheck size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-text-1">
                {capture.enabled ? "Safety net is on" : "Safety net is off"}
              </div>
              <div className="text-[11.5px] text-text-4">
                {capture.enabled
                  ? "Every change is recorded with its reason — nothing is lost."
                  : "Changes won't be recorded. Turn this on to stay protected."}
              </div>
            </div>
            {busy ? (
              <Loader2 size={16} className="shrink-0 animate-spin text-text-4" />
            ) : (
              <Switch
                checked={capture.enabled}
                onCheckedChange={toggle}
                aria-label={
                  capture.enabled ? "Turn the safety net off" : "Turn the safety net on"
                }
              />
            )}
          </div>
          {error ? (
            <div className="mt-3 rounded-md bg-bg-2 px-3 py-2 text-[11.5px] text-red">
              {error}
            </div>
          ) : null}
        </Card>
      )}
    </PaneScroll>
  );
}
