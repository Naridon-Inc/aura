// The models a member's cloud workspaces can run: the models of each agent
// the member has signed in for the cloud, named the way the local composer
// names them — the catalog's label, under the agent it runs through.
//
// Nothing here comes from a server table. An agent the member hasn't
// connected lists nothing; with none connected the list is empty and each
// surface offers Set up an agent instead of a picker. The one exception is a
// workspace one of the team's computers answers by itself for somebody else:
// it runs on its starter's sign-in, so a teammate is never asked to set up
// their own agent to send there.

import { createElement, useMemo } from "react";

import type { BrainChoice, ModelCatalog } from "../../lib/api";
import {
  connectedHarnesses,
  harnessSpec,
  HARNESSES,
  useAgentCredentials,
  type Harness,
} from "../../lib/cloudAgentCredentials";
import { catalogFor, familyOf, modelBrandId } from "../../lib/modelCatalog";
import { useLiveModelCatalog } from "../chat/model/catalogHooks";
import { AgentIcon } from "../ui/agent-icon";
import type { ModelOption, ModelSelection } from "../ui/model-picker";

/** The catalog's brain for an agent: the same CLI wrapper the local
 *  composer reads, so the rows carry the same names. */
function brainOf(harness: Harness): BrainChoice {
  return {
    id: `cli_wrapper:${harness}`,
    label: harnessSpec(harness)?.label ?? harness,
    kind: "cli_wrapper",
    active: true,
    requires_api_key: false,
    has_api_key: true,
  };
}

/** One agent's models. A row without an id ("Default") runs on whatever the
 *  agent picks, so it is sent as the agent's name. The 1M rows share their
 *  model's id and are left to the agent. */
export function harnessModels(harness: Harness, live?: ModelCatalog | null): ModelOption[] {
  const brain = brainOf(harness);
  const family = familyOf(brain);
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const row of catalogFor(brain, live)) {
    if (row.longContext) continue;
    const id = row.id ?? harness;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: row.label,
      provider: brain.label,
      icon: createElement(AgentIcon, { provider: modelBrandId(family, brain.id, row) }),
    });
  }
  return out;
}

/** Every connected agent's models, agents in their setup order. */
export function cloudModelOptions(
  connected: ReadonlySet<Harness>,
  live?: ModelCatalog | null,
): ModelOption[] {
  return HARNESSES.filter((h) => connected.has(h.id)).flatMap((h) => harnessModels(h.id, live));
}

/** The connected agents, or just `only` when it is one of them. */
export function harnessesFor(connected: ReadonlySet<Harness>, only?: Harness): ReadonlySet<Harness> {
  if (!only) return connected;
  return new Set(connected.has(only) ? [only] : []);
}

/** The agents a picker lists. `startersOwn`: the turns run on somebody
 *  else's sign-in (whoever started the workspace), so `only`'s models are
 *  listed whether or not you connected that agent yourself. */
export function pickerHarnesses(
  connected: ReadonlySet<Harness>,
  only?: Harness,
  startersOwn = false,
): ReadonlySet<Harness> {
  if (only && startersOwn) return new Set([only]);
  return harnessesFor(connected, only);
}

/** The member's cloud models. `only` narrows them to one agent's: a workspace
 *  one of the org's machines answers runs Claude there, so its picker lists
 *  Claude's models and nothing it couldn't run. `startersOwn`: see
 *  {@link pickerHarnesses}. */
export function useCloudModels(
  only?: Harness,
  startersOwn = false,
): { models: ModelOption[]; model: ModelSelection; loaded: boolean } {
  const { credentials, loaded } = useAgentCredentials();
  const connected = useMemo(
    () => pickerHarnesses(connectedHarnesses(credentials), only, startersOwn),
    [credentials, only, startersOwn],
  );
  const live = useLiveModelCatalog(connected.size > 0);
  const models = useMemo(() => cloudModelOptions(connected, live), [connected, live]);
  return { models, model: { model: models[0]?.id ?? "" }, loaded };
}
