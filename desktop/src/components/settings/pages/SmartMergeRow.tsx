import { useCallback, useEffect, useState } from "react";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { SettingsError } from "../../ui/settings-blocks";
import { SettingsRow } from "../../ui/settings-row";
import { api } from "../../../lib/api";

// `aura merge-driver --status --json` output, parsed verbatim. Lives here
// (not api.ts) because the row reuses the generic auraCli passthrough — no
// dedicated IPC command exists or is needed.
type MergeDriverStatus = {
  installed: boolean;
  driver_line: string | null;
  attributes_patterns: string[];
  aura_on_path: boolean;
};

/** Whether git hands this repo's merges to Aura's function-level merge
 *  driver, with the one repair the app can make when the CLI is too old. */
export function SmartMergeRow({ repoRoot }: { repoRoot: string }) {
  // Semantic merge driver row — same shape as the capture row above it:
  // probe over the CLI passthrough, flip with one click, re-probe after.
  const [merge, setMerge] = useState<MergeDriverStatus | null>(null);
  const [mergeUnavailable, setMergeUnavailable] = useState<string | null>(
    null,
  );
  // What the CLI actually said when the probe failed. The row used to
  // throw this away and assert "aura CLI is too old" for every non-zero
  // exit — a guess, printed as a fact, next to a disabled button. If the
  // real reason was something else entirely (no repo, a broken install,
  // a permissions error) nothing on screen could tell you.
  const [mergeProbeDetail, setMergeProbeDetail] = useState<string | null>(null);
  // Set when the installed CLI genuinely predates this feature, which is
  // the one case the app can fix by itself.
  const [mergeCliOutdated, setMergeCliOutdated] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [updatingCli, setUpdatingCli] = useState(false);

  const refreshMerge = useCallback(async () => {
    try {
      const res = await api.auraCli(repoRoot, [
        "merge-driver",
        "--status",
        "--json",
      ]);
      if (res.status === 0) {
        setMerge(JSON.parse(res.stdout) as MergeDriverStatus);
        setMergeUnavailable(null);
        setMergeProbeDetail(null);
        setMergeCliOutdated(false);
        return;
      }
      setMerge(null);
      // A non-zero exit was being read as one thing — "too old" — because
      // that is the likeliest cause, not because anything checked. Ask the
      // question that has an answer: what version is actually installed?
      const detail = (res.stderr || res.stdout || "").trim();
      setMergeProbeDetail(detail || `aura merge-driver exited ${res.status}`);
      let outdated = false;
      try {
        outdated = (await api.auraCliVersionCheck()).status === "outdated";
      } catch {
        // The version probe is a nicety. If it fails too, the row still
        // shows the real stderr below — which is the part that matters.
      }
      setMergeCliOutdated(outdated);
      setMergeUnavailable(
        outdated
          ? "The aura command on this computer is too old for smart merge"
          : "Couldn't read the smart-merge setting",
      );
    } catch (e) {
      // Spawn failure: no `aura` on PATH at all.
      setMerge(null);
      setMergeCliOutdated(false);
      setMergeProbeDetail(e instanceof Error ? e.message : String(e));
      setMergeUnavailable("aura CLI not found");
    }
  }, [repoRoot]);

  // The one repair the app can perform itself: drop the CLI this release
  // ships with over the stale one on PATH. `interactive` authorizes the
  // macOS admin prompt when the install dir is root-owned — this is an
  // explicit click, so that is exactly right.
  async function updateCli() {
    setUpdatingCli(true);
    setMergeError(null);
    try {
      await api.auraCliInstallBundled(true);
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : String(e));
    } finally {
      await refreshMerge();
      setUpdatingCli(false);
    }
  }

  useEffect(() => {
    void refreshMerge();
  }, [refreshMerge]);

  async function setMergeInstalled(next: boolean) {
    setMergeBusy(true);
    setMergeError(null);
    try {
      const res = await api.auraCli(repoRoot, [
        "merge-driver",
        next ? "--install" : "--uninstall",
      ]);
      if (res.status !== 0) {
        setMergeError((res.stderr || res.stdout || "command failed").trim());
      }
    } catch (e) {
      setMergeError(String(e));
    } finally {
      await refreshMerge();
      setMergeBusy(false);
    }
  }

  return (
    <SettingsRow
      title="Smart merge"
      description="When two AIs edit different functions in the same file, Aura merges them cleanly. No conflicts to untangle by hand."
      help={
        mergeUnavailable ??
        (merge?.installed && !merge.aura_on_path
          ? "The driver is configured but `aura` isn't on PATH. Git falls back to its own merge until that's fixed."
          : undefined)
      }
      control={
        // A row that says "update it" and hands you a dead button is worse
        // than no button. When the CLI is the problem, the control becomes
        // the fix; when the reason is something else, the way forward is to
        // look again after changing whatever the message below names.
        mergeCliOutdated ? (
          <Button size="sm" disabled={updatingCli} onClick={() => void updateCli()}>
            {updatingCli ? <AsciiSpinner /> : "Update aura"}
          </Button>
        ) : mergeUnavailable !== null ? (
          <Button
            size="sm"
            variant="outline"
            disabled={mergeBusy}
            onClick={() => void refreshMerge()}
          >
            Try again
          </Button>
        ) : (
          <div className="ui-settings-actions">
            {merge && (
              <Badge variant={merge.installed ? "highlight" : "outline"}>
                {merge.installed ? "On" : "Off"}
              </Badge>
            )}
            <Button
              size="sm"
              variant={merge?.installed ? "outline" : "default"}
              disabled={mergeBusy || merge === null}
              onClick={() => setMergeInstalled(!(merge?.installed ?? false))}
            >
              {mergeBusy ? <AsciiSpinner /> : merge?.installed ? "Uninstall" : "Install"}
            </Button>
          </div>
        )
      }
    >
      {mergeProbeDetail && <pre className="ui-settings-log">{mergeProbeDetail}</pre>}
      {merge?.installed && merge.attributes_patterns.length > 0 && (
        <pre className="ui-settings-log">{merge.attributes_patterns.join("   ")}</pre>
      )}
      {mergeError && <SettingsError>{mergeError}</SettingsError>}
    </SettingsRow>
  );
}
