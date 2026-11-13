import { useState } from "react";
import { Check, KeyRound, Terminal, RefreshCw, Play, ExternalLink, Folder } from "lucide-react";
import { AgentIcon } from "./agent-icon";
import { Button } from "./button";
import { Input } from "./input";
import { Switch } from "./switch";
import { Select } from "./select";
import { SettingsRow } from "./settings-row";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tab-panels";

export function ProviderSettings({
  paths,
  onPathChange,
  onLogin,
  onRefresh,
  onSaveApiKey,
  onBrowse,
  onOpenSettings,
  onConfigure,
  initialProvider = "Claude Code",
  loginStatus = "Desktop connection unavailable",
  configuredProviders = 0,
  selectedModels = 0,
}: {
  paths: Record<string, string>;
  onPathChange: (provider: string, path: string) => void;
  onLogin?: (provider: string, method: string) => void;
  onRefresh?: (provider: string) => void;
  onSaveApiKey?: (provider: string, key: string) => void;
  onBrowse?: (provider: string) => void;
  onOpenSettings?: (provider: string) => void;
  onConfigure?: (section: "providers" | "models") => void;
  initialProvider?: string;
  loginStatus?: string;
  configuredProviders?: number;
  selectedModels?: number;
}) {
  const [provider, setProvider] = useState(initialProvider);
  const [authentication, setAuthentication] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [chrome, setChrome] = useState(false);
  const [personality, setPersonality] = useState("pragmatic");
  const providers = ["Claude Code", "Codex", "Cursor", "OpenCode"];
  const executable = (name: string) => (
    <SettingsRow
      title={`${name} executable path`}
      description={`Override the bundled ${name} executable with a custom one. Leave empty to use the bundled version (recommended).`}
      control={
        <div style={{ display: "flex", gap: 8 }}>
          <Input
            aria-label={`${name} executable path`}
            placeholder="Use bundled executable"
            value={paths[name] ?? ""}
            onChange={(event) => onPathChange(name, event.target.value)}
          />
          <Button
            size="iconSm"
            variant="outline"
            aria-label="Browse for executable"
            disabled={!onBrowse}
            onClick={() => onBrowse?.(name)}
          >
            <Folder />
          </Button>
        </div>
      }
    />
  );
  const apiKey = (name: string) => (
    <div className="ui-provider-api-field" style={{ display: "flex", gap: 8 }}>
      <Input
        type="password"
        aria-label={`${name} API key`}
        placeholder={`${name} API key`}
        autoComplete="off"
        value={keys[name] ?? ""}
        onChange={(event) => setKeys({ ...keys, [name]: event.target.value })}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!onSaveApiKey || !keys[name]?.trim()}
        onClick={() => onSaveApiKey?.(name, keys[name])}
      >
        Save
      </Button>
    </div>
  );
  return (
    <Tabs value={provider} onValueChange={setProvider} className="ui-provider-settings">
      <TabsList aria-label="Agent providers" className="ui-provider-tabs">
        {providers.map((name) => (
          <TabsTrigger key={name} value={name}>
            <AgentIcon provider={name} />
            {name}
          </TabsTrigger>
        ))}
      </TabsList>
      {providers.map((name) => {
        const method = authentication[name] ?? "CLI";
        return (
          <TabsContent key={name} value={name}>
            {name === "Cursor" ? (
              <>
                <SettingsRow
                  title="API key"
                  description="No Cursor API key configured"
                  control={
                    <Button size="sm" variant="outline" asChild>
                      <a
                        href="https://cursor.com/dashboard/api?section=user-keys#user-api-keys"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Get key
                        <ExternalLink />
                      </a>
                    </Button>
                  }
                />
                {apiKey(name)}
              </>
            ) : name === "OpenCode" ? (
              <>
                <div className="ui-provider-login-status">
                  <div>
                    <strong>OpenCode</strong>
                    <p>The open source AI coding agent</p>
                  </div>
                  <Button size="sm" variant="link" asChild>
                    <a href="https://opencode.ai/docs" target="_blank" rel="noreferrer">
                      Docs
                      <ExternalLink />
                    </a>
                  </Button>
                </div>
                <SettingsRow
                  title="Providers"
                  description={`${configuredProviders} configured`}
                  control={
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!onConfigure}
                      onClick={() => onConfigure?.("providers")}
                    >
                      Configure
                    </Button>
                  }
                />
                <SettingsRow
                  title="Models"
                  description={`${selectedModels} selected`}
                  control={
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!onConfigure}
                      onClick={() => onConfigure?.("models")}
                    >
                      Configure
                    </Button>
                  }
                />
                <details>
                  <summary>Advanced</summary>
                  <div className="ui-provider-login-status">
                    <span>Desktop connection unavailable</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!onRefresh}
                      onClick={() => onRefresh?.(name)}
                    >
                      <RefreshCw />
                      Refresh
                    </Button>
                  </div>
                  {executable(name)}
                </details>
              </>
            ) : (
              <>
                <section className="ui-provider-auth">
                  <h2>Authentication</h2>
                  <div
                    className="ui-provider-methods"
                    role="group"
                    aria-label={`${name} authentication`}
                  >
                    {(name === "Codex" ? ["ChatGPT", "CLI", "API key"] : ["CLI", "API key"]).map(
                      (choice) => (
                        <button
                          key={choice}
                          type="button"
                          aria-pressed={method === choice}
                          onClick={() => setAuthentication({ ...authentication, [name]: choice })}
                        >
                          {method === choice && (
                            <Check size={16} className="ui-provider-method-check" />
                          )}
                          {choice === "API key" ? (
                            <KeyRound size={24} />
                          ) : choice === "ChatGPT" ? (
                            <AgentIcon provider="Codex" size={24} />
                          ) : (
                            <Terminal size={24} />
                          )}
                          <span>
                            {choice}
                            {choice === "ChatGPT" && (
                              <small style={{ display: "block", color: "var(--ui-muted-fg)" }}>
                                Recommended
                              </small>
                            )}
                          </span>
                        </button>
                      ),
                    )}
                  </div>
                  <div className="ui-provider-login-status">
                    <span>{loginStatus}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!onRefresh}
                      onClick={() => onRefresh?.(name)}
                    >
                      <RefreshCw />
                      Refresh
                    </Button>
                  </div>
                  {method === "API key" ? (
                    apiKey(name)
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!onLogin}
                      onClick={() => onLogin?.(name, method)}
                    >
                      <Play />
                      {method === "ChatGPT"
                        ? "Sign in with ChatGPT"
                        : `Run ${name === "Claude Code" ? "claude /login" : "codex login"}`}
                    </Button>
                  )}
                </section>
                {name === "Claude Code" ? (
                  <SettingsRow
                    title="Use Claude Code with Chrome"
                    description="Allow Claude Code to control your Chrome browser."
                    control={
                      <Switch
                        aria-label="Use Claude Code with Chrome"
                        checked={chrome}
                        onCheckedChange={setChrome}
                      />
                    }
                  />
                ) : (
                  <SettingsRow
                    title="Codex personality for new chats"
                    description="Style to use when a new chat starts with a Codex model"
                    control={
                      <Select
                        aria-label="Codex personality"
                        value={personality}
                        onChange={setPersonality}
                        options={[
                          { value: "pragmatic", label: "Pragmatic (default)" },
                          { value: "friendly", label: "Friendly" },
                        ]}
                      />
                    }
                  />
                )}
                {executable(name)}
                <SettingsRow
                  title={name === "Claude Code" ? "Claude settings" : "Codex config"}
                  description={
                    name === "Claude Code" ? "~/.claude/settings.json" : "~/.codex/config.toml"
                  }
                  control={
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!onOpenSettings}
                      onClick={() => onOpenSettings?.(name)}
                    >
                      <Folder />
                      Open in
                    </Button>
                  }
                />
              </>
            )}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
