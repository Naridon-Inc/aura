// What the two "add a brain" forms on Settings → Brain & models start from.
//
// Custom providers are any OpenAI-compatible endpoint, saved as
// `openai_compat:<slug>` through `brain_upsert_provider`. Azure OpenAI is
// the odd one: it authenticates with an `api-key:` header and needs an
// `api-version` query param, both carried by the openai_compat AuthStyle /
// query plumbing, so the form only flips two knobs for it.
//
// The cloud singletons (AWS Bedrock, Google Vertex AI) run Anthropic's
// Claude but neither takes a single API key: Bedrock signs each call with
// an access-key pair + region, Vertex exchanges a service-account JSON for
// an OAuth token. Non-secret fields land in brain_settings.json; the
// credential goes straight to the OS keychain via `brain_configure_cloud`.

export const AZURE_API_VERSION_DEFAULT = "2024-08-01-preview";

export type CustomProviderPreset = {
  id: string;
  label: string;
  base_url: string;
  default_model: string;
  needs_key: boolean;
  /** Azure authenticates with `api-key:` rather than Bearer. */
  auth_style?: "api_key";
  /** Azure requires an `api-version` query param on every request. */
  needs_api_version?: boolean;
  hint: string;
};

export const CUSTOM_PROVIDER_PRESETS: CustomProviderPreset[] = [
  {
    id: "azure",
    label: "Azure OpenAI",
    base_url: "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT",
    default_model: "gpt-4o",
    needs_key: true,
    auth_style: "api_key",
    needs_api_version: true,
    hint: "Swap YOUR-RESOURCE and YOUR-DEPLOYMENT into the URL. Uses the api-key header + api-version query. No /chat/completions on the end.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    base_url: "https://openrouter.ai/api/v1",
    default_model: "anthropic/claude-3.5-sonnet",
    needs_key: true,
    hint: "Multi-vendor router. Paste your OpenRouter key.",
  },
  {
    id: "xai",
    label: "xAI",
    base_url: "https://api.x.ai/v1",
    default_model: "grok-4.5",
    needs_key: true,
    hint: "Grok models through xAI's OpenAI-compatible API.",
  },
  {
    id: "groq",
    label: "Groq",
    base_url: "https://api.groq.com/openai/v1",
    default_model: "llama-3.3-70b-versatile",
    needs_key: true,
    hint: "Fastest token throughput. Paste your Groq key.",
  },
  {
    id: "together",
    label: "Together.ai",
    base_url: "https://api.together.xyz/v1",
    default_model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    needs_key: true,
    hint: "Hosted open models. Paste your Together key.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    base_url: "http://localhost:11434/v1",
    default_model: "llama3.2",
    needs_key: false,
    hint: "Runs on your machine. No API key.",
  },
  {
    id: "custom",
    label: "Custom endpoint",
    base_url: "",
    default_model: "",
    needs_key: true,
    hint: "Any server that speaks /v1/chat/completions.",
  },
];

export function slugifyProvider(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export type CloudField = {
  key: string;
  label: string;
  placeholder: string;
  optional?: boolean;
};

export type CloudBrainId = "bedrock" | "vertex";

export type CloudBrainPreset = {
  id: CloudBrainId;
  label: string;
  defaultModel: string;
  fields: CloudField[];
  secretLabel: string;
  secretPlaceholder: string;
  secretMultiline?: boolean;
  hint: string;
};

export const CLOUD_BRAIN_PRESETS: CloudBrainPreset[] = [
  {
    id: "bedrock",
    label: "AWS Bedrock",
    // Newer Anthropic models are reached through a cross-region inference
    // profile, hence the `us.` prefix (`bedrock.rs` handles that shape).
    // Anyone outside US regions edits the field.
    defaultModel: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    fields: [
      { key: "region", label: "Region", placeholder: "us-east-1" },
      { key: "access_key_id", label: "Access key ID", placeholder: "AKIA…" },
      {
        key: "session_token",
        label: "Session token",
        placeholder: "only for temporary STS credentials",
        optional: true,
      },
    ],
    secretLabel: "Secret access key",
    secretPlaceholder: "AWS secret access key",
    hint: "Runs Claude on your AWS account. Needs an IAM key pair with bedrock:InvokeModel and the model enabled in the region.",
  },
  {
    id: "vertex",
    label: "Google Vertex AI",
    defaultModel: "claude-sonnet-4-5@20250929",
    fields: [
      { key: "project_id", label: "Project ID", placeholder: "my-gcp-project" },
      { key: "location", label: "Location", placeholder: "us-east5" },
    ],
    secretLabel: "Service-account JSON",
    secretPlaceholder:
      '{ "type": "service_account", "client_email": "…", "private_key": "-----BEGIN PRIVATE KEY-----\\n…" }',
    secretMultiline: true,
    hint: "Runs Claude on your GCP project. Paste the JSON key for a service account that has the Vertex AI User role.",
  },
];
