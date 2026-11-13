// How one agent signs in for the member's cloud workspaces. Opened from the
// Agents step of setup and from cloud settings.
//
// An agent with a subscription gets one button: this computer runs its
// sign-in, the member finishes in their browser, and it is saved — nothing to
// copy or paste. An API key, a custom provider or manual setup sit behind a
// quiet "Use an API key instead". A value goes up once; what comes back is
// that it's saved (and, for a ChatGPT plan, who it signed in as), never what
// it was.

import { useEffect, useState } from "react";
import { ArrowUpRight, ChevronRight } from "lucide-react";

import {
  accountHint,
  agentCredentialsApi,
  agentsUnavailable,
  CUSTOM_PROVIDERS,
  credentialLabel,
  harnessSpec,
  MANUAL,
  reloadAgentCredentials,
  useAgentCredentials,
  type Harness,
  type HarnessSpec,
} from "../../lib/cloudAgentCredentials";
import { canSignIn, signInLine, signInRunning } from "../../lib/cloudAgentSignIn";
import { cloudProblem } from "../../lib/cloudWorkspacesApi";
import { openExternal } from "../../lib/openExternal";
import { toast } from "../../lib/toast";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { CloudAgentProviders } from "./CloudAgentProviders";
import { SignInProgress, useAgentSignIn, type AgentSignIn } from "./CloudAgentSignIn";
import { removeCredential, SavedRow, saveCredential, SecretField } from "./cloudAgentParts";
import "./cloud-agent.css";

type KeyMethod = "API key" | "Custom provider";

