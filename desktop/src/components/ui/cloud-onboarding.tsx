import { useEffect, useRef, useState } from "react";
import {
  Check,
  ArrowRight,
  ArrowUpRight,
  Cloud,
  GitBranch,
  LoaderCircle,
  Search,
  Plus,
  ChevronDown,
  Copy,
} from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./dialog";
import { Select } from "./select";
import { AgentIcon } from "./agent-icon";
import "./cloud-onboarding.css";
export const COMPUTER_COLORS = [
  { id: "bondi", name: "Bondi Blue", swatch: "#00cfcf" },
  { id: "tangerine", name: "Tangerine", swatch: "#ff870f" },
  { id: "grape", name: "Grape", swatch: "#9857db" },
  { id: "lime", name: "Lime", swatch: "#719600" },
  { id: "strawberry", name: "Strawberry", swatch: "#ff3f68" },
  { id: "graphite", name: "Graphite", swatch: "#697477" },
];
export interface CloudSetupResult {
  color: string;
  repositories: string[];
  agents: string[];
}
/** The organization as it really is. Without it the setup runs as the local
 *  example it was drawn as. */
export interface CloudSetupLive {
  orgName: string;
  /** Teammates doing something in the cloud right now. */
  presence: { id: string; name: string; initials: string; color: string; photo?: string; doing: string }[];
  /** `owner/name` of each repository the cloud can read; null when GitHub isn't connected. */
  repositories: string[] | null;
  onConnectGithub?: () => void;
  connectGithubLabel?: string;
  /** What choosing repositories does here. */
  repositoryNote: string;
  agents: { name: string; provider: string; connected: boolean }[];
  /** Agents are connected on the computer, not with a pasted credential here. */
  onConnectAgent: (name: string) => void;
  computer: {
    state: "building" | "ready" | "failed" | "missing";
    label: string;
    detail?: string;
    actions?: { label: string; onClick: () => void }[];
    /** Aura made this machine and keeps it on; false for one the team
     *  connected itself, which runs only while it is on. */
    managed?: boolean;
  };
  onComputerDetails?: () => void;
}
type KeptSetup = { step: number; furthest: number; repos: string[]; org: string };

/** Where a member was in the setup steps, kept for the tab so a reload, or a
 *  trip to GitHub, comes back to the same step with the same picks. */
export function keptSetup(raw: string | null): KeptSetup | null {
  if (!raw) return null;
  try {
    const k = JSON.parse(raw) as Partial<KeptSetup>;
    const step = typeof k.step === "number" && k.step >= 0 && k.step <= 3 ? Math.floor(k.step) : null;
    if (step === null) return null;
    const furthest = typeof k.furthest === "number" ? Math.min(3, Math.max(step, Math.floor(k.furthest))) : step;
    const repos = Array.isArray(k.repos) ? k.repos.filter((r): r is string => typeof r === "string") : [];
    return { step, furthest, repos, org: typeof k.org === "string" ? k.org : "" };
  } catch {
    return null;
  }
}

/** The picks that still stand once the org's repositories are known: ones it
 *  no longer has are dropped, and when it has only one, that one is picked. */
export function standingRepos(picked: string[], listed: string[]): string[] {
  const kept = picked.filter((r) => listed.includes(r));
  if (!kept.length && listed.length === 1) return [listed[0]];
  return kept.length === picked.length ? picked : kept;
}

function setupKey(org: string | undefined): string | null {
  return org ? `aura.cloud-setup.${org}` : null;
}

