// What Resume is about to do, said before it does it: a live agent that uses
// tokens, which conversation, the folder it runs in, and what it carries.

import type { ClaudeSession } from "../../../lib/api";
import { basename } from "../../../lib/paths";
import type { ResumePlan } from "../../../lib/resumePlan";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";

export function ResumeConfirm({
  plan,
  sess,
  dontAsk,
  onDontAsk,
  onCancel,
  onConfirm,
}: {
  plan: ResumePlan;
  sess: ClaudeSession | null;
  dontAsk: boolean;
  onDontAsk: (v: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const turns = sess?.turn_count ?? 0;
  return (
    <div className="ui-resume-confirm">
      <header>
        <strong>{plan.kind === "fresh" ? "Start a new conversation" : "Resume this conversation"}</strong>
        {/* A continuation and a fresh start are different acts and say so.
            Either way this is a real running agent that uses tokens. */}
        <p>
          {plan.headline} It opens as a new terminal tab and you&apos;ll land on it. A live agent,
          using tokens.
        </p>
      </header>
      <dl>
        <div>
          <dt>Conversation</dt>
          <dd>
            {turns} turn{turns === 1 ? "" : "s"}
            {sess?.session_id && <code>{sess.session_id.slice(0, 8)}</code>}
          </dd>
        </div>
        <div>
          {/* The load-bearing confirmation: where it runs, full path on hover. */}
          <dt>Runs in</dt>
          <dd>
            <code title={plan.cwd}>{basename(plan.cwd)}</code>
          </dd>
        </div>
      </dl>
      <p>{plan.carries}</p>
      {plan.warning && <p data-tone="warn">{plan.warning}</p>}
      <footer>
        <label>
          <Checkbox checked={dontAsk} onCheckedChange={(v) => onDontAsk(v === true)} />
          Don&apos;t ask again
        </label>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" onClick={onConfirm}>
          {plan.verb}
        </Button>
      </footer>
    </div>
  );
}
