// Sign a server in. For known providers (Atlassian, Linear, GitHub, Sentry)
// it asks for each key by name, with a hint and a link to the provider's
// token page. For a server with a remote URL it runs the browser sign-in.
// For anything else it falls back to a free-form KEY=value block so nobody
// is blocked.

import { useMemo, useState } from "react";
import { ExternalLink, Eye, EyeOff } from "lucide-react";
import type { McpServerEntry } from "../../../lib/api";
import { api } from "../../../lib/api";
import { Alert, AlertDescription } from "../../ui/alert";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { detectRemote, matchTemplate, parseEnvBlock } from "./mcpTemplates";
import { useMcpAuthFlows } from "./useMcpAuthFlows";

export function McpAuthDialog({
  server,
  onClose,
  onSaved,
}: {
  server: McpServerEntry;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const template = useMemo(
    () => matchTemplate(server.name, server.args),
    [server.name, server.args],
  );
  // For known templates we render one field per envKey. We never seed the
  // input with the existing secret value; an empty submission leaves prior
  // values intact (the backend merges).
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const k of template?.envKeys ?? []) init[k] = "";
    // Non-secret fields (email, domain, org) come back from the config so
    // nobody has to type them twice. Secrets stay blank.
    for (const k of template?.envKeys ?? []) {
      if (template?.envSecret?.[k]) continue;
      if (server.env[k]) init[k] = server.env[k];
    }
    return init;
  });
  // Reveal only ever shows what was typed into this dialog.
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [freeform, setFreeform] = useState<string>(() => {
    if (template) return "";
    return Object.entries(server.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remote = useMemo(() => detectRemote(server), [server]);
  const flows = useMcpAuthFlows(server.name, onSaved, setError);

  // Pick ONE flow. Native OAuth is the primary path when we have a remote
  // URL; the mcp-remote piggyback covers configs that wrap a URL; env paste
  // is only for stdio servers that take an API token.
  const useNative = !!server.server_url;
  const remoteFlow = useNative || remote.kind !== "none";
  const flowBusy = useNative ? flows.nativeBusy : flows.authBusy;
  const flowResult = useNative ? flows.nativeResult : flows.authResult;
  const runFlow = useNative ? flows.runNativeOAuth : flows.runBrowserAuth;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const env: Record<string, string> = template ? { ...values } : parseEnvBlock(freeform);
      // Drop empty strings — the backend treats them as "clear this key",
      // which would wipe values the user didn't mean to touch.
      for (const k of Object.keys(env)) {
        if (env[k] === "") delete env[k];
      }
      if (Object.keys(env).length === 0 && template) {
        setError("Paste at least one value, or close the dialog");
        setBusy(false);
        return;
      }
      await api.mcpServersUpdateEnv(server.name, env);
      await onSaved();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const openTokenPage = async () => {
    if (!template?.tokenPageUrl) return;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(template.tokenPageUrl);
    } catch (e) {
      console.warn("openUrl failed:", e);
      window.open(template.tokenPageUrl, "_blank", "noopener");
    }
  };

  const envForm = !remoteFlow && template && template.envKeys.length > 0;
  const freeformForm = !remoteFlow && !template;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="ui-environment-dialog">
        <DialogTitle>{server.name}</DialogTitle>
        <DialogDescription>
          <code>{server.server_url ?? `${server.command} ${server.args.join(" ")}`}</code>
        </DialogDescription>

        {remoteFlow && (
          <>
            <Button onClick={() => void runFlow()} disabled={flowBusy}>
              {flowBusy ? <AsciiSpinner /> : <ExternalLink aria-hidden />}
              {flowBusy
                ? `Authenticating with ${server.name}…`
                : server.has_oauth_token
                  ? "Re-authenticate"
                  : "Authenticate"}
            </Button>
            <p className="ui-settings-help">
              {flowBusy
                ? "A browser window will open for authentication. Return here after authenticating in your browser."
                : "Clicking Authenticate opens a browser window. Approve the request and Aura will store the tokens in your OS keychain."}
            </p>
            {server.has_oauth_token && !flowBusy && (
              <Button
                variant="outlineDestructive"
                size="sm"
                onClick={() => void flows.clearOAuthTokens()}
                title="Delete stored tokens from the OS keychain"
              >
                Disconnect
              </Button>
            )}
            {flows.authLog.length > 0 && flowBusy && (
              <pre className="ui-settings-log">{flows.authLog.slice(-30).join("\n")}</pre>
            )}
            {flowResult && (
              <Alert variant={flowResult.ok ? "default" : "destructive"}>
                <AlertDescription>{flowResult.text}</AlertDescription>
              </Alert>
            )}
          </>
        )}

        {envForm && (
          <>
            <p className="ui-settings-help">{template.description}</p>
            {template.tokenPageUrl && (
              <Button variant="link" size="sm" onClick={() => void openTokenPage()}>
                <ExternalLink aria-hidden />
                Open token page
              </Button>
            )}
            {template.envKeys.map((k) => {
              const isSecret = !!template.envSecret?.[k];
              const isRevealed = !!reveal[k];
              return (
                <label key={k} className="ui-form-field">
                  {k}
                  <Input
                    type={isSecret && !isRevealed ? "password" : "text"}
                    value={values[k] ?? ""}
                    onChange={(e) => setValues((prev) => ({ ...prev, [k]: e.target.value }))}
                    placeholder={isSecret && server.env[k] ? "(saved. Leave blank to keep)" : ""}
                    autoComplete="off"
                    spellCheck={false}
                    suffix={
                      isSecret ? (
                        <Button
                          variant="ghost"
                          size="iconXs"
                          aria-label={isRevealed ? `Hide ${k}` : `Show ${k}`}
                          onClick={() => setReveal((prev) => ({ ...prev, [k]: !prev[k] }))}
                        >
                          {isRevealed ? <EyeOff /> : <Eye />}
                        </Button>
                      ) : undefined
                    }
                  />
                  {template.envHints?.[k] && (
                    <span className="ui-settings-help">{template.envHints[k]}</span>
                  )}
                </label>
              );
            })}
          </>
        )}

        {freeformForm && (
          <label className="ui-form-field">
            Environment
            <Textarea
              value={freeform}
              onChange={(e) => setFreeform(e.target.value)}
              rows={6}
              spellCheck={false}
              placeholder="ATLASSIAN_API_TOKEN=…"
            />
            <span className="ui-settings-help">
              This server isn&apos;t a known template. Paste any env vars it needs as KEY=value,
              one per line. Values are stored as-is at ~/.aura/mcp/&lt;name&gt;.json.
            </span>
          </label>
        )}

        {error && (
          <p role="alert" className="ui-field-error">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {remoteFlow ? "Close" : "Cancel"}
          </Button>
          {(envForm || freeformForm) && (
            <Button onClick={() => void submit()} disabled={busy}>
              {busy && <AsciiSpinner />}
              Save & retry
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
