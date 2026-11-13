import type { OpenAiCompatProfile } from "../../../lib/api";

// Where a new local or hosted model usually lives. Choosing one fills in the
// address and a model that provider is known to serve; every field stays
// editable afterwards.

export type OpenAiCompatPreset = {
  id: string;
  label: string;
  base_url: string;
  default_model: string;
  needs_key: boolean;
  hint: string;
};

export const OPENAI_COMPAT_PRESETS: OpenAiCompatPreset[] = [
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

export function blankOpenAiCompatProfile(): OpenAiCompatProfile {
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

/** `Key: Value` per line; blank lines and `#` comments are skipped. */
export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
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
