// One configured connection, as a settings row: its name and state on the
// left, the one sign-in action it needs (if any), its on/off switch and a
// menu on the right.

import { MoreHorizontal } from "lucide-react";
import type { McpServerEntry, McpServerToolList } from "../../../lib/api";
import { Badge, type BadgeProps } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { SettingsActions } from "../../ui/settings-blocks";
import { SettingsMcpTitle } from "../../ui/settings-mcp-parts";
import { SettingsRow } from "../../ui/settings-row";
import { Switch } from "../../ui/switch";

export function McpServerRow({
  row,
  toolList,
  onToggle,
  onRemove,
  onAuth,
  disabled,
}: {
  row: McpServerEntry;
  toolList: McpServerToolList | undefined;
  onToggle: (next: boolean) => void;
  onRemove: () => void;
  onAuth: () => void;
  disabled: boolean;
}) {
  const probeOk = toolList?.ok ?? null;
  const probeErr = toolList?.ok === false ? toolList.error : null;
  const probeCount = toolList?.tools.length ?? null;

  // Inline native-OAuth actions. We only surface these when we KNOW the
  // user can act — `server_url` set means the backend will run native
  // OAuth on click; otherwise the generic Auth button stays the only
  // entry point. "Authenticate" for first-time auth, escalating to
  // "Re-authenticate" once the tools probe spits a 401/expired signal so
  // the row reads as actionable, not just broken.
  const hasRemote = Boolean(row.server_url);
  const needsAuth = hasRemote && !row.has_oauth_token;
  const errBlob = `${row.status ?? ""} ${probeErr ?? ""}`.toLowerCase();
  const tokensRejected =
    hasRemote &&
    row.has_oauth_token &&
    (errBlob.includes("401") ||
      errBlob.includes("unauthor") ||
      errBlob.includes("expired"));
  // A remote server you haven't signed into answers every probe with a
  // 401. Nothing is broken and nothing needs fixing: that is exactly the
  // state the Authenticate button next to it exists for. Any OTHER probe
  // failure (bad host, 500, timeout) still gets said out loud.
  const authRefused =
    errBlob.includes("401") ||
    errBlob.includes("unauthor") ||
    errBlob.includes("invalid_token");
  const awaitingAuth = needsAuth && (probeOk !== false || authRefused);

  const statusLabel = !row.enabled
    ? "disabled"
    : awaitingAuth
      ? "not signed in"
      : probeOk === true
        ? `${probeCount ?? 0} tools`
        : probeOk === false
          ? "error"
          : "unknown";
  // "tip" is the app's waiting-on-you tone; it is not the error tone.
  const statusVariant: BadgeProps["variant"] = !row.enabled
    ? "outline"
    : awaitingAuth
      ? "tip"
      : probeOk === true
        ? "highlight"
        : probeOk === false
          ? "destructive"
          : "secondary";

  // ONE auth action per row — label and tone derived from state.
  // Plugin-bundled servers authenticate through the Plugins page, so
  // there is nothing to set up here.
  const auth = row.plugin_id
    ? null
    : needsAuth
      ? { label: "Authenticate", title: "A browser window will open for authentication", urgent: false }
      : tokensRejected
        ? { label: "Re-authenticate", title: "Tokens rejected. Refresh required", urgent: true }
        : probeOk === false || (!hasRemote && !row.has_oauth_token)
          ? { label: "Auth", title: "Set up auth. Env or browser flow", urgent: probeOk === false }
          : null;

  const command = `${row.command} ${row.args.join(" ")}`.trim();

  return (
    <SettingsRow
      title={
        <SettingsMcpTitle name={row.name}>
          <Badge variant={statusVariant}>{statusLabel}</Badge>
          {row.plugin_id && (
            <Badge
              variant="outline"
              title="Bundled by a plugin. Env + secrets are managed in the Plugins page"
            >
              plugin
            </Badge>
          )}
          {row.server_url && (
            <Badge variant="outline" title={`Remote transport. Uses HTTP/SSE to ${row.server_url}`}>
              remote
            </Badge>
          )}
          {row.has_oauth_token && (
            <Badge variant="highlight" title="OAuth tokens stored in OS keychain">
              authenticated
            </Badge>
          )}
        </SettingsMcpTitle>
      }
      description={row.description ?? undefined}
      help={
        <>
          <code>{command || row.server_url}</code>
          {probeErr && !awaitingAuth && (
            <div className="ui-settings-error" title={probeErr}>
              {probeErr}
            </div>
          )}
          {awaitingAuth && (
            <div>
              Authenticate and Aura will keep the tokens for you. Its tools stay out of the
              composer until you do.
            </div>
          )}
        </>
      }
      control={
        <SettingsActions>
          {auth && (
            <Button
              size="sm"
              variant={auth.urgent ? "accentSoft" : "outline"}
              onClick={onAuth}
              disabled={disabled}
              title={auth.title}
            >
              {auth.label}
            </Button>
          )}
          <Switch
            aria-label={`Enable ${row.name}`}
            checked={row.enabled}
            onCheckedChange={onToggle}
            disabled={disabled}
          />
          {!row.plugin_id && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="iconSm"
                  aria-label={`More for ${row.name}`}
                  disabled={disabled}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onAuth}>Set up auth</DropdownMenuItem>
                <DropdownMenuItem onSelect={onRemove}>Remove server</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </SettingsActions>
      }
    />
  );
}
