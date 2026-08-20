// Settings → Local & Custom Models pane.
//
// Editor + connection tester for the `openai-compat` agent kind. Anything
// that speaks OpenAI's `/v1/chat/completions` (Ollama, HuggingFace TGI,
// Together, Groq, OpenRouter, vLLM, …) plugs in here. Entries persist to
// `~/.aura/agents/openai-compat.json` via `cmd_openai_compat.rs`; the
// launcher reads the same list, so starting one of these is exactly like
// starting Claude.
//
// The type is still `OpenAiCompatProfile`, but the word "profile" does not
// reach the screen here any more. Two rails away, Accounts & profiles means
// something else entirely by it — a git identity and an agent HOME — and a
// settings surface cannot afford one word for two unrelated things. What
// you add on this pane is a model you can chat with, so that is what it is
// called.

import { useCallback, useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Field as FormField } from "../ui/field";
import { FullscreenOverlay } from "../FullscreenOverlay";
import {
  api,
  type OpenAiCompatProfile,
  type OpenAiCompatTestResult,
} from "../../lib/api";
import { AgentIcon } from "../agent/AgentIcon";
import { Card, PaneIntro } from "../settings/kit";
import { EmptyState } from "../ui/state";
import { askConfirm } from "../ui/ask";

type OpenAiCompatPreset = {
  id: string;
  label: string;
  base_url: string;
  default_model: string;
  needs_key: boolean;
  hint: string;
};

const OPENAI_COMPAT_PRESETS: OpenAiCompatPreset[] = [
  {
    id: "ollama",
    label: "Ollama (localhost)",
    base_url: "http://localhost:11434/v1",
    default_model: "llama3.2",
    needs_key: false,
    hint: "Local. Runs models on your machine. No API key required.",
  },
  {
    id: "huggingface",
    label: "HuggingFace Inference",
    base_url: "https://api-inference.huggingface.co/v1",
    default_model: "meta-llama/Llama-3.3-70B-Instruct",
    needs_key: true,
    hint: "Hosted. Paste an HF Inference API token as the API key.",
  },
  {
    id: "together",
    label: "Together.ai",
    base_url: "https://api.together.xyz/v1",
    default_model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    needs_key: true,
    hint: "Hosted. Sign up at together.ai and paste your key.",
  },
  {
    id: "groq",
    label: "Groq",
    base_url: "https://api.groq.com/openai/v1",
    default_model: "llama-3.3-70b-versatile",
    needs_key: true,
    hint: "Hosted. Fastest token throughput; paste your Groq API key.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    base_url: "https://openrouter.ai/api/v1",
    default_model: "meta-llama/llama-3.3-70b-instruct",
    needs_key: true,
    hint: "Hosted. Multi-vendor router; paste your OpenRouter key.",
  },
];

function blankOpenAiCompatProfile(): OpenAiCompatProfile {
  return {
    name: "",
    base_url: "",
    model: "",
    api_key: "",
    headers: {},
    temperature: null,
    description: "",
    created_at: null,
  };
}

