// Hooks pane — the safety net. When this is on, Aura quietly records every
// change an agent makes the moment it commits: what changed, why, and a way
// back. It's the difference between "the AI edited my project and I have to
// trust it" and "I can see exactly what happened and undo any of it." One
// switch, plain words — no talk of git hooks unless you ask.

import { useState } from "react";
import { ShieldCheck } from "lucide-react";

import { api, type CaptureStatus } from "../../../lib/api";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { SettingsError } from "../../ui/settings-blocks";
import { SettingsRow } from "../../ui/settings-row";
import { SettingsServiceTitle } from "../../ui/settings-services-row";
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
      {/* "every change … always … undo it" was three absolutes over a git
          hook. `aura enable` installs pre-commit, post-commit and pre-push
          (aura-cli/src/hook.rs:98,127,164) — it fires when you commit and at
          no other time. Work sitting uncommitted on your disk is outside it,
          which is the whole span of time a person is most worried about. The
          header comment at the top of this file has always said "the moment it
          commits"; the words on screen dropped the qualifier, which is how the
          feature ended up promising more than the mechanism can do. */}
      <PaneIntro
        title="Safety net"
        blurb="When you commit, Aura records what your agents changed and why, and keeps a way back to it. We recommend leaving this on."
      />

      {loading && !capture ? (
        <PaneSpinner label="Checking safety status…" />
      ) : !capture?.is_git ? (
        <EmptyHint
          icon={ShieldCheck}
          title="Open a repository first"
          body="The safety net attaches to a repository's history. Open a folder that's under version control and the switch turns on here."
        />
      ) : (
        <Card>
          <SettingsRow
            title={
              <SettingsServiceTitle
                mark={
                  // The library's 16px mark square, toned by the state.
                  <span
                    className="ui-settings-service-mark ui-customize-mark"
                    data-tone={
                      capture.unreadable ? "attention" : capture.enabled ? "on" : undefined
                    }
                    aria-hidden
                  >
                    <ShieldCheck />
                  </span>
                }
              >
                {/* Off and can't-tell are different answers. Telling someone
                    their safety net is off when it is very likely on is the
                    worse of the two mistakes to make. */}
                {capture.unreadable
                  ? "Aura can't check this repository"
                  : capture.enabled
                    ? "Safety net is on"
                    : "Safety net is off"}
              </SettingsServiceTitle>
            }
            description={
              capture.unreadable
                ? capture.unreadable
                : capture.enabled
                  ? "Every commit is recorded with its reason, and can be undone."
                  : "Commits aren't being recorded. Turn this on and Aura starts at your next one."
            }
            help={error ? <SettingsError>{error}</SettingsError> : undefined}
            control={
              busy ? (
                <AsciiSpinner />
              ) : (
                <Switch
                  checked={capture.enabled}
                  disabled={capture.unreadable !== null}
                  onCheckedChange={toggle}
                  aria-label={
                    capture.enabled ? "Turn the safety net off" : "Turn the safety net on"
                  }
                />
              )
            }
          />
        </Card>
      )}
    </PaneScroll>
  );
}
