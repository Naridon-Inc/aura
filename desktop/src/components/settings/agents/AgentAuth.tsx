// The Authentication block on the Claude Code and Codex tabs. The method
// cards choose which login command the button runs; the line under them is
// what the agent's own CLI says about its account right now.

import { useState } from "react";
import { LogOut } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { SettingsError, SettingsStatusLine } from "../../ui/settings-blocks";
import {
  AgentApiKeyField,
  AgentAuthSection,
  AgentLoginButton,
  type AgentAuthMethod,
} from "../../ui/settings-agent-providers";
import { claudeMethod, claudeStatusLine, codexMethod, codexStatusLine } from "./agentModel";
import type { ClaudeAuth, CodexAuth } from "./useAgentAuth";

const CLAUDE_METHODS: AgentAuthMethod[] = [
  { id: "cli", label: "CLI", icon: "cli" },
  { id: "key", label: "API key", icon: "key" },
];

const CODEX_METHODS: AgentAuthMethod[] = [
  { id: "chatgpt", label: "ChatGPT", icon: "chatgpt", recommended: true },
  { id: "key", label: "API key", icon: "key" },
];

export function ClaudeAuthPanel({ auth }: { auth: ClaudeAuth }) {
  const [choice, setChoice] = useState<string | null>(null);
  const method = choice ?? claudeMethod(auth.status);
  const busy = auth.action !== null;
  return (
    <AgentAuthSection
      name="Claude Code"
      methods={CLAUDE_METHODS}
      method={method}
      onMethodChange={setChoice}
      status={
        <SettingsStatusLine
          text={auth.action === "login" ? "Finish signing in in your browser…" : claudeStatusLine(auth.status, auth.cliMissing)}
          onRefresh={() => void auth.refresh()}
          refreshing={busy}
        />
      }
    >
      {auth.error && <SettingsError>{auth.error}</SettingsError>}
      {auth.status?.logged_in ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void auth.logout()}>
          {auth.action === "logout" ? <AsciiSpinner /> : <LogOut />}
          Sign out
        </Button>
      ) : (
        // Claude Code has no command that takes a pasted key. Its API-key
        // path is a Console sign-in, which mints a key for the CLI itself.
        <AgentLoginButton
          label={method === "key" ? "Sign in with Anthropic Console" : "Run claude /login"}
          running={auth.action === "login"}
          disabled={auth.cliMissing || busy}
          onClick={() => void auth.login(method === "key" ? "console" : "claudeai")}
        />
      )}
    </AgentAuthSection>
  );
}

export function CodexAuthPanel({ auth }: { auth: CodexAuth }) {
  const [choice, setChoice] = useState<string | null>(null);
  const method = choice ?? codexMethod(auth.status);
  const busy = auth.action !== null;
  const runnable = auth.status?.state !== "missing" && auth.status?.state !== "broken";
  const fix = auth.status?.fix_command;
  return (
    <AgentAuthSection
      name="Codex"
      methods={CODEX_METHODS}
      method={method}
      onMethodChange={setChoice}
      status={
        <SettingsStatusLine
          text={
            auth.action === "login" ? (
              "Finish signing in in your browser…"
            ) : (
              <>
                {codexStatusLine(auth.status)}
                {fix && (
                  <>
                    {" "}
                    Run <code>{fix}</code>
                  </>
                )}
              </>
            )
          }
          onRefresh={() => void auth.refresh()}
          refreshing={busy}
        />
      }
    >
      {auth.error && <SettingsError>{auth.error}</SettingsError>}
      {method === "key" ? (
        <AgentApiKeyField name="Codex" saving={auth.action === "key"} onSave={auth.saveApiKey} />
      ) : (
        <AgentLoginButton
          label="Sign in with ChatGPT"
          running={auth.action === "login"}
          disabled={!runnable || busy}
          onClick={() => void auth.login()}
        />
      )}
    </AgentAuthSection>
  );
}
