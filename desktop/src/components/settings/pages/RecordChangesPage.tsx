import { useCallback, useEffect, useState } from "react";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  SettingsEmpty,
  SettingsError,
  SettingsFacts,
  SettingsIntro,
  SettingsStatusLine,
} from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { api, type CaptureStatus } from "../../../lib/api";
import { setCaptureOptOut } from "../../../lib/autoCapture";
import { SmartMergeRow } from "./SmartMergeRow";

// ── Capture (no-MCP drop-in) ──────────────────────────────────────────
//
// Passive semantic capture is on for a workspace exactly when Aura's git
// hooks are installed in it — distinct from the global ~/.aura blockstore
// that `auraStatus` reports. This pane is the desktop face of the
// frictionless `aura enable` story (the VS Code extension has the same gate,
// the CLI has the bare command): it shows whether THIS repo is capturing and
// flips it with one click, no MCP server and no wizard. Enable/disable run
// `aura enable` / `aura disable` through the CLI passthrough so the hook
// install logic lives in one place; we re-probe `captureStatus` afterward.
export function RecordChangesPage({ repoRoot }: { repoRoot: string }) {
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.captureStatus(repoRoot));
    } catch (e) {
      setError(String(e));
    }
  }, [repoRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = next
        ? await api.captureEnable(repoRoot)
        : await api.captureDisable(repoRoot);
      if (res.status !== 0) {
        setError((res.stderr || res.stdout || "command failed").trim());
      } else {
        // Remember an explicit choice so the auto-on path (autoCapture.ts)
        // never re-enables a repo the user deliberately turned off — and a
        // manual re-enable clears that marker.
        setCaptureOptOut(repoRoot, !next);
        const summary = (res.stdout || "").trim();
        setNote(
          summary.length > 0
            ? summary.split("\n").slice(-2).join(" ").slice(0, 200)
            : next
              ? "Capture enabled."
              : "Capture disabled.",
        );
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const on = status?.enabled ?? false;
  const isGit = status?.is_git ?? false;
  // Aura could not read the hook, so it does not know. Saying "Not
  // capturing" here is a guess printed as a fact, next to a button that is
  // about to fail for the same reason.
  const cantTell = status?.unreadable ?? null;

  return (
    <>
      <SettingsIntro>Quietly record what changed and why in this repository. No extra setup.</SettingsIntro>

      {status && !isGit && (
        <SettingsEmpty>
          This folder isn't a Git repository, so there's nothing to capture
          into yet. Initialize Git first, then enable capture here.
        </SettingsEmpty>
      )}

      {isGit && (
        <>
          <SettingsRow
            title="Record changes"
            description={
              cantTell
                ? cantTell
                : on
                  ? "Every time you save (commit), Aura records what changed, why, and which AI made it. Right inside your repository's history."
                  : "Turn on to record what changed and why on every save. It runs quietly alongside any existing Git hooks (Husky, Lefthook) without disturbing them."
            }
            help={status?.hooks_dir ? `Hooks: ${status.hooks_dir}` : undefined}
            control={
              <div className="ui-settings-actions">
                <Badge variant={cantTell ? "tip" : on ? "highlight" : "outline"}>
                  {cantTell ? "Can't tell" : on ? "Capturing" : "Not capturing"}
                </Badge>
                <Button
                  size="sm"
                  variant={on ? "outline" : "default"}
                  disabled={busy || cantTell !== null}
                  onClick={() => toggle(!on)}
                >
                  {busy ? <AsciiSpinner /> : on ? "Disable" : "Enable capture"}
                </Button>
              </div>
            }
          />
          {note && <SettingsStatusLine text={note} />}
          {error && <SettingsError>{error}</SettingsError>}
          <SmartMergeRow repoRoot={repoRoot} />
        </>
      )}

      <SettingsSection
        title="What this does"
        description={
          <>
            Want the full interactive setup — API keys, baseline scan, MCP
            wiring? Run <code>aura init</code> in this repo from a terminal.
          </>
        }
      >
        <SettingsFacts
          rows={[
            {
              key: "hooks",
              label: "Hooks",
              value: "pre-commit, commit-msg, post-commit, post-merge, pre-push. Safe to run more than once; existing hooks stay in place.",
            },
            {
              key: "where",
              label: "Where it goes",
              value: "Straight into Git. Nothing leaves your machine. No cloud, no extra server.",
            },
            {
              key: "off",
              label: "Turning it off",
              value: "Removes the hooks. The history already recorded in Git stays put. Works with any coding agent, or none.",
            },
          ]}
        />
      </SettingsSection>
    </>
  );
}
