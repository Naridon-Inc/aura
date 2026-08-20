// "When I make a parallel copy, open…" — the one control behind
// `[workspace] open_in`.
//
// Global, not per-project: which tool you reach for is a fact about you, not
// about a repo. It therefore sits ABOVE the "open a project first" gate in the
// Copies pane, so it can be changed with no project loaded — the state someone
// is most likely in the first time they go looking for it.
//
// The agent entries are the CLIs actually installed on this machine, read from
// `agents_list`. Offering Codex to someone who doesn't have it would be a
// setting that silently does nothing, and the resolver would send them back to
// "Just the code" anyway.

import { useEffect, useState } from "react";

import { api, type AgentDescriptor } from "../../lib/api";
import { setWorkspaceOpenIn, useWorkspacePrefs } from "../../lib/settingsStore";
import { LANDING_CHAT, LANDING_CODE } from "../../lib/workspaceLanding";
import { Row, Section, SelectField } from "./kit";

export function WorkspaceLandingRow() {
  const prefs = useWorkspacePrefs();
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .agentsList()
      .then((list) => {
        if (alive) setAgents(list.filter((a) => a.available));
      })
      .catch(() => {
        // Enumeration failed — the two built-in choices still work, and the
        // resolver already treats an un-listable agent as "Just the code".
      });
    return () => {
      alive = false;
    };
  }, []);

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
    <Section title="New parallel copies">
      <Row
        label="When a copy opens"
        description="A parallel copy is a second checkout of this project you can work in without disturbing the first. This is what Aura opens in it once it's ready."
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
          widthClass="min-w-[200px]"
        />
      </Row>
    </Section>
  );
}
