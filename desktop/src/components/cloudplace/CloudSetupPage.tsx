// Cloud setup: the library's setup steps over the organization as it is.
//
// The computer is the org's real machine — a runner online for it. The
// agents are the member's own: an agent is connected once the member has
// signed it in for the cloud, and Connect opens that sign-in. Nothing here
// is built or connected by a timer; where the org has no machine, the two
// real ways to get one are offered: having one made, when the server will,
// or connecting a box you already have — and, beside them, the one Aura runs
// for the team, which comes with Pro and Teams.
//
// The machines are read every fifteen seconds; Aura's computer is not. It is
// read once and shared with every other screen showing it, and again only
// while it is moving (useAuraComputer).

import { useCallback, useEffect, useMemo, useState } from "react";

import { api, type CloudRunner, type PlaceMakeOffer, type PlaceRow } from "../../lib/api";
import { auraComputerWake, dozing, settingUp, stepLine, upgradeLabel, upgradePlan } from "../../lib/auraComputer";
import { connectedHarnesses, HARNESSES, useAgentCredentials } from "../../lib/cloudAgentCredentials";
import { cloudProblem, ownerOf } from "../../lib/cloudWorkspacesApi";
import { setCloudCreating, setCloudDefaultRepo, setCloudPage } from "../../lib/cloudPlace";
import { putAuraComputer, useAuraComputer } from "../../lib/useAuraComputer";
import { AddComputer } from "../commons/crew/AddComputer";
import { ConnectMachineWizard } from "../commons/crew/ConnectMachineWizard";
import { GetComputerWizard } from "../commons/crew/GetComputerWizard";
import { MakePlaceWizard } from "../commons/crew/MakePlaceWizard";
import { CloudOnboarding, type CloudSetupLive } from "../ui/cloud-onboarding";
import { openCloudAgents } from "./CloudAgentsHost";
import { reloadCloudPlace, valueOf, type CloudPlaceData, type Read } from "./cloudPlaceStore";
import { githubButton } from "./cloudSetupGithub";
import { useConnectGithub } from "../settings/org/useConnectGithub";
import type { CloudRows } from "./useCloudRows";

const POLL_MS = 15_000;

/** Aura made this runner's machine: the place holding the runner is one Aura
 *  can switch off, which only a machine it made ever is. */
function madeByAura(runner: CloudRunner, places: readonly PlaceRow[]): boolean {
  return places.some(
    (p) =>
      p.runner_id === runner.id &&
      !!p.machine &&
      (p.machine.box_kind === "managed" || !!p.machine.instance_id?.trim()),
  );
}

function openSettings(pane: string) {
  window.dispatchEvent(new CustomEvent("aura:open-settings", { detail: { pane } }));
}

