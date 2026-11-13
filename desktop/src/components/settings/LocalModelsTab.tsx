// Settings → Local & custom models.
//
// Editor + connection tester for the `openai-compat` agent kind. Anything
// that speaks OpenAI's `/v1/chat/completions` (Ollama, HuggingFace TGI,
// Together, Groq, OpenRouter, vLLM, …) plugs in here. Entries persist to
// `~/.aura/agents/openai-compat.json` via `cmd_openai_compat.rs`; the
// launcher reads the same list, so starting one of these is exactly like
// starting Claude.
//
// The type is still `OpenAiCompatProfile`, but the word "profile" does not
// reach the screen. Accounts & profiles means something else by it (a git
// identity and an agent HOME), and one settings surface cannot spend one
// word on two unrelated things. What you add here is a model you can chat
// with, so that is what it is called.

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  SettingsActions,
  SettingsEmpty,
  SettingsError,
  SettingsGroup,
  SettingsIntro,
} from "../ui/settings-blocks";
import { SettingsRow } from "../ui/settings-row";
import { api, type OpenAiCompatProfile, type OpenAiCompatTestResult } from "../../lib/api";
import { askConfirm } from "../ui/ask";
import { LocalModelEditor } from "./local-models/LocalModelEditor";
import { blankOpenAiCompatProfile } from "./local-models/presets";

type TestState = { running: boolean; result?: OpenAiCompatTestResult; error?: string };

export function LocalModelsTab() {
  const [profiles, setProfiles] = useState<OpenAiCompatProfile[]>([]);
  const [editing, setEditing] = useState<OpenAiCompatProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestState>>({});

  const reload = useCallback(async () => {
    try {
      setProfiles(await api.openaiCompatProfilesList());
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function test(name: string) {
    setTestResults((prev) => ({ ...prev, [name]: { running: true } }));
    try {
      const result = await api.openaiCompatTest(name);
      setTestResults((prev) => ({ ...prev, [name]: { running: false, result } }));
    } catch (e) {
      setTestResults((prev) => ({ ...prev, [name]: { running: false, error: String(e) } }));
    }
  }

  async function remove(name: string) {
    if (
      !(await askConfirm({
        title: `Remove “${name}”?`,
        body: "Its address, model name and key are forgotten. You can add it again later.",
        confirmLabel: "Remove",
        tone: "danger",
      }))
    )
      return;
    try {
      setProfiles(await api.openaiCompatProfileRemove(name));
    } catch (e) {
      setLoadError(String(e));
    }
  }

  async function save(next: OpenAiCompatProfile) {
    setSaving(true);
    try {
      setProfiles(await api.openaiCompatProfileSave(next));
      setEditing(null);
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* Leads with why anyone comes here: the model runs on your own
          machine, or somewhere you already pay for. The compatibility fact
          still matters to the people it matters to, so it closes. */}
      <SettingsIntro>
        Chat with a model that isn’t one of the built-in ones: one running on this machine, or
        hosted somewhere you already have an account. Ollama, HuggingFace, Together, Groq,
        OpenRouter and vLLM all work, and so does anything else that speaks OpenAI’s API.
      </SettingsIntro>
      {loadError && <SettingsError>{loadError}</SettingsError>}
      {profiles.length === 0 && !editing && (
        <SettingsEmpty>
          No models added yet. Point Aura at a model you run yourself with Ollama, or at a hosted
          one you already pay for. It then appears in the “+” menu beside Claude and the rest.
        </SettingsEmpty>
      )}
      {profiles.length > 0 && (
        <SettingsGroup>
          {profiles.map((p) => (
            <ModelRow
              key={p.name}
              profile={p}
              status={testResults[p.name]}
              onTest={() => void test(p.name)}
              onEdit={() => setEditing(p)}
              onRemove={() => void remove(p.name)}
            />
          ))}
        </SettingsGroup>
      )}
      {editing ? (
        <LocalModelEditor
          key={editing.name || "new"}
          entry={editing}
          existingNames={profiles.map((p) => p.name)}
          busy={saving}
          onCancel={() => setEditing(null)}
          onSave={(next) => void save(next)}
        />
      ) : (
        <SettingsRow
          title="Add a model"
          description={
            profiles.length === 0
              ? "A local server or a hosted provider, under a name you choose."
              : profiles.length === 1
                ? "1 model added."
                : `${profiles.length} models added.`
          }
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(blankOpenAiCompatProfile())}
            >
              Add a model
            </Button>
          }
        />
      )}
    </>
  );
}

function ModelRow({
  profile: p,
  status,
  onTest,
  onEdit,
  onRemove,
}: {
  profile: OpenAiCompatProfile;
  status: TestState | undefined;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const help = status?.running ? (
    <span className="ui-settings-status" role="status">
      <AsciiSpinner />
      Testing…
    </span>
  ) : status?.result ? (
    status.result.ok ? (
      <span role="status">{status.result.message}</span>
    ) : (
      <span role="alert" className="ui-field-error">
        {status.result.message}
      </span>
    )
  ) : status?.error ? (
    <span role="alert" className="ui-field-error">
      {status.error}
    </span>
  ) : undefined;
  return (
    <SettingsRow
      title={p.name}
      description={
        <>
          <code>{p.model}</code> · <code>{p.base_url}</code>
        </>
      }
      help={help}
      control={
        <SettingsActions>
          {!p.api_key && <Badge variant="outline">No key</Badge>}
          <Button
            size="sm"
            variant="outline"
            onClick={onTest}
            disabled={status?.running}
            title="Ask this model for one word, to check Aura can reach it"
          >
            Test
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit}>
            Edit
          </Button>
          <Button size="iconSm" variant="ghost" aria-label={`Remove ${p.name}`} onClick={onRemove}>
            <Trash2 size={14} />
          </Button>
        </SettingsActions>
      }
    />
  );
}
