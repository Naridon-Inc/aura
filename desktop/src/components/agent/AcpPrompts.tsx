// The cards an ACP agent can raise mid-turn beyond a tool permission: a
// sign-in, a form it needs filled, and a link it wants opened. Each answers
// through the same prompt store as every permission, so the backend gate
// (`chat_acp_prompts.rs`) is the only place a reply turns into protocol.

import { useState } from "react";
import { QuestionFlow, type FlowQuestion } from "../chat/QuestionFlow";
import { PermissionRequest } from "../ui/chat-decisions";
import { Button } from "../ui/button";
import type { PermissionPrompt } from "../../lib/api";
import { useEditorStore } from "../../lib/editorStore";
import { decidePrompt } from "../../lib/permissionStore";

/** Tool names the ACP gate uses for its non-permission cards. */
export const ACP_PROMPT_TOOLS = new Set(["AcpSignIn", "AcpElicitation", "AcpOpenUrl"]);

type Field = {
  name: string;
  title?: string | null;
  description?: string | null;
  required?: boolean;
  kind: "text" | "number" | "boolean" | "choice";
  options?: { value: string; label: string }[];
  multi?: boolean;
};

type SignInMethod = {
  id: string;
  name: string;
  description?: string | null;
  terminal: boolean;
  command?: string | null;
  blocked_env?: string[];
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** A form field as one step of the question flow. */
export function fieldQuestion(f: Field): FlowQuestion {
  const label = f.title || f.name;
  const prompt = [label + (f.required ? "" : " (optional)"), f.description].filter(Boolean).join(" — ");
  if (f.kind === "choice")
    return { id: f.name, prompt, multiple: !!f.multi, options: (f.options ?? []).map(o => ({ id: o.value, label: o.label })) };
  if (f.kind === "boolean")
    return { id: f.name, prompt, options: [{ id: "true", label: "Yes" }, { id: "false", label: "No" }] };
  return { id: f.name, prompt, options: [], freeText: true };
}

function useAnswer(promptId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (decision: "allow" | "deny", input?: unknown) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await decidePrompt(promptId, decision, input);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return { busy, error, answer };
}

function FormCard({ prompt, docked }: { prompt: PermissionPrompt; docked: boolean }) {
  const input = obj(prompt.input);
  const fields = (Array.isArray(input.fields) ? input.fields : []) as Field[];
  const message = String(input.message ?? "");
  const problem = typeof input.error === "string" ? input.error : null;
  const { busy, error, answer } = useAnswer(prompt.prompt_id);
  if (!fields.length)
    return <PermissionRequest className={docked ? "chat-question-request is-docked" : undefined} title={message || "The agent asks you to confirm"} pending={busy}
      choices={[{ id: "deny", label: "Decline" }, { id: "allow", label: "Accept", primary: true }]}
      onChoose={id => void answer(id === "allow" ? "allow" : "deny", { _acp_answers: [] })}>
      {error && <p role="alert" className="chat-question-error">{error}</p>}
    </PermissionRequest>;
  return <>
    {(problem || error) && <p role="alert" className="chat-question-error">{problem ?? error}</p>}
    <QuestionFlow key={`${prompt.prompt_id}:${problem ?? ""}`} docked={docked} title={message || "The agent needs a few details"} submitLabel="Send"
      questions={fields.map(fieldQuestion)}
      onSubmit={async replies => {
        await decidePrompt(prompt.prompt_id, "allow", {
          _acp_answers: fields.map((f, i) => ({ name: f.name, selected: replies[i]?.selected ?? [], text: replies[i]?.text ?? "" })),
        });
      }} />
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void answer("deny")}>Decline</Button>
  </>;
}

function OpenUrlCard({ prompt, docked }: { prompt: PermissionPrompt; docked: boolean }) {
  const input = obj(prompt.input);
  const url = String(input.url ?? "");
  const host = String(input.host ?? "");
  const suspicious = input.suspicious === true;
  const { busy, error, answer } = useAnswer(prompt.prompt_id);
  return <PermissionRequest className={docked ? "chat-question-request is-docked" : undefined} title="Open a page in your browser" pending={busy}
    description={String(input.message ?? "") || undefined} command={url}
    choices={[{ id: "deny", label: "Don't open" }, { id: "allow", label: `Open ${host || "link"}`, primary: !suspicious }]}
    onChoose={id => void answer(id === "allow" ? "allow" : "deny")}>
    {suspicious && <p role="alert" className="chat-question-error">This address looks unusual. Check the host before you open it: {host}</p>}
    {error && <p role="alert" className="chat-question-error">{error}</p>}
  </PermissionRequest>;
}

function SignInCard({ prompt, docked, repoRoot }: { prompt: PermissionPrompt; docked: boolean; repoRoot: string }) {
  const store = useEditorStore();
  const input = obj(prompt.input);
  const agent = String(input.agent ?? "the agent");
  const methods = (Array.isArray(input.methods) ? input.methods : []) as SignInMethod[];
  const { busy, error, answer } = useAnswer(prompt.prompt_id);
  const held = [...new Set(methods.flatMap(m => (m.terminal ? m.blocked_env ?? [] : [])))];
  const choose = (id: string) => {
    const method = methods.find(m => m.id === id);
    if (!method) return void answer("deny");
    if (method.terminal && method.command)
      store.openTerminal(repoRoot, { bootCommand: method.command, label: `Sign in to ${agent}` });
    void answer("allow", { _acp_method_id: method.id });
  };
  return <PermissionRequest className={docked ? "chat-question-request is-docked" : undefined} title={`Sign in to ${agent}`} pending={busy}
    description={String(input.detail ?? "") || undefined}
    choices={[{ id: "__decline", label: "Not now" }, ...methods.map((m, i) => ({ id: m.id, label: m.terminal ? `${m.name} in Terminal` : m.name, description: m.description ?? undefined, primary: i === 0 }))]}
    onChoose={choose}>
    {held.length > 0 && <p className="chat-question-note">Aura does not pass {held.join(", ")} to a sign-in it starts. Set it in that terminal if the sign-in needs it.</p>}
    {error && <p role="alert" className="chat-question-error">{error}</p>}
  </PermissionRequest>;
}

/** The card for one ACP prompt, or null when the prompt is not one of them. */
export function AcpPrompt({ prompt, docked, repoRoot }: { prompt: PermissionPrompt; docked: boolean; repoRoot: string }) {
  const card = prompt.tool_name === "AcpSignIn"
    ? <SignInCard prompt={prompt} docked={docked} repoRoot={repoRoot} />
    : prompt.tool_name === "AcpOpenUrl"
      ? <OpenUrlCard prompt={prompt} docked={docked} />
      : prompt.tool_name === "AcpElicitation"
        ? <FormCard prompt={prompt} docked={docked} />
        : null;
  return card && <div className="chat-controls">{card}</div>;
}
