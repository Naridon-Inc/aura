// "When I make a parallel copy, open…" — the one control behind
// `[workspace] open_in`.
//
// Global, not per-project: which tool you reach for is a fact about you, not
// about a repo. It is shown on each repository's page beside the other
// new-copy settings, and its description says it applies everywhere so
// changing it on one project's page is not a surprise on the next.
//
// The agent entries are the CLIs actually installed on this machine, read from
// `agents_list`. Offering Codex to someone who doesn't have it would be a
// setting that silently does nothing, and the resolver would send them back to
// "Just the code" anyway.

import { useMemo } from "react";

import type { AgentDescriptor } from "../../lib/api";
import { setWorkspaceOpenIn, useWorkspacePrefs } from "../../lib/settingsStore";
import { LANDING_CHAT, LANDING_CODE } from "../../lib/workspaceLanding";
import { Row, SelectField } from "./kit";
import { useAgentsList } from "../../lib/agentsListCache";

export function WorkspaceLandingRow() {
  const prefs = useWorkspacePrefs();
  // When the list can't be read, the two built-in choices still work, and the
  // resolver already treats an un-listable agent as "Just the code".
  const list = useAgentsList();
  const agents = useMemo<AgentDescriptor[]>(
    () => (list.data ?? []).filter((a) => a.available),
    [list.data],
  );

  // A stored agent that isn't installed right now would otherwise render as a
  // blank select — the control would look broken rather than overridden. Show
  // it, marked, so the user can see what the setting says and why it isn't
  // happening.
  const stored = prefs.open_in;
  const missing =
    stored !== LANDING_CODE &&
    stored !== LANDING_CHAT &&
    !agents.some((a) => a.id === stored);

  const options = [
    { value: LANDING_CODE, label: "Just the code" },
    { value: LANDING_CHAT, label: "An Aura chat" },
    ...agents.map((a) => ({ value: a.id, label: a.label })),
    ...(missing ? [{ value: stored, label: `${stored} (not installed)` }] : []),
  ];

  return (
    <Row
      label="When a copy opens"
      description="A parallel copy is a second checkout of this repository you can work in without disturbing the first. This is what Aura opens in it once it's ready, in every repository."
      hint={
        missing
          ? `${stored} isn't on this machine right now, so copies open in the code until it's back.`
          : "Whatever you typed as the objective is carried into the chat or the agent you pick."
      }
    >
      <SelectField
        value={stored}
        onChange={setWorkspaceOpenIn}
        options={options}
      />
    </Row>
  );
}