export function CloudAgentDialog({ harness, onClose }: { harness: Harness | null; onClose: () => void }) {
  const spec = harness ? harnessSpec(harness) : undefined;
  const { credentials, selections, error } = useAgentCredentials();
  const quiet = agentsUnavailable(error);
  const saved = new Set(credentials.filter((c) => !c.workspace_id).map((c) => c.name));
  const providers = harness ? CUSTOM_PROVIDERS.filter((p) => p.harnesses.includes(harness)) : [];
  const manual = harness ? MANUAL[harness] : undefined;
  const customSaved = providers.some((p) => saved.has(p.name)) || (!!manual && saved.has(manual.name));
  const chosen = selections.find((s) => s.harness === harness)?.selection;
  const subSaved = !!spec?.subscription && saved.has(spec.subscription);
  const keySaved = !!spec && saved.has(spec.apiKey);
  const account = accountHint(credentials.find((c) => c.name === spec?.subscription && !c.workspace_id));
  const signIn = useAgentSignIn(harness && spec?.subscription && canSignIn(harness) ? harness : null);
  const [keysOpen, setKeysOpen] = useState(false),
    [keyMethod, setKeyMethod] = useState<KeyMethod>("API key"),
    [replacing, setReplacing] = useState(false);

  useEffect(() => {
    if (!spec) return;
    setReplacing(false);
    setKeyMethod(customSaved ? "Custom provider" : "API key");
    setKeysOpen(!subSaved && (keySaved || customSaved));
    // Open on what the agent runs on now; later saves don't move it.
  }, [harness]);

  // No CLI on this computer: the key is the way in, so show it.
  const missingCli = !!signIn.status?.missingCli;
  useEffect(() => {
    if (missingCli) setKeysOpen(true);
  }, [missingCli]);

  // A finished sign-in is saved by the time it says so: refresh what every
  // surface reads, and run on it if a key was in use before.
  const phase = signIn.status?.phase;
  useEffect(() => {
    if (phase !== "connected" || !spec?.subscription) return;
    let stale = false;
    const account = signIn.status?.account;
    void (async () => {
      toast.success(account ? `${spec.label} connected as ${account}.` : `${spec.label} connected.`);
      if (keySaved && chosen !== "subscription")
        await agentCredentialsApi.select(spec.id, "subscription").catch(() => undefined);
      await reloadAgentCredentials();
      if (!stale) signIn.reset();
    })();
    return () => {
      stale = true;
    };
  }, [phase]);

  if (!spec) return null;

  const uses = async (selection: "subscription" | "api_key") => {
    if (chosen === selection) return;
    try {
      await agentCredentialsApi.select(spec.id, selection);
      toast.success(`Cloud workspaces now run ${spec.label} on your ${selection === "subscription" ? spec.plan : "API key"}.`);
      await reloadAgentCredentials();
    } catch (e) {
      toast.danger(`Could not switch ${spec.label}.`, cloudProblem(e).message);
    }
  };

  const keys = (
    <div className="ui-cloud-agent-keys">
      {(providers.length > 0 || !!manual) && (
        <div className="ui-cloud-segments" role="radiogroup" aria-label={`${spec.label} key`}>
          {(["API key", "Custom provider"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={keyMethod === m} aria-pressed={keyMethod === m} onClick={() => setKeyMethod(m)}>
              {m}
            </button>
          ))}
        </div>
      )}
      {keyMethod === "API key" ? (
        <ApiKey spec={spec} saved={keySaved} replacing={replacing} setReplacing={setReplacing} customSaved={customSaved} />
      ) : (
        <CloudAgentProviders harness={spec.id} label={spec.label} saved={saved} />
      )}
    </div>
  );

  return (
    <Dialog open={!!harness} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="ui-cloud-agent-dialog">
        <DialogTitle>{spec.label}</DialogTitle>
        <DialogDescription>
          {spec.plan
            ? `Sign in once and your cloud workspaces run ${spec.label} on your ${spec.plan}.`
            : `Your cloud workspaces run ${spec.label} on your API key.`}
        </DialogDescription>
        {quiet ? (
          <p className="ui-cloud-agent-quiet">{quiet}</p>
        ) : spec.subscription ? (
          <>
            <Plan
              spec={spec}
              signIn={signIn}
              saved={subSaved}
              account={account}
              note={customSaved ? "Custom provider takes precedence" : undefined}
            />
            {subSaved && keySaved && !customSaved && !signIn.status && (
              <div className="ui-cloud-agent-uses">
                <span>Cloud workspaces use</span>
                <div className="ui-cloud-segments" role="radiogroup" aria-label={`What ${spec.label} runs on`}>
                  {(["subscription", "api_key"] as const).map((s) => {
                    const on = (chosen ?? "api_key") === s;
                    return (
                      <button key={s} role="radio" aria-checked={on} aria-pressed={on} onClick={() => void uses(s)}>
                        {s === "subscription" ? spec.plan : "API key"}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <Button
              size="xs"
              variant="ghost"
              className="ui-cloud-agent-disclosure"
              aria-expanded={keysOpen}
              onClick={() => setKeysOpen((o) => !o)}
            >
              <ChevronRight /> Use an API key instead
            </Button>
            {keysOpen && keys}
          </>
        ) : (
          keys
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The subscription: one Connect button, the sign-in while it runs, or the
 *  saved sign-in with Reconnect and Disconnect. */
function Plan({
  spec,
  signIn,
  saved,
  account,
  note,
}: {
  spec: HarnessSpec;
  signIn: AgentSignIn;
  saved: boolean;
  /** Who it signed in as, when the sign-in says. */
  account: string | null;
  note?: string;
}) {
  const sub = spec.subscription!;
  const s = signIn.status;
  if (s && (signInRunning(s.phase) || s.phase === "connected"))
    return <SignInProgress status={s} onCancel={() => void signIn.cancel()} onCode={signIn.sendCode} />;
  if (s?.phase === "failed")
    return (
      <div className="ui-cloud-agent-signin">
        <p className="ui-cloud-agent-error" role="alert">
          {signInLine(s)}
        </p>
        <div className="ui-cloud-agent-actions">
          <Button size="sm" variant={s.missingCli ? "outline" : "default"} onClick={() => void signIn.start()}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={signIn.reset}>
            Close
          </Button>
        </div>
      </div>
    );
  if (saved)
    return (
      <SavedRow
        label={credentialLabel(sub)}
        credential={account ? undefined : sub}
        note={note ?? (account ? `Signed in as ${account}` : undefined)}
        replaceLabel="Reconnect"
        onReplace={() => void signIn.start()}
        onDisconnect={() =>
          removeCredential(
            sub,
            {
              title: `Disconnect your ${spec.plan}?`,
              body: `Cloud workspaces will stop running ${spec.label} on your ${spec.plan}.`,
            },
            `Removed ${credentialLabel(sub)}.`,
          )
        }
      />
    );
  return (
    <div className="ui-cloud-agent-connect">
      <Button onClick={() => void signIn.start()}>Connect {spec.plan}</Button>
      <small>Opens your browser to finish signing in.</small>
    </div>
  );
}

/** The agent's own API key: saved with Replace and Disconnect, or the field. */
function ApiKey({
  spec,
  saved,
  replacing,
  setReplacing,
  customSaved,
}: {
  spec: HarnessSpec;
  saved: boolean;
  replacing: boolean;
  setReplacing: (r: boolean) => void;
  customSaved: boolean;
}) {
  if (saved && !replacing)
    return (
      <SavedRow
        label={credentialLabel(spec.apiKey)}
        credential={spec.apiKey}
        note={customSaved ? "Custom provider takes precedence" : undefined}
        onReplace={() => setReplacing(true)}
        onDisconnect={() =>
          removeCredential(
            spec.apiKey,
            {
              title: "Disconnect API key?",
              body: `Cloud workspaces will stop running ${spec.label} on this API key.`,
            },
            `Removed ${credentialLabel(spec.apiKey)}.`,
          )
        }
      />
    );
  return (
    <SecretField
      label={credentialLabel(spec.apiKey)}
      placeholder={spec.apiKeyPlaceholder}
      action={
        <Button type="button" size="xs" variant="ghost" onClick={() => void openExternal(spec.createKeyUrl)}>
          Get key <ArrowUpRight />
        </Button>
      }
      onSave={async (v) => {
        const ok = await saveCredential(spec.apiKey, v, `Saved ${credentialLabel(spec.apiKey)}.`);
        if (ok) setReplacing(false);
        return ok;
      }}
    />
  );
}
