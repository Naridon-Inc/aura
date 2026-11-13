// The rows under "AI available to fill in reasons": every coding agent
// already installed, then a local model and each kind of API key. A row
// that is reachable can be picked; one that isn't says so and offers
// nothing to press.

import type { BackendDetection } from "../../../lib/api";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { SettingsActions } from "../../ui/settings-blocks";
import { SettingsRow } from "../../ui/settings-row";

interface Backend {
  selector: string;
  label: string;
  hint: string;
  ok: boolean;
  active: boolean;
}

function backendsOf(d: BackendDetection | null): Backend[] {
  const agents = (d?.agent_clis ?? []).map((a) => ({
    selector: `agent:${a.kind}`,
    label: a.label,
    hint: "Already installed. No setup.",
    ok: true,
    active: d?.active === "agent_cli" && d?.active_agent_kind === a.kind,
  }));
  const key = (selector: "anthropic" | "openai" | "gemini" | "mercury", label: string) => ({
    selector,
    label,
    hint: "Uses the key already on this machine.",
    ok: !!d?.[selector],
    active: d?.active === selector,
  });
  return [
    ...agents,
    {
      selector: "ollama",
      label: "Ollama",
      hint: "A local model on your machine.",
      ok: !!d?.ollama,
      active: d?.active === "ollama",
    },
    key("anthropic", "Anthropic key"),
    key("openai", "OpenAI key"),
    key("gemini", "Gemini key"),
    key("mercury", "Mercury key"),
  ];
}

export function BackendRows({
  detection,
  pref,
  busy,
  onSelect,
}: {
  detection: BackendDetection | null;
  pref: string | null;
  busy: boolean;
  onSelect: (selector: string) => void;
}) {
  return (
    <>
      {backendsOf(detection).map((b) => (
        <SettingsRow
          key={b.selector}
          title={b.label}
          description={b.ok ? b.hint : "Not found on this machine."}
          control={
            b.ok ? (
              <SettingsActions>
                {b.active && <Badge variant="secondary">In use</Badge>}
                {pref === b.selector ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSelect(b.selector)}>
                    Let Aura pick
                  </Button>
                ) : b.active ? null : (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => onSelect(b.selector)}>
                    Use
                  </Button>
                )}
              </SettingsActions>
            ) : undefined
          }
        />
      ))}
    </>
  );
}
