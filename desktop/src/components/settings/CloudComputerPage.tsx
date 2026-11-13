// Organization › Cloud computer — the computer your team's cloud work runs on.
//
// First the computer Aura runs for the team, the one the plan includes, as it
// is right now with the month's hours (AuraComputerSection). Then the
// machines connected to the team, configured below.
//
// The library's cloud computer settings, read off a real machine. The machine
// is a box connected under Connected machines below; its repositories are
// what the box says it holds, joined to the rows this laptop's machine book
// keeps for it (`useComputerRepos`); the install software is each repository's
// declared environment (`[env]` in `.aura/settings.toml`); and "Build computer"
// builds the team's environment on the box once, so the next person to join
// starts from a copy of it instead of installing everything again. Under it,
// who on the team may use the team's machines.
//
// What the box cannot do, the page does not offer: a base build cannot be
// cancelled half way or rolled back to an earlier one, so there is no Cancel
// and no Activate. The install software is shown, not edited here — it lives
// in the repository, and editing it is a change to the repository.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Server } from "lucide-react";

import { api, type Machine } from "../../lib/api";
import { onOrgChanged } from "../../lib/cloudOrgs";
import { useAuraComputer } from "../../lib/useAuraComputer";
import { placeOfMachine } from "../../lib/place";
import { askTeamBase, baseWasBuilt, warmStart, type TeamBase } from "../../lib/place/teamBase";
import { AddProject } from "../cloud/BoxAddProject";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import {
  CloudComputerSettings,
  type CloudBuild,
  type CloudComputerConfig,
} from "../ui/cloud-computer";
import { Select } from "../ui/select";
import { SettingsRow } from "../ui/settings-row";
import { EmptyState, ErrorNote, LoadingState } from "../ui/state";
import { AuraComputerSection } from "./AuraComputerSection";
import { CloudAccessSection } from "./CloudAccessSection";
import {
  baseEntry,
  buildLog,
  durationWord,
  envBlock,
  groupComputers,
  installScript,
  placeOfRepo,
  type ComputerRepo,
} from "./cloudComputer";
import type { SettingsLink } from "./nav";
import { useComputerRepos } from "./useComputerRepos";
import "../ui/cloud-patterns.css";
import "../ui/machine-workspace.css";

type BaseRead = { label: string; base: TeamBase | null; error: string | null };

/** Each repository's declared environment, read from its folder on this
 *  laptop. A repository the book has not tied to a folder here shows none; one
 *  only the box holds says it is read over there when it builds. */
function useInstallScript(repos: ComputerRepo[]): string {
  const [script, setScript] = useState("");
  useEffect(() => {
    let alive = true;
    void Promise.all(
      repos.map(async ({ label, row, booked }) => {
        if (!booked) return { label, text: undefined };
        if (!row.project_root) return { label, text: null };
        try {
          const file = await api.readFile(`${row.project_root}/.aura/settings.toml`);
          return { label, text: file.status === "ok" ? envBlock(file.text) || null : null };
        } catch {
          return { label, text: null };
        }
      }),
    ).then((blocks) => {
      if (alive) setScript(installScript(blocks));
    });
    return () => {
      alive = false;
    };
  }, [repos]);
  return script;
}

