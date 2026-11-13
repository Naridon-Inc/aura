// Overview — the landing of the customization surface. Two things: a single
// "tell the agent what you want" box (describe a change in plain English and a
// real agent goes and makes it), and a grid of cards that show, at a glance,
// what's set up — how many agents are ready, which connections exist, whether
// the safety net is on — each a doorway into its section. It is a settings
// page: the page title and intro, the ask box as the library's textarea and
// button, and each section as a settings row with its count and an Open.

import { useState, type ReactNode } from "react";
import { ArrowRight, CornerDownLeft } from "lucide-react";

import type { Agent } from "../../../lib/agents";
import type { CustomizeNavItem, CustomizeStores } from "./customizeShared";
import { instructionCount } from "./customizeShared";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { SettingsIntro } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { Textarea } from "../../ui/textarea";
import "../../ui/customize-overview.css";

export function OverviewPane({
  nav,
  agents,
  stores,
  onNavigate,
  onClose,
}: {
  /** The category items (Overview excluded) rendered as rows. */
  nav: CustomizeNavItem[];
  agents: Agent[];
  stores: CustomizeStores;
  onNavigate: (id: CustomizeNavItem["id"]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const target = agents.find((a) => a.available) ?? null;

  // Hand the request to a real agent through the normal launcher, then close
  // so the user lands on the running session. No agent installed → the box is
  // disabled with a hint, so this only fires when there's someone to do it.
  const submit = () => {
    const text = draft.trim();
    if (!text || !target) return;
    window.dispatchEvent(
      new CustomEvent("aura:run-agent-preset", {
        detail: { agentId: target.id, agentLabel: target.label, prompt: text },
      }),
    );
    onClose();
  };

  return (
    <div className="ui-customize-overview">
      <div className="ui-settings-page">
        <h1>Customize your agent</h1>
        <SettingsIntro>
          Tell it what you want in plain words, or set things up by hand below, who does the work,
          what it can reach, and how you stay protected.
        </SettingsIntro>

        <div className="ui-customize-ask" data-disabled={target ? undefined : ""}>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
            rows={2}
            aria-label="What you want the agent to change"
            placeholder={
              target
                ? "e.g. Add a check that runs my tests before every commit"
                : "Install a coding agent to use this"
            }
            disabled={!target}
          />
          <div className="ui-customize-ask-foot">
            <span>{target ? `${target.label} will pick this up` : "No agent installed yet"}</span>
            <Button size="sm" onClick={submit} disabled={!draft.trim() || !target}>
              Send
              <CornerDownLeft />
            </Button>
          </div>
        </div>

        <SettingsSection title="Set it up by hand">
          {nav.map((item) => (
            <SettingsRow
              key={item.id}
              className="ui-customize-row"
              title={
                <span className="ui-customize-row-title">
                  {item.icon}
                  {item.label}
                </span>
              }
              description={item.blurb}
              control={
                <span className="ui-customize-row-control">
                  {cardMeta(item.id, agents, stores)}
                  <Button size="sm" variant="ghost" onClick={() => onNavigate(item.id)}>
                    Open
                    <ArrowRight />
                  </Button>
                </span>
              }
            />
          ))}
        </SettingsSection>
      </div>
    </div>
  );
}

function Count({ children }: { children: ReactNode }) {
  return <Badge variant="secondary">{children}</Badge>;
}

// The live count/status shown on each row — the at-a-glance "what's set up".
function cardMeta(
  id: CustomizeNavItem["id"],
  agents: Agent[],
  stores: CustomizeStores,
): ReactNode {
  switch (id) {
    case "agents": {
      const n = agents.filter((a) => a.available).length;
      return <Count>{n === 1 ? "1 ready" : `${n} ready`}</Count>;
    }
    case "skills": {
      const n = stores.plugins.filter((p) => p.kind === "skill").length;
      return <Count>{n}</Count>;
    }
    case "instructions": {
      const n = instructionCount(stores.memory);
      return <Count>{n === 1 ? "1 rule" : `${n} rules`}</Count>;
    }
    case "hooks":
      return <Count>{stores.capture?.enabled ? "On" : "Off"}</Count>;
    case "mcp":
      return <Count>{stores.mcp.length}</Count>;
    case "addons": {
      // Add-ons are the ADE-native plugins, so installed plugins are the
      // at-a-glance signal.
      const n = stores.plugins.filter((p) => p.kind === "plugin").length;
      return <Count>{n === 1 ? "1 plugin" : `${n} plugins`}</Count>;
    }
    default:
      return null;
  }
}