export function LocalModelsTab() {
  const [profiles, setProfiles] = useState<OpenAiCompatProfile[]>([]);
  const [editing, setEditing] = useState<OpenAiCompatProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { running: boolean; result?: OpenAiCompatTestResult; error?: string }>
  >({});

  const reload = useCallback(async () => {
    try {
      const list = await api.openaiCompatProfilesList();
      setProfiles(list);
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
      setTestResults((prev) => ({
        ...prev,
        [name]: { running: false, error: String(e) },
      }));
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
      const next = await api.openaiCompatProfileRemove(name);
      setProfiles(next);
    } catch (e) {
      setLoadError(String(e));
    }
  }

  return (
    <>
      {/* The intro led with "OpenAI-compatible endpoints" and closed on
          "/v1/chat/completions" — the wire protocol, twice, and nothing
          about why anyone would come here. The reason is that the model
          runs on your own machine, or somewhere you already pay for. The
          compatibility fact still matters to the people it matters to, so
          it keeps its place at the end. */}
      <PaneIntro text="Chat with a model that isn’t one of the built-in ones — one running on this machine, or hosted somewhere you already have an account. Ollama, HuggingFace, Together, Groq, OpenRouter and vLLM all work, and so does anything else that speaks OpenAI’s API." />
      {loadError && (
        <div className="text-sm text-red mb-3" role="alert">
          {loadError}
        </div>
      )}
      {profiles.length === 0 ? (
        // A grey sentence with a button floating beside it was the only
        // empty state on this pane, while every other surface got a real
        // one. Nothing here told you what you would get by pressing it.
        <EmptyState
          icon={Cpu}
          title="No models added yet"
          body="Point Aura at a model you run yourself with Ollama, or at a hosted one you already pay for. It then appears in the “+” menu beside Claude and the rest, and you chat with it the same way."
          action={{
            label: "Add a model",
            onClick: () => setEditing(blankOpenAiCompatProfile()),
            icon: Cpu,
          }}
          size="sm"
        />
      ) : (
        <>
          <div className="mb-3.5 flex items-center gap-2">
            <span className="text-sm text-text-3 flex-1">
              {profiles.length === 1
                ? "1 model added."
                : `${profiles.length} models added.`}
            </span>
            <Button
              variant="default"
              size="xs"
              onClick={() => setEditing(blankOpenAiCompatProfile())}
            >
              + Add a model
            </Button>
          </div>
          <Card>
          {profiles.map((p) => {
            const status = testResults[p.name];
            return (
              <div key={p.name} className="flex items-center gap-2.5 py-3">
                <span className="mt-px shrink-0 self-start">
                  <AgentIcon agentId="openai-compat" label={p.name} size={18} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-base text-text-1">{p.name}</span>
                    <span className="text-xs text-text-4 font-mono">
                      {p.model}
                    </span>
                    {!p.api_key && (
                      <span className="text-2xs text-text-4 border border-line-soft rounded px-1 py-0.5">
                        no-key
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-text-4 font-mono truncate">
                    {p.base_url}
                  </div>
                  {status?.running && (
                    <div className="mt-0.5 text-xs text-text-4">
                      Testing…
                    </div>
                  )}
                  {status?.result && (
                    <div
                      className="mt-0.5 text-xs"
                      style={{
                        color: status.result.ok
                          ? "var(--color-accent-green)"
                          : "var(--color-red)",
                      }}
                    >
                      {status.result.message}
                    </div>
                  )}
                  {status?.error && (
                    <div className="mt-0.5 text-xs text-red">
                      {status.error}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void test(p.name)}
                    disabled={status?.running}
                    title="Ask this model for one word, to check Aura can reach it"
                  >
                    Test
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setEditing(p)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void remove(p.name)}
                    className="text-red hover:text-red"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            );
          })}
          </Card>
        </>
      )}
      {editing && (
        <OpenAiCompatEditor
          entry={editing}
          existingNames={profiles.map((p) => p.name)}
          onCancel={() => setEditing(null)}
          onSave={async (next) => {
            try {
              const list = await api.openaiCompatProfileSave(next);
              setProfiles(list);
              setEditing(null);
            } catch (e) {
              setLoadError(String(e));
            }
          }}
        />
      )}
    </>
  );
}

function OpenAiCompatEditor({
  entry,
  existingNames,
  onCancel,
  onSave,
}: {
  entry: OpenAiCompatProfile;
  existingNames: string[];
  onCancel: () => void;
  onSave: (entry: OpenAiCompatProfile) => void;
}) {
  const [draft, setDraft] = useState<OpenAiCompatProfile>({
    ...entry,
    headers: entry.headers ?? {},
  });
  // Headers as a single textarea — `Key: Value` per line. Keeps the
  // editor simple; advanced users (HF dedicated endpoints with
  // multi-header auth) just paste a block.
  const [headersText, setHeadersText] = useState<string>(() => {
    const h = entry.headers ?? {};
    return Object.entries(h)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  });

  const isNew = !entry.created_at;
  const nameTaken =
    isNew &&
    existingNames.some(
      (n) => n.toLowerCase() === draft.name.trim().toLowerCase(),
    );

  function applyPreset(preset: OpenAiCompatPreset) {
    setDraft((prev) => ({
      ...prev,
      base_url: preset.base_url,
      model: prev.model || preset.default_model,
      description: prev.description || preset.hint,
    }));
  }

  function parseHeaders(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of headersText.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (key) out[key] = value;
    }
    return out;
  }

  function save() {
    const headers = parseHeaders();
    onSave({
      ...draft,
      name: draft.name.trim(),
      base_url: draft.base_url.trim(),
      model: draft.model.trim(),
      api_key: draft.api_key?.trim() || null,
      headers,
      temperature:
        typeof draft.temperature === "number" && !Number.isNaN(draft.temperature)
          ? draft.temperature
          : null,
      description: draft.description?.trim() || null,
    });
  }

  const saveDisabled =
    !draft.name.trim() ||
    !draft.base_url.trim() ||
    !draft.model.trim() ||
    nameTaken;

  return (
    <FullscreenOverlay
      onClose={onCancel}
      contentClassName="overflow-y-auto"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="accentSoft"
            size="sm"
            onClick={save}
            disabled={saveDisabled}
          >
            {isNew ? "Add model" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="flex w-full flex-col items-center px-6 py-12 sm:py-16">
        <div className="flex w-full max-w-[640px] flex-col gap-8">
          <div>
            <h1 className="text-xl font-medium leading-7 text-text-1">
              {isNew ? "Add a model" : `Edit ${entry.name}`}
            </h1>
            <p className="mt-1.5 text-base leading-relaxed text-text-3">
              Tell Aura where the model lives and what it is called. Once it
              is here you chat with it exactly like a built-in model — it
              appears in the same “+” menu, under the name you give it.
            </p>
          </div>

          <FormField
            label="Start from one of these"
            description="Fills in the address and a model that provider is known to serve. Everything below stays editable."
          >
            <div className="flex flex-wrap gap-1.5">
              {OPENAI_COMPAT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className="h-8 rounded-md bg-bg-content px-3 text-base font-medium text-text-2 shadow-[var(--shadow-field)] transition-colors hover:text-text-1"
                  title={p.hint}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </FormField>

          <div className="flex flex-col gap-6">
            <FormField
              label="Name"
              htmlFor="oac-name"
              description="What you'll see it called in the “+” menu. Letters, digits, spaces."
              error={
                nameTaken ? "You already have one called that." : undefined
              }
            >
              <Input
                id="oac-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                disabled={!isNew}
                placeholder="Llama 3 (local)"
                invalid={nameTaken}
              />
            </FormField>

            <FormField
              label="Base URL"
              htmlFor="oac-url"
              description="The address the model answers on — usually ending in /v1. Aura adds /chat/completions and /models itself, so stop before those."
            >
              <Input
                id="oac-url"
                value={draft.base_url}
                onChange={(e) =>
                  setDraft({ ...draft, base_url: e.target.value })
                }
                placeholder="http://localhost:11434/v1"
                className="font-mono"
              />
            </FormField>

            <FormField
              label="Model"
              htmlFor="oac-model"
              description="The name that provider knows the model by — an Ollama tag, a HuggingFace repo path, a vendor's model name. Copy it exactly."
            >
              <Input
                id="oac-model"
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                placeholder="llama3.2 / qwen2.5-coder:7b / meta-llama/Llama-3.3-70B-Instruct"
                className="font-mono"
              />
            </FormField>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <FormField
                label="API key"
                htmlFor="oac-key"
                optional
                description="Leave this blank for Ollama and anything else running on your own machine — they don't ask for one. Hosted providers do."
              >
                <Input
                  id="oac-key"
                  type="password"
                  value={draft.api_key ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, api_key: e.target.value })
                  }
                  placeholder="sk-… / hf_…"
                  className="font-mono"
                  autoComplete="off"
                />
              </FormField>
              <FormField
                label="Temperature"
                htmlFor="oac-temp"
                optional
                description="0.0 = deterministic, 1.0 = creative. Blank leaves the server default."
              >
                <Input
                  id="oac-temp"
                  type="number"
                  step="0.05"
                  min="0"
                  max="2"
                  value={
                    typeof draft.temperature === "number" ? draft.temperature : ""
                  }
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      temperature:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder="0.7"
                  className="font-mono"
                />
              </FormField>
            </div>

            <FormField
              label="Extra headers"
              htmlFor="oac-headers"
              optional
              description="One header per line. Name: Value. Useful for HF dedicated endpoints, OpenRouter routing hints, etc."
            >
              <Textarea
                id="oac-headers"
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                rows={3}
                placeholder={"X-HF-Endpoint: my-endpoint\nHTTP-Referer: https://example.com"}
                className="font-mono"
              />
            </FormField>

            <FormField
              label="Description"
              htmlFor="oac-desc"
              optional
              description="Shown under the name in the “+” menu — useful for telling two similar ones apart."
            >
              <Input
                id="oac-desc"
                value={draft.description ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
                placeholder="Local Llama 3 via Ollama"
              />
            </FormField>

            {/* The consequence first — this is a warning, and "for this
                iteration … in a follow-up" is release-planning language, not
                what someone deciding whether to paste a key needs to read.

                It was also invisible as a warning: the classes said
                `accent-amber`, and there is no such token in the app — the
                warning colour is `amber` (--color-amber). This file was the
                only place in the codebase spelling it the other way, so the
                border, the wash and the text all resolved to nothing and the
                one box you must not skim read as ordinary body copy. */}
            <div className="rounded-lg border border-amber/40 bg-amber/10 px-3.5 py-2.5 text-sm leading-relaxed text-amber">
              A key you paste here is saved unencrypted in{" "}
              <code className="font-mono">~/.aura/agents/openai-compat.json</code>,
              so anyone who can read that file can read the key. Moving these
              into the system keychain is on the way.
            </div>
          </div>
        </div>
      </div>
    </FullscreenOverlay>
  );
}