export function CloudComputerPage({
  go,
  onClose,
}: {
  go: (link: SettingsLink) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Machine[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const hasAuraComputer = !!useAuraComputer().status?.computer;
  const read = useCallback(() => {
    api
      .machinesList()
      .then((r) => {
        setRows(r);
        setReadError(null);
      })
      .catch((e) => {
        setRows([]);
        setReadError(String(e));
      });
  }, []);
  useEffect(() => {
    read();
    return onOrgChanged(read);
  }, [read]);

  const computers = useMemo(() => groupComputers(rows ?? []), [rows]);
  const [key, setKey] = useState<string | null>(null);
  const computer = computers.find((c) => c.key === key) ?? computers[0] ?? null;
  const held = useComputerRepos(computer);
  const repos = held.repos;
  const labels = useMemo(() => repos.map((r) => r.label), [repos]);
  const script = useInstallScript(repos);
  const [cloneError, setCloneError] = useState<string | null>(null);

  // What the computer already holds, asked of the machine per repository —
  // once the box has said which repositories those are, and again only when
  // that list changes rather than every time the box is re-read.
  const [bases, setBases] = useState<BaseRead[]>([]);
  const [asking, setAsking] = useState(false);
  const asked = useRef(0);
  const ask = useCallback(async (list: ComputerRepo[]) => {
    const mine = ++asked.current;
    setAsking(true);
    const out = await Promise.all(
      list.map(async (repo) => {
        try {
          return { label: repo.label, base: await askTeamBase(placeOfRepo(repo)), error: null };
        } catch (e) {
          return { label: repo.label, base: null, error: String(e) };
        }
      }),
    );
    if (mine !== asked.current) return;
    setBases(out);
    setAsking(false);
  }, []);
  const reposNow = useRef(repos);
  reposNow.current = repos;
  const which = repos.map((r) => `${r.row.id}\t${r.path ?? ""}\t${r.label}`).join("\n");
  useEffect(() => {
    setBases([]);
    if (held.asking) return;
    if (reposNow.current.length > 0) void ask(reposNow.current);
  }, [which, held.asking, ask]);

  // Which repositories the next build covers. Null follows the computer:
  // every repository on it.
  const [draft, setDraft] = useState<string[] | null>(null);
  useEffect(() => setDraft(null), [computer?.key]);
  const selected = draft ?? labels;
  const dirty =
    draft !== null &&
    (draft.length !== labels.length || labels.some((l) => !draft.includes(l)));
  const config: CloudComputerConfig = { repositories: selected, installScript: script };

  // Builds this window ran, newest first. The machine keeps no history of its
  // own, so these are what the page witnessed; the computer's standing build
  // follows them.
  const [runs, setRuns] = useState<CloudBuild[]>([]);
  const building = runs[0]?.status === "building";
  const build = async () => {
    if (!computer || building) return;
    const chosen = repos.filter((r) => selected.includes(r.label));
    const started = new Date();
    const time = started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const version = runs.length + 1;
    const run = (patch: Partial<CloudBuild>): CloudBuild => ({
      version,
      label: "Building…",
      status: "building",
      time,
      duration: "",
      logs: [],
      repositories: chosen.map((r) => r.label),
      script,
      ...patch,
    });
    setRuns((r) => [run({}), ...r]);
    const logs: string[] = [];
    let failed = false;
    for (const repo of chosen) {
      const before = bases.find((b) => b.label === repo.label)?.base;
      try {
        const out = await warmStart(
          placeOfRepo(repo),
          undefined,
          before ? baseWasBuilt(before) : false,
        );
        logs.push(...buildLog(repo.label, out), "");
      } catch (e) {
        failed = true;
        logs.push(`# ${repo.label}`, String(e), "");
      }
      setRuns((r) => r.map((b) => (b.version === version ? run({ logs: [...logs] }) : b)));
    }
    const done = run({
      label: `Build at ${time}`,
      status: failed ? "failed" : "ready",
      duration: durationWord(Date.now() - started.getTime()),
      logs,
      reason: failed ? "A repository did not build — open it for the log" : undefined,
    });
    setRuns((r) => r.map((b) => (b.version === version ? done : b)));
    setDraft(null);
    void ask(repos);
  };

  if (rows === null)
    return (
      <>
        <AuraComputerSection />
        <LoadingState label="Looking for connected machines…" />
      </>
    );
  if (!computer) {
    return (
      <>
        <AuraComputerSection />
        {hasAuraComputer ? (
          <SettingsRow
            title="Connect another machine"
            description="A machine you already have can join too, beside the computer Aura runs."
            control={
              <Button size="sm" variant="outline" onClick={() => go("cloud")}>
                Connect a machine
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={Server}
            title="No cloud computer connected yet"
            body="Connect a machine and it shows up here, with every repository on it and the software it builds."
            action={{ label: "Connect a machine", onClick: () => go("cloud") }}
            footnote={readError ?? undefined}
          />
        )}
        <CloudAccessSection onClose={onClose} />
      </>
    );
  }

  const standing = baseEntry(
    bases.flatMap((b) => (b.base ? [{ label: b.label, base: b.base }] : [])),
    script,
  );
  const unread = bases.find((b) => b.error);
  const builds: CloudBuild[] = [...runs];
  if (standing) builds.push(standing);
  else if (unread && runs.length === 0) {
    builds.push({
      version: 0,
      label: "Couldn’t ask the computer",
      status: "failed",
      time: "",
      duration: "",
      reason: unread.error ?? undefined,
      logs: bases.flatMap((b) => (b.error ? [`# ${b.label}`, b.error] : [])),
      repositories: [],
      script,
    });
  } else if ((asking || held.asking) && runs.length === 0) {
    builds.push({
      version: 0,
      label: `Asking ${computer.name}…`,
      status: "building",
      time: "",
      duration: "",
      reason: "Reading what the computer already holds",
      logs: [],
      repositories: [],
      script,
    });
  }

  const configure = (() => {
    // The agent edits a checkout, and only a repository the book ties to a
    // folder on this laptop has one here.
    const root = repos.find((r) => r.booked && r.row.project_root)?.row.project_root;
    if (!root) return undefined;
    return () => {
      window.dispatchEvent(
        new CustomEvent("aura:hand-task-to-agent", {
          detail: {
            agent: "claude",
            label: "Claude Code",
            cwd: root,
            prompt: `Write the [env] block in .aura/settings.toml for this repository, so the team's cloud computer at ${computer.key} can be built with everything an agent needs to work here: the toolchains, packages and services the project really uses. Read the project's own files to find them and don't invent commands. Secrets don't belong in it; they go in Settings › Environment.`,
          },
        }),
      );
      onClose();
    };
  })();

  const via = computer.repos[0].row;
  const repositoriesNote = (
    <>
      Which repositories the next build covers. Every repository on this computer unless you
      narrow it; the choice resets once the build runs.
      {held.note && <> {held.note}</>}
    </>
  );
  const repositoriesFooter = (
    <>
      <AddProject
        place={placeOfMachine(via)}
        onStarted={() => {
          setCloneError(null);
          held.cloneStarted();
        }}
        onError={setCloneError}
      />
      {held.landing && (
        <p className="ui-cloud-note">
          <AsciiSpinner size={10} /> Cloning onto {computer.name} — it shows up in this list when
          it lands.
        </p>
      )}
      {cloneError && <ErrorNote>Couldn’t start the clone — {cloneError}</ErrorNote>}
    </>
  );

  return (
    <>
    <AuraComputerSection />
    <div data-fold="base">
      {computers.length > 1 && (
        <SettingsRow
          title="Computer"
          description="Which connected machine to configure."
          control={
            <Select
              aria-label="Computer"
              align="end"
              value={computer.key}
              onChange={setKey}
              options={computers.map((c) => ({ value: c.key, label: c.name }))}
            />
          }
        />
      )}
      <CloudComputerSettings
        intro={
          computer.shared
            ? `Configure ${computer.name}, the computer your team shares. Build it once and everyone who joins starts from a copy.`
            : `Configure ${computer.name}, your cloud computer.`
        }
        // The checklist picks what the next build covers and nothing keeps it:
        // there is no stored list behind it, so it says so rather than reading
        // as a saved setting.
        repositoriesNote={repositoriesNote}
        repositoriesFooter={repositoriesFooter}
        config={config}
        builds={builds}
        dirty={dirty}
        onChange={(next) => setDraft(next.repositories)}
        onBuild={() => void build()}
        onDiscard={() => setDraft(null)}
        onConfigure={configure}
        availableRepositories={labels}
        branchOf={(label) => repos.find((r) => r.label === label)?.branch ?? null}
        scriptReadOnly
        systemNote={
          <>
            Read from each repository’s <code>.aura/settings.toml</code>.{" "}
            <Button variant="link" size="sm" onClick={() => go("environment")}>
              Open Environment
            </Button>
          </>
        }
        specs={[
          computer.key,
          computer.shared ? "Shared with your team" : "Yours alone",
          `${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`,
        ]}
        buildDisabled={building || asking || held.asking || selected.length === 0}
      />
    </div>
    <CloudAccessSection onClose={onClose} />
    </>
  );
}