function readSetup(key: string | null): KeptSetup | null {
  if (!key) return null;
  try {
    return keptSetup(window.sessionStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeSetup(key: string | null, kept: KeptSetup | null) {
  if (!key) return;
  try {
    if (kept) window.sessionStorage.setItem(key, JSON.stringify(kept));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Nothing kept in a private window; the steps still work.
  }
}

export function CloudOnboarding({
  images = {},
  onFinish,
  live,
}: {
  images?: Record<string, string>;
  onFinish: (result: CloudSetupResult) => void;
  live?: CloudSetupLive;
}) {
  const keepKey = live ? setupKey(live.orgName) : null;
  const [kept] = useState(() => readSetup(keepKey));
  const [step, setStep] = useState(kept?.step ?? 0),
    [furthest, setFurthest] = useState(kept?.furthest ?? 0),
    [color, setColor] = useState("bondi"),
    [repos, setRepos] = useState<string[]>(kept?.repos ?? []),
    [picker, setPicker] = useState(false),
    [org, setOrg] = useState(kept?.org || "Studio"),
    [search, setSearch] = useState(""),
    [agent, setAgent] = useState<string>(),
    [credential, setCredential] = useState("Subscription"),
    [connected, setConnected] = useState<string[]>([]),
    [build, setBuild] = useState<"idle" | "building" | "ready" | "failed">(
      "idle",
    ),
    [secret, setSecret] = useState(""),
    [error, setError] = useState(""),
    [buildLogs, setBuildLogs] = useState(false),
    [github, setGithub] = useState(true);
  // The org's name usually arrives after the first draw (a placeholder until
  // then), so the step kept for the real org is read when its key appears,
  // before anything is written under it.
  const [keptFor, setKeptFor] = useState(keepKey);
  if (keptFor !== keepKey) {
    setKeptFor(keepKey);
    const again = readSetup(keepKey);
    if (again) {
      setStep(again.step);
      setFurthest(again.furthest);
      setRepos(again.repos);
      setOrg(again.org || "Studio");
    }
  }
  const go = (next: number) => {
    setStep(next);
    setFurthest((v) => Math.max(v, next));
  };
  useEffect(() => {
    if (live || build !== "building") return;
    const t = setTimeout(() => setBuild("ready"), 1500);
    return () => clearTimeout(t);
  }, [build, live]);
  useEffect(() => {
    writeSetup(keepKey, { step, furthest, repos, org });
  }, [keepKey, step, furthest, repos, org]);
  // Once the org's repositories are known, picks it doesn't have go, an only
  // repository is picked, and right after GitHub is connected on this step
  // the chooser opens by itself.
  const listed = live ? live.repositories : null;
  const listedKey = listed ? listed.join("\n") : null;
  const hadList = useRef(listed !== null);
  useEffect(() => {
    if (!live) return;
    if (!listed) {
      hadList.current = false;
      return;
    }
    const arrived = !hadList.current;
    hadList.current = true;
    const standing = standingRepos(repos, listed);
    if (standing !== repos) setRepos(standing);
    if (arrived && step === 2 && !standing.length && listed.length > 1) setPicker(true);
  }, [listedKey, step]);
  const liveOrgs = live
    ? [...new Set((live.repositories ?? []).map((r) => r.split("/")[0]))]
    : [];
  useEffect(() => {
    if (live && liveOrgs.length && !liveOrgs.includes(org)) setOrg(liveOrgs[0]);
  }, [live, liveOrgs.join("\n"), org]);
  const liveAgent = (name: string) => live?.agents.find((a) => a.name === name);
  const anyConnected = live ? live.agents.some((a) => a.connected) : connected.length > 0;
  const shown = live ? live.computer.state : build;
  const allRepos = live
    ? (live.repositories ?? []).filter((r) => r.split("/")[0] === org)
    : [
    "interface-system",
    "design-system",
    "desktop-shell",
    "api",
      ].map((name) => org.toLowerCase() + "/" + name);
  const filtered = allRepos.filter((name) =>
    name.toLowerCase().includes(search.toLowerCase()),
  );
  const colorName = COMPUTER_COLORS.find((c) => c.id === color)?.name;
  return (
    <div className="ui-cloud-setup">
      <nav aria-label="Setup steps">
        {["Get started", "Cloud computer", "Connect GitHub", "Agents"].map(
          (name, i) => (
            <button
              key={name}
              aria-current={i === step ? "step" : undefined}
              disabled={i > furthest}
              onClick={() => go(i)}
            >
              <span>{i < furthest ? <Check size={12} /> : i + 1}</span>
              {name}
            </button>
          ),
        )}
      </nav>
      <main key={step} className="ui-cloud-setup-page">
        {step === 0 ? (
          <>
            <h1>Welcome to your cloud workspace</h1>
            {live ? (
              live.presence.length > 0 && (
                <div className="ui-cloud-welcome-presence">
                  {live.presence.map((p) => (
                    <div key={p.id}>
                      <span className="ui-cloud-avatar" style={{ background: p.color }}>
                        {p.photo ? <img src={p.photo} alt="" draggable={false} /> : p.initials}
                      </span>
                      {p.doing} <span>↗</span>
                    </div>
                  ))}
                </div>
              )
            ) : (
            <div className="ui-cloud-welcome-presence">
              <div>
                <span
                  className="ui-cloud-avatar"
                  style={{ background: "#596d84" }}
                >
                  MC
                </span>
                Maya is reviewing a pull request <span>↗</span>
              </div>
              <div>
                <span
                  className="ui-cloud-avatar"
                  style={{ background: "#71617b" }}
                >
                  LP
                </span>
                Leo is working on keyboard shortcuts <span>↗</span>
              </div>
            </div>
            )}
            <p>
              Run agents together in shared workspaces. Pick up work from any
              device, keep agents running while you're away, and use the API to
              start work from your own tools.
            </p>
            <ul>
              <li>Isolated cloud workspaces</li>
              <li>Live collaboration with your team</li>
              <li>Desktop, mobile, and API access</li>
            </ul>
            <Button onClick={() => go(1)}>
              Get started <ArrowRight />
            </Button>
          </>
        ) : step === 1 ? (
          <>
            <h1>Workspaces now run in the cloud</h1>
            <div className="ui-cloud-computer-hero">
              {images[color] ? (
                <img
                  src={images[color]}
                  alt={`${colorName} cloud computer`}
                  draggable={false}
                />
              ) : (
                <Cloud
                  size={180}
                  color={COMPUTER_COLORS.find((c) => c.id === color)?.swatch}
                />
              )}
              <div>
                <p>
                  ↙ this is {live?.orgName ?? "Studio"}'s cloud computer
                  <br />
                  {!live || live.computer.managed
                    ? "it's fast and always online"
                    : live.computer.state === "ready"
                      ? "it runs while your team's machine is on"
                      : "it runs on a machine your team makes or connects"}
                </p>
                <div role="radiogroup" aria-label="Computer color">
                  {COMPUTER_COLORS.map((c) => (
                    <button
                      key={c.id}
                      role="radio"
                      tabIndex={color === c.id ? 0 : -1}
                      onKeyDown={(event) => {
                        if (
                          ![
                            "ArrowLeft",
                            "ArrowRight",
                            "ArrowUp",
                            "ArrowDown",
                          ].includes(event.key)
                        )
                          return;
                        event.preventDefault();
                        const index = COMPUTER_COLORS.findIndex(
                          (item) => item.id === c.id,
                        );
                        const offset =
                          event.key === "ArrowLeft" || event.key === "ArrowUp"
                            ? -1
                            : 1;
                        const next =
                          (index + offset + COMPUTER_COLORS.length) %
                          COMPUTER_COLORS.length;
                        setColor(COMPUTER_COLORS[next].id);
                        (
                          event.currentTarget.parentElement?.children[
                            next
                          ] as HTMLButtonElement
                        )?.focus();
                      }}
                      aria-checked={color === c.id}
                      aria-label={c.name}
                      title={c.name}
                      style={{ background: c.swatch }}
                      onClick={() => setColor(c.id)}
                    />
                  ))}
                </div>
              </div>
            </div>
            <p>
              Your team works on a shared cloud computer. Every workspace starts
              with a copy of its repositories and development tools.
            </p>
            <Button onClick={() => go(2)}>
              Continue <ArrowRight />
            </Button>
          </>
        ) : step === 2 ? (
          <>
            <header>
              <h1>Connect GitHub</h1>
              <p>Pick which repos to clone onto your new computer.</p>
            </header>
            <div className="ui-cloud-setup-repo-preview">
              {images[color] && <img src={images[color]} alt="" />}
              <pre>
                ~/{"\n"}
                {repos.length
                  ? repos.map((r) => "  " + r.split("/")[1]).join("\n")
                  : "  Added repositories appear here"}
              </pre>
            </div>
            {(live ? live.repositories !== null : github) ? (
              <>
                <Button
                  variant="outline"
                  className="ui-cloud-repo-select"
                  onClick={() => setPicker(true)}
                >
                  {repos.length
                    ? `${repos.length} ${repos.length === 1 ? "repository" : "repositories"} selected`
                    : "Choose repositories"}
                  <ChevronDown />
                </Button>
                {repos.map((repo) => (
                  <div className="ui-cloud-setup-repo" key={repo}>
                    <GitBranch size={14} />
                    {repo}
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        setRepos((rs) => rs.filter((r) => r !== repo))
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                {repos.length > 0 && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setRepos([])}
                  >
                    Clear
                  </Button>
                )}
              </>
            ) : (
              <div className="ui-cloud-setup-missing">
                <p>Connect GitHub to choose repositories.</p>
                <Button
                  variant="secondary"
                  onClick={() => (live ? live.onConnectGithub?.() : setGithub(true))}
                >
                  {live ? (live.connectGithubLabel ?? "Connect GitHub") : "Connect example GitHub"}{" "}
                  <ArrowUpRight />
                </Button>
              </div>
            )}
            <p className="ui-cloud-note">
              {live
                ? live.repositoryNote
                : "Each workspace receives a copy of all selected repositories."}
            </p>
            <Button
              disabled={!repos.length}
              onClick={() => {
                if (!live) setBuild("building");
                go(3);
              }}
            >
              Continue <ArrowRight />
            </Button>
          </>
        ) : (
          <>
            <header>
              <h1>Agents</h1>
              <p>Add your favorite agents to your computer.</p>
            </header>
            <div className="ui-cloud-agent-connections">
              {(live
                ? live.agents.map((a) => a.name)
                : ["Claude Code", "Codex", "Cursor", "OpenCode"]
              ).map((name) => (
                <button
                  key={name}
                  onClick={() => {
                    if (live) {
                      live.onConnectAgent(name);
                      return;
                    }
                    setAgent(name);
                    setSecret("");
                    setError("");
                  }}
                >
                  <AgentIcon
                    provider={
                      liveAgent(name)?.provider ??
                      (name === "Claude Code"
                        ? "anthropic"
                        : name === "Codex"
                          ? "openai"
                          : name.toLowerCase())
                    }
                    size={18}
                  />
                  <span>{name}</span>
                  {(live ? !!liveAgent(name)?.connected : connected.includes(name)) ? (
                    <>
                      <small>Connected</small>
                      <Check size={15} />
                    </>
                  ) : (
                    <>
                      <small>Connect</small>
                      <ArrowUpRight size={14} />
                    </>
                  )}
                </button>
              ))}
            </div>
            <div className="ui-cloud-inline">
              <button
                className="ui-cloud-setup-build"
                onClick={() => (live ? live.onComputerDetails?.() : setBuildLogs(true))}
              >
                {shown === "building" ? (
                  <LoaderCircle size={16} />
                ) : shown === "failed" ? (
                  <span>×</span>
                ) : shown === "missing" ? (
                  <Cloud size={16} />
                ) : (
                  <Check size={16} />
                )}
                <span>
                  {live
                    ? live.computer.label
                    : build === "building"
                    ? "Building your computer…"
                    : build === "failed"
                      ? "Your computer build failed."
                      : "Your computer is ready"}
                </span>
              </button>
              {live?.computer.actions?.map((a) => (
                <Button key={a.label} size="xs" variant="secondary" onClick={a.onClick}>
                  {a.label}
                </Button>
              ))}
              {!live && build === "failed" && (
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={(e) => {
                    e.stopPropagation();
                    setBuild("building");
                  }}
                >
                  Retry
                </Button>
              )}
            </div>
            {live?.computer.detail && <p className="ui-cloud-note">{live.computer.detail}</p>}
            <div className="ui-cloud-inline">
              <Button
                disabled={!anyConnected || shown !== "ready"}
                onClick={() => {
                  writeSetup(keepKey, null);
                  onFinish({
                    color,
                    repositories: repos,
                    agents: live
                      ? live.agents.filter((a) => a.connected).map((a) => a.name)
                      : connected,
                  });
                }}
              >
                Finish <ArrowRight />
              </Button>
              {!anyConnected && (
                <small>Connect at least one agent to continue.</small>
              )}
            </div>
          </>
        )}
        {!live && (
        <div className="ui-cloud-setup-example">
          <span>Local setup example</span>
          {step === 2 && (
            <button onClick={() => setGithub((v) => !v)}>
              {github ? "Preview disconnected GitHub" : "Restore GitHub"}
            </button>
          )}
          {step === 3 && (
            <button onClick={() => setBuild("failed")}>
              Preview build failure
            </button>
          )}
        </div>
        )}
      </main>
      <Dialog open={picker} onOpenChange={setPicker}>
        <DialogContent className="ui-cloud-repository-dialog">
          <DialogTitle>Choose repositories</DialogTitle>
          <DialogDescription>
            Select repositories for the cloud computer.
          </DialogDescription>
          <div className="ui-cloud-repository-browser">
            <aside>
              <Select
                value={org}
                onChange={setOrg}
                aria-label="GitHub organization"
                options={
                  live
                    ? liveOrgs.map((o) => ({ value: o, label: o }))
                    : [
                        { value: "Studio", label: "Studio" },
                        { value: "Personal", label: "Personal" },
                      ]
                }
              />
              <button onClick={() => (live ? live.onConnectGithub?.() : setOrg("Personal"))}>
                <Plus size={13} />
                Connect organization
              </button>
            </aside>
            <section>
              <Input
                aria-label="Search repositories"
                prefix={<Search size={14} />}
                placeholder="Search repositories…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button
                className="ui-cloud-select-all"
                onClick={() =>
                  setRepos((rs) =>
                    filtered.every((r) => rs.includes(r))
                      ? rs.filter((r) => !filtered.includes(r))
                      : [...new Set([...rs, ...filtered])],
                  )
                }
              >
                {filtered.every((r) => repos.includes(r))
                  ? "Deselect all"
                  : "Select all"}
              </button>
              {filtered.map((repo) => (
                <label key={repo}>
                  <input
                    type="checkbox"
                    checked={repos.includes(repo)}
                    onChange={(e) =>
                      setRepos((rs) =>
                        e.target.checked
                          ? [...rs, repo]
                          : rs.filter((r) => r !== repo),
                      )
                    }
                  />
                  <GitBranch size={14} />
                  {repo}
                </label>
              ))}
              {!filtered.length && <p>No repositories found.</p>}
              <Button size="sm" onClick={() => setPicker(false)}>
                Done
              </Button>
            </section>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!live && !!agent} onOpenChange={(v) => !v && setAgent(undefined)}>
        <DialogContent>
          <DialogTitle>Connect {agent}</DialogTitle>
          <DialogDescription>
            Choose a credential for cloud workspaces. Only use sample values in
            this local setup preview.
          </DialogDescription>
          <div className="ui-cloud-segments">
            {["Subscription", "API key", "Custom provider"].map((c) => (
              <button
                key={c}
                aria-pressed={credential === c}
                onClick={() => setCredential(c)}
              >
                {c}
              </button>
            ))}
          </div>
          {credential === "Subscription" ? (
            <>
              <p>Import a credential from this Mac.</p>
              <Button
                variant="secondary"
                onClick={() => {
                  setConnected((cs) => [...new Set([...cs, agent!])]);
                  setAgent(undefined);
                }}
              >
                Import example credential
              </Button>
              {agent === "Claude Code" && (
                <code className="ui-cloud-setup-command">
                  claude setup-token <Copy size={13} />
                </code>
              )}
            </>
          ) : (
            <>
              <Input
                type="password"
                aria-label="Example API key"
                placeholder="Sample credential"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
              {credential === "Custom provider" && (
                <Input
                  aria-label="Provider base URL"
                  placeholder="https://api.example.test/v1"
                />
              )}
              <Button
                onClick={() => {
                  if (!secret.trim()) {
                    setError("Enter a sample credential.");
                    return;
                  }
                  setConnected((cs) => [...new Set([...cs, agent!])]);
                  setSecret("");
                  setAgent(undefined);
                }}
              >
                Save example
              </Button>
              {error && <p role="alert">{error}</p>}
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={!live && buildLogs} onOpenChange={setBuildLogs}>
        <DialogContent>
          <DialogTitle>Computer build</DialogTitle>
          <DialogDescription>{build}</DialogDescription>
          <pre className="ui-cloud-logs">{`Cloning ${repos.length} repositories\nPreparing development environment\n${build === "failed" ? "Dependency installation failed. Exit code 1." : build === "ready" ? "Build complete. Computer is active." : "Installing dependencies…"}`}</pre>
          {build === "failed" && (
            <Button onClick={() => setBuild("building")}>Retry</Button>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