export function CloudSetupPage({
  repoRoot,
  data,
  rows,
}: {
  repoRoot: string;
  data: CloudPlaceData;
  rows: CloudRows;
}) {
  const [runners, setRunners] = useState<Read<CloudRunner[]>>({ state: "loading" });
  const [offer, setOffer] = useState<PlaceMakeOffer | null>(null);
  const [places, setPlaces] = useState<PlaceRow[]>([]);
  const { status: aura, reload: reloadAura } = useAuraComputer();
  // "connect" is the one-line way to add a computer you have; "ssh" is the
  // older address-and-key way, reached from inside it.
  const [wizard, setWizard] = useState<"make" | "connect" | "ssh" | "aura" | null>(null);
  const { credentials } = useAgentCredentials();
  const [connectedNote, setConnectedNote] = useState<string | null>(null);
  const github = useConnectGithub((note) => {
    setConnectedNote(note);
    void reloadCloudPlace();
  });
  const button = githubButton(github.phase, github.connecting !== null);
  const pressGithub = useCallback(() => {
    const { phase } = github;
    if (button.act === "begin") github.begin();
    else if (button.act === "continue" && phase.at === "installing") github.signIn(phase.start);
    else if (button.act === "again" && phase.at === "signing_in") github.reopen(phase.start.authorize_url);
    else if (button.act === "choose") openSettings("organization");
  }, [github, button.act]);

  const load = useCallback(async () => {
    const [r, o, p] = await Promise.all([
      api
        .cloudRunners()
        .then((value): Read<CloudRunner[]> => ({ state: "ready", value }))
        .catch((e): Read<CloudRunner[]> => ({ state: "failed", problem: cloudProblem(e) })),
      api.placeMakeOffer().catch(() => null),
      api
        .placesList()
        .then((x) => x.places)
        .catch(() => [] as PlaceRow[]),
    ]);
    setRunners(r);
    setOffer(o);
    setPlaces(p);
  }, []);
  const loadAll = useCallback(() => {
    void load();
    void reloadAura();
  }, [load, reloadAura]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const live = useMemo<CloudSetupLive>(() => {
    const all = valueOf(runners, []);
    const online = all.filter((r) => r.online);
    const connected = connectedHarnesses(credentials);
    const agents = HARNESSES.map((h) => ({ name: h.label, provider: h.provider, connected: connected.has(h.id) }));

    const connect = { label: "Connect a machine", onClick: () => setWizard("connect") };
    // The plan's computer: what the plan includes, or the plan to move to for one.
    const upgrade = upgradePlan(aura?.offer ?? null);
    const getOne = {
      label: upgrade ? `${upgradeLabel(upgrade)} for a computer` : "Use the computer your plan includes",
      onClick: () => setWizard("aura"),
    };
    const bought = aura?.computer ?? null;
    let computer: CloudSetupLive["computer"];
    if (runners.state === "loading" && !bought)
      computer = { state: "building", label: "Looking for your organization’s computer…" };
    else if (online.length)
      computer = {
        state: "ready",
        label: `Your computer is ready · ${online[0].name}`,
        managed: madeByAura(online[0], places) || bought?.place_id === online[0].id,
      };
    else if (bought?.stage === "ready")
      // Aura's computer says it is ready before the runner list catches up.
      computer = { state: "ready", label: `Your computer is ready · ${bought.name}`, managed: true };
    else if (bought && settingUp(bought))
      computer = {
        state: "building",
        label: bought.headline,
        detail: stepLine(bought) ?? undefined,
        actions: [{ label: "Show progress", onClick: () => setWizard("aura") }],
      };
    else if (bought && dozing(bought))
      // Asleep is ready: the first chat to it wakes it. One resting until the
      // 1st says so in its problem, and offers no wake.
      computer = {
        state: "ready",
        label: `${bought.name} · ${bought.headline}`,
        detail: bought.problem ?? undefined,
        managed: true,
        actions: bought.can_wake
          ? [{ label: "Wake it now", onClick: () => void auraComputerWake().then(putAuraComputer, loadAll) }]
          : [],
      };
    else if (bought?.stage === "failed")
      computer = {
        state: "failed",
        label: `${bought.name} didn’t come up`,
        detail: bought.problem ?? undefined,
        actions: [{ label: "See what happened", onClick: () => setWizard("aura") }, connect],
      };
    else if (runners.state === "failed")
      computer = {
        state: "failed",
        label: "Couldn’t read your organization’s machines",
        detail: runners.problem.message,
        actions: [{ label: "Try again", onClick: loadAll }],
      };
    else if (runners.state === "loading")
      computer = { state: "building", label: "Looking for your organization’s computer…" };
    else if (all.length)
      computer = {
        state: "failed",
        label: `${all[0].name} is offline`,
        detail: "Start Aura on it again, or connect another machine.",
        actions: [connect],
      };
    else
      computer = {
        state: "missing",
        label: "Your organization has no cloud computer yet",
        detail: offer && !offer.can_make ? offer.blocked || undefined : undefined,
        actions: [
          ...(aura?.offer ? [getOne] : []),
          ...(offer?.can_make ? [{ label: "Make a cloud computer", onClick: () => setWizard("make") }] : []),
          connect,
        ],
      };

    const repos = valueOf(data.repos, []).map((r) => r.full_name);
    const byId = new Map(rows.members.map((m) => [m.id, m]));
    const presence = valueOf(data.workspaces, [])
      .filter((w) => w.status === "running" && byId.has(ownerOf(w) ?? ""))
      .slice(0, 3)
      .map((w) => {
        const m = byId.get(ownerOf(w)!)!;
        const what = w.objective?.split("\n")[0].trim();
        return {
          id: w.id,
          name: m.name,
          initials: m.initials,
          color: m.color,
          photo: m.photo,
          doing: what ? `${m.name} is working on ${what}` : `${m.name} is working in the cloud`,
        };
      });

    return {
      orgName: data.orgName || "Your organization",
      presence,
      repositories: data.repos.state === "ready" && repos.length ? repos : null,
      connectGithubLabel: button.label,
      onConnectGithub: button.act ? pressGithub : undefined,
      repositoryNote:
        github.error ??
        button.note ??
        (repos.length ? null : connectedNote) ??
        "Workspaces start on one repository. The first you pick is where Create starts.",
      agents,
      onConnectAgent: (name) => openCloudAgents(HARNESSES.find((h) => h.label === name)?.id),
      computer,
      onComputerDetails: () => openSettings("cloud"),
    };
  }, [runners, offer, places, aura, data, rows.members, loadAll, credentials, button, pressGithub, github.error, connectedNote]);

  return (
    <>
      <CloudOnboarding
        live={live}
        onFinish={(result) => {
          setCloudDefaultRepo(result.repositories[0] ?? null);
          setCloudPage("home");
          // Straight on to the first chat: Finish leads to what the agent should do.
          setCloudCreating(true);
        }}
      />
      {wizard === "make" && (
        <MakePlaceWizard
          places={places}
          onClose={() => setWizard(null)}
          onMade={() => void load()}
          onConnectInstead={() => setWizard("connect")}
        />
      )}
      {wizard === "aura" && (
        <GetComputerWizard
          onClose={() => setWizard(null)}
          onReady={loadAll}
          onConnectInstead={() => setWizard("connect")}
        />
      )}
      {wizard === "connect" && (
        <AddComputer
          initial="own"
          onClose={() => setWizard(null)}
          onGetOne={() => setWizard("aura")}
          onSsh={() => setWizard("ssh")}
          onConnected={() => void load()}
        />
      )}
      {wizard === "ssh" && (
        <ConnectMachineWizard
          repoRoot={repoRoot}
          onClose={() => setWizard(null)}
          onOnline={() => void load()}
        />
      )}
    </>
  );
}
