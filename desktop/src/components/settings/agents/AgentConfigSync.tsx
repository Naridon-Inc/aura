// Cross-machine configuration: the agents' own preference files carried
// through the Aura account, with every secret stripped before upload.

import { useEffect, useState } from "react";
import { Download, Upload } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { askConfirm } from "../../ui/ask";
import { Button } from "../../ui/button";
import { SettingsError, SettingsFacts, SettingsStatusLine } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { api, type AgentConfigSyncStatus } from "../../../lib/api";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function AgentConfigSync() {
  const [status, setStatus] = useState<AgentConfigSyncStatus | null>(null);
  const [busy, setBusy] = useState<"push" | "pull" | "status" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The status used to be read once on mount and then went stale until you
  // left and came back, so the line carries its own refresh.
  const refresh = async () => {
    setBusy("status");
    try {
      const next = await api.settingsAgentConfigsStatus();
      setStatus(next);
      setError(next.error);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const push = async () => {
    setBusy("push");
    setError(null);
    setMessage(null);
    try {
      const next = await api.settingsAgentConfigsPush();
      setStatus(next);
      setMessage(
        next.remoteFiles.length > 0
          ? `Uploaded ${plural(next.remoteFiles.length, "redacted configuration file")}.`
          : "Uploaded an empty configuration bundle; no supported local files were found.",
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const pull = async () => {
    const ok = await askConfirm({
      title: "Apply the cloud copy on this machine?",
      body: "Aura backs up every existing file beside the original before replacing it.",
      confirmLabel: "Apply",
    });
    if (!ok) return;
    setBusy("pull");
    setError(null);
    setMessage(null);
    try {
      const result = await api.settingsAgentConfigsPull();
      setStatus(result.status);
      const backups =
        result.backups.length > 0 ? ` and created ${plural(result.backups.length, "backup")}` : "";
      setMessage(`Applied ${plural(result.applied.length, "configuration file")}${backups}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const signedIn = !!status?.signedIn;
  const cloudCopy = !signedIn
    ? "Not synced"
    : status.remoteUpdatedAt
      ? `${plural(status.remoteFiles.length, "file")} · ${status.remoteSourceDevice ?? "unknown device"} · ${new Date(status.remoteUpdatedAt).toLocaleString()}`
      : "Not uploaded yet";

  return (
    <SettingsSection
      title="Cross-machine configuration"
      description={
        <>
          Carry Claude Code, Codex, and Gemini CLI preferences through your Aura account. Only{" "}
          <code>settings.json</code> and <code>config.toml</code> are eligible; API keys, tokens,
          passwords, OAuth state, and authentication files are stripped or never read.
        </>
      }
    >
      <SettingsStatusLine
        text={signedIn ? "Signed in to Aura Cloud" : "Sign in to Aura Cloud to sync"}
        onRefresh={() => void refresh()}
        refreshing={busy !== null}
      />
      <SettingsFacts
        rows={[
          {
            key: "local",
            label: "This machine",
            mono: !!status?.localFiles.length,
            value: status?.localFiles.length
              ? status.localFiles.join(" · ")
              : "No supported config files found",
          },
          { key: "remote", label: "Cloud copy", value: cloudCopy },
        ]}
      />
      {error && <SettingsError>{error}</SettingsError>}
      {message && <SettingsStatusLine text={message} />}
      <SettingsRow
        title="Upload this machine"
        description="Replace the cloud copy with this machine’s files, secrets removed."
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={!signedIn || busy !== null}
            onClick={() => void push()}
          >
            {busy === "push" ? <AsciiSpinner /> : <Upload />}
            Upload
          </Button>
        }
      />
      <SettingsRow
        title="Apply cloud copy"
        description="Write the cloud copy here. Aura backs up every file it replaces."
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={!signedIn || !status?.remoteUpdatedAt || busy !== null}
            onClick={() => void pull()}
          >
            {busy === "pull" ? <AsciiSpinner /> : <Download />}
            Apply
          </Button>
        }
      />
    </SettingsSection>
  );
}
