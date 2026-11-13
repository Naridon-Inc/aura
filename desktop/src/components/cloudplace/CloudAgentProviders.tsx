// The custom providers an agent can run through instead of its own sign-in:
// Vercel AI Gateway, OpenRouter (Codex), Amazon Bedrock (Claude Code), or
// manual setup, where the member keeps the sign-in on the machine.

import { useState } from "react";
import { ArrowUpRight } from "lucide-react";

import {
  bedrockValue,
  CUSTOM_PROVIDERS,
  harnessSpec,
  MANUAL,
  type CustomProvider,
  type Harness,
} from "../../lib/cloudAgentCredentials";
import { openExternal } from "../../lib/openExternal";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { removeCredential, SavedRow, saveCredential, SecretField } from "./cloudAgentParts";

function andList(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What disconnecting a provider does, for every agent sharing it. */
function disconnectBody(p: CustomProvider): string {
  const agents = p.harnesses.map((h) => harnessSpec(h)?.label ?? h);
  return agents.length === 1
    ? `Cloud workspaces will go back to running ${agents[0]} on its own credentials.`
    : `${p.label} is shared by ${andList(agents)}, so all of them go back to running on their own credentials.`;
}

function BedrockForm({ onSaved }: { onSaved: () => void }) {
  const [kind, setKind] = useState<"bearer" | "access_keys">("bearer"),
    [f, setF] = useState({ bearerToken: "", accessKeyId: "", secretAccessKey: "", sessionToken: "", region: "", testModel: "" }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const field = (key: keyof typeof f, label: string, secret = false) => (
    <label key={key}>
      <span>{label}</span>
      <Input
        type={secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        value={f[key]}
        onChange={(e) => setF({ ...f, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <form
      className="ui-cloud-agent-key"
      onSubmit={async (e) => {
        e.preventDefault();
        const missing =
          !f.region.trim() ||
          (kind === "bearer" ? !f.bearerToken.trim() : !f.accessKeyId.trim() || !f.secretAccessKey.trim());
        if (missing) {
          setError("Enter all required Bedrock fields.");
          return;
        }
        setError("");
        setBusy(true);
        const value =
          kind === "bearer"
            ? bedrockValue({ kind, bearerToken: f.bearerToken, region: f.region, testModel: f.testModel })
            : bedrockValue({ kind, ...f });
        if (await saveCredential("bedrock_credentials", value, "Amazon Bedrock connected.")) onSaved();
        setBusy(false);
      }}
    >
      <div className="ui-cloud-segments">
        {(["bearer", "access_keys"] as const).map((k) => (
          <button type="button" key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {k === "bearer" ? "Bedrock API key" : "AWS access keys"}
          </button>
        ))}
      </div>
      {kind === "bearer"
        ? field("bearerToken", "Bedrock API key", true)
        : [
            field("accessKeyId", "Access key ID"),
            field("secretAccessKey", "Secret access key", true),
            field("sessionToken", "Session token (optional)", true),
          ]}
      {field("region", "Region")}
      {field("testModel", "Test model")}
      {error && <p role="alert">{error}</p>}
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

export function CloudAgentProviders({
  harness,
  label,
  saved,
}: {
  harness: Harness;
  label: string;
  saved: Set<string>;
}) {
  const providers = CUSTOM_PROVIDERS.filter((p) => p.harnesses.includes(harness));
  const manual = MANUAL[harness];
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="ui-cloud-agent-providers">
      {providers.map((p) =>
        saved.has(p.name) && open !== p.name ? (
          <SavedRow
            key={p.name}
            label={p.label}
            credential={p.name}
            onReplace={() => setOpen(p.name)}
            onDisconnect={() =>
              removeCredential(
                p.name,
                p.name === "bedrock_credentials"
                  ? { title: "Disconnect Amazon Bedrock?", body: "Cloud workspaces will stop using Amazon Bedrock." }
                  : { title: "Disconnect custom provider?", body: disconnectBody(p) },
                p.name === "bedrock_credentials" ? "Amazon Bedrock disconnected." : `Removed ${p.label}.`,
              )
            }
          />
        ) : open === p.name ? (
          p.name === "bedrock_credentials" ? (
            <BedrockForm key={p.name} onSaved={() => setOpen(null)} />
          ) : (
            <SecretField
              key={p.name}
              label={`${p.label} key`}
              placeholder={p.placeholder}
              action={
                p.createKeyUrl && (
                  <Button type="button" size="xs" variant="ghost" onClick={() => void openExternal(p.createKeyUrl)}>
                    Get key <ArrowUpRight />
                  </Button>
                )
              }
              onSave={async (v) => {
                const ok = await saveCredential(p.name, v, `Using ${p.label} for ${label}.`);
                if (ok) setOpen(null);
                return ok;
              }}
            />
          )
        ) : (
          <button key={p.name} className="ui-cloud-row" onClick={() => setOpen(p.name)}>
            <span>{p.label}</span>
            <span className="ui-cloud-create-spacer" />
            <small>Connect</small>
            <ArrowUpRight size={14} />
          </button>
        ),
      )}
      {manual && (
        <div className="ui-cloud-row ui-cloud-agent-manual">
          <span>Manual</span>
          <small>
            Aura injects and brokers no credential for {label}. Your own script inside the sandbox maintains the
            token, and {label} reads it from <code>{manual.file}</code>.
          </small>
          <span className="ui-cloud-create-spacer" />
          {saved.has(manual.name) ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                removeCredential(
                  manual.name,
                  { title: "Disconnect custom provider?", body: `Cloud workspaces will go back to running ${label} on its own credentials.` },
                  `Stopped using manual setup for ${label}.`,
                )
              }
            >
              Disconnect
            </Button>
          ) : (
            <Button size="xs" variant="ghost" onClick={() => saveCredential(manual.name, "1", `Using manual setup for ${label}.`)}>
              Use
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
