// The agents a member connects for the cloud, opened from anywhere in the
// cloud place: Set up an agent in the create dialog or a workspace's
// composer, and Connect on the setup page's Agents step.
//
// Opened with an agent, it goes straight to that agent's sign-in; opened
// without one, it lists the agents first.

import { useEffect, useState } from "react";
import { ArrowUpRight, Check, Settings } from "lucide-react";

import {
  agentsUnavailable,
  connectedHarnesses,
  HARNESSES,
  useAgentCredentials,
  type Harness,
} from "../../lib/cloudAgentCredentials";
import { AgentIcon } from "../ui/agent-icon";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { CloudAgentDialog } from "./CloudAgentDialog";

const EVENT = "aura:cloud-agents";

/** Open the agents list, or one agent's sign-in. */
export function openCloudAgents(harness?: Harness): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { harness: harness ?? null } }));
}

/** What a model picker shows when no agent is connected. */
export function SetUpCloudAgentButton() {
  return (
    <Button type="button" variant="outline" size="sm" title="No agent set up yet." onClick={() => openCloudAgents()}>
      <Settings style={{ width: 12, height: 12 }} />
      Set up an agent
    </Button>
  );
}

export function CloudAgentsHost() {
  const [list, setList] = useState(false),
    [harness, setHarness] = useState<Harness | null>(null);
  const { credentials, error } = useAgentCredentials();
  const connected = connectedHarnesses(credentials);
  const quiet = agentsUnavailable(error);

  useEffect(() => {
    const on = (e: Event) => {
      const h = (e as CustomEvent<{ harness: Harness | null }>).detail?.harness ?? null;
      setHarness(h);
      setList(!h);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);

  return (
    <>
      <Dialog open={list && !harness} onOpenChange={(open) => !open && setList(false)}>
        <DialogContent className="ui-cloud-agent-dialog">
          <DialogTitle>Agents</DialogTitle>
          <DialogDescription>Add your favorite agents to your computer.</DialogDescription>
          {quiet ? (
            <p className="ui-cloud-agent-quiet">{quiet}</p>
          ) : (
          <div className="ui-cloud-agent-providers">
            {HARNESSES.map((h) => (
              <button key={h.id} className="ui-cloud-row" onClick={() => setHarness(h.id)}>
                <AgentIcon provider={h.provider} />
                <span>{h.label}</span>
                <span className="ui-cloud-create-spacer" />
                {connected.has(h.id) ? (
                  <small>
                    Connected <Check size={14} />
                  </small>
                ) : (
                  <small>
                    Connect <ArrowUpRight size={14} />
                  </small>
                )}
              </button>
            ))}
          </div>
          )}
        </DialogContent>
      </Dialog>
      <CloudAgentDialog harness={harness} onClose={() => setHarness(null)} />
    </>
  );
}
