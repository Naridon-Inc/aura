import { useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Cloud,
  GitBranch,
  LoaderCircle,
  CircleX,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "./button";
import { Textarea } from "./textarea";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "./dropdown-menu";
export interface CloudBuild {
  version: number;
  status: "ready" | "building" | "failed" | "canceled";
  active?: boolean;
  time: string;
  duration: string;
  logs: string[];
  reason?: string;
  repositories: string[];
  script: string;
  /** What the build is called in its row; `Build #<version>` when absent. */
  label?: string;
}
export interface CloudComputerConfig {
  repositories: string[];
  installScript: string;
}
export function CloudComputerSettings({
  config,
  image,
  builds,
  dirty,
  onChange,
  onBuild,
  onCancel,
  onDiscard,
  onActivate,
  onConfigure,
  intro = "Configure your organization's shared cloud computer.",
  repositoriesNote = "Repositories available to new workspaces.",
  repositoriesFooter,
  availableRepositories,
  branchOf = () => "main",
  scriptReadOnly = false,
  systemNote = "Amazon Linux 2023 · Node.js 24 · Python 3 · git · gh · pnpm · Chrome",
  specs = ["8 vCPUs", "16 GB RAM", "64 GB NVMe"],
  buildDisabled = false,
}: {
  config: CloudComputerConfig;
  image?: string;
  builds: CloudBuild[];
  dirty: boolean;
  onChange: (config: CloudComputerConfig) => void;
  onBuild: () => void;
  /** Without it a running build offers no Cancel. */
  onCancel?: () => void;
  onDiscard: () => void;
  /** Without it a finished build offers no Activate. */
  onActivate?: (version: number) => void;
  /** Without it the header offers no "Configure with an agent". */
  onConfigure?: () => void;
  /** The sentence at the top. */
  intro?: ReactNode;
  /** The line under "Repositories": what the choice there does. */
  repositoriesNote?: ReactNode;
  /** Under the repository list: a way to put another one on the computer. */
  repositoriesFooter?: ReactNode;
  /** The repositories the picker offers. */
  availableRepositories?: string[];
  /** The branch a listed repository shows; nothing is shown for null. */
  branchOf?: (repository: string) => string | null;
  /** Show the install script without letting it be edited here. */
  scriptReadOnly?: boolean;
  /** The line under the install script. */
  systemNote?: ReactNode;
  /** The facts along the bottom. */
  specs?: string[];
  /** Hold the build button, for a computer that can't take one right now. */
  buildDisabled?: boolean;
}) {
  const [history, setHistory] = useState(false),
    [detail, setDetail] = useState<number>(),
    [tab, setTab] = useState("logs");
  const build: CloudBuild = builds[0] ?? {
      version: 0,
      status: "canceled",
      time: "",
      duration: "",
      logs: [],
      repositories: [],
      script: "",
      reason: "No builds yet",
    },
    selected = builds.find((b) => b.version === detail);
  const allRepos = availableRepositories ?? [
    "studio/interface-system",
    "studio/design-system",
    "studio/desktop-shell",
    "studio/api",
  ];
  const titleOf = (b: CloudBuild) => b.label ?? `Build #${b.version}`;
  return (
    <div className="ui-cloud-computer">
      <header>
        <div>
          <p>{intro}</p>
          {onConfigure && (
            <Button variant="secondary" size="sm" onClick={onConfigure}>
              Configure with an agent
            </Button>
          )}
        </div>
        {image ? (
          <img src={image} width={64} height={64} alt="Cloud computer" />
        ) : (
          <Cloud size={54} strokeWidth={1} className="ui-cloud-computer-icon" />
        )}
      </header>
      <div className="ui-cloud-build-box">
        <div className="ui-cloud-build-row">
          <button
            className="ui-cloud-build-summary"
            onClick={() => setDetail(build.version)}
          >
            {build.status === "building" ? (
              <LoaderCircle size={18} />
            ) : build.status === "failed" ? (
              <CircleX size={18} />
            ) : (
              <Check size={18} />
            )}
            <span>
              <strong>
                {dirty
                  ? "Unbuilt changes"
                  : build.status === "building"
                    ? build.label ?? `Building #${build.version}`
                    : titleOf(build)}
              </strong>
              <small>
                {dirty
                  ? "Repositories or install software changed"
                  : (build.reason ?? `${build.duration} · ${build.time}`)}
              </small>
            </span>
          </button>
          {build.active && <span className="ui-cloud-badge">Active</span>}
          {dirty && (
            <Button size="sm" variant="ghost" onClick={onDiscard}>
              Discard
            </Button>
          )}
          <Button size="sm" onClick={onBuild} disabled={buildDisabled}>
            {build.status === "building" ? "Restart build" : "Build computer"}
          </Button>
          {build.status === "building" && onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
        <button
          className="ui-cloud-history"
          onClick={() => setHistory(!history)}
          aria-expanded={history}
        >
          History ({builds.length}) <ChevronDown size={13} />
        </button>
        {history &&
          builds.map((b) => (
            <div className="ui-cloud-build-row" key={b.version}>
              <button
                className="ui-cloud-build-summary"
                onClick={() => {
                  setDetail(b.version);
                  setTab("logs");
                }}
              >
                {b.status === "failed" ? (
                  <CircleX size={14} />
                ) : b.status === "building" ? (
                  <LoaderCircle size={14} />
                ) : (
                  <Check size={14} />
                )}
                <span>
                  <strong>{titleOf(b)}</strong>
                  <small>
                    {b.status} · {b.duration} · {b.time}
                  </small>
                </span>
              </button>
              {b.active ? (
                <span className="ui-cloud-badge">Active</span>
              ) : (
                b.status === "ready" &&
                onActivate && (
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => onActivate(b.version)}
                  >
                    Activate
                  </Button>
                )
              )}
            </div>
          ))}
      </div>
      <section>
        <h3>Repositories</h3>
        <p>{repositoriesNote}</p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="ui-cloud-repo-select">
              {config.repositories.length}{" "}
              {config.repositories.length === 1 ? "repository" : "repositories"}{" "}
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {allRepos.map((repo) => (
              <DropdownMenuCheckboxItem
                key={repo}
                checked={config.repositories.includes(repo)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(checked) =>
                  onChange({
                    ...config,
                    repositories: checked
                      ? [...config.repositories, repo]
                      : config.repositories.filter((r) => r !== repo),
                  })
                }
              >
                {repo}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ui-cloud-repo-list">
          {config.repositories.map((repo) => (
            <div key={repo}>
              <GitBranch size={14} />
              {repo}
              {branchOf(repo) !== null && <span>{branchOf(repo)}</span>}
            </div>
          ))}
        </div>
        {repositoriesFooter}
      </section>
      <section>
        <h3>Install software</h3>
        <p>
          Runs once per build. New workspaces inherit the resulting environment.
        </p>
        <Textarea
          aria-label="Install software script"
          className="ui-cloud-script"
          value={config.installScript}
          readOnly={scriptReadOnly}
          onChange={(e) =>
            onChange({ ...config, installScript: e.target.value })
          }
          spellCheck={false}
        />
        <small>{systemNote}</small>
      </section>
      <section className="ui-cloud-specs">
        {specs.map((spec) => (
          <span key={spec}>{spec}</span>
        ))}
      </section>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => !open && setDetail(undefined)}
      >
        <DialogContent className="ui-cloud-build-dialog">
          <DialogTitle>{selected && titleOf(selected)}</DialogTitle>
          <DialogDescription>
            {selected?.status} · {selected?.duration}
            {selected?.reason && ` · ${selected.reason}`}
          </DialogDescription>
          <div className="ui-cloud-segments">
            {["logs", "settings"].map((t) => (
              <button
                key={t}
                aria-pressed={t === tab}
                onClick={() => setTab(t)}
              >
                {t === "logs" ? "Logs" : "Settings"}
              </button>
            ))}
          </div>
          {tab === "logs" ? (
            <pre className="ui-cloud-logs">{selected?.logs.join("\n")}</pre>
          ) : (
            <div>
              <h3>Repositories</h3>
              <pre>{selected?.repositories.join("\n")}</pre>
              <h3>Install software</h3>
              <pre>{selected?.script}</pre>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
export interface CloudEnvironmentEntry {
  name: string;
  scope: "Personal" | "Shared";
}
export function CloudEnvironmentSettings({
  entries,
  onSave,
  onRemove,
}: {
  entries: CloudEnvironmentEntry[];
  onSave: (entries: CloudEnvironmentEntry[]) => void;
  onRemove: (name: string, scope: "Personal" | "Shared") => void;
}) {
  const [scope, setScope] = useState<"Personal" | "Shared">("Personal"),
    [editing, setEditing] = useState(false),
    [bulk, setBulk] = useState(""),
    [error, setError] = useState("");
  return (
    <div className="ui-cloud-settings">
      <p>
        Personal variables apply to your workspaces. Shared variables apply to
        the organization.
      </p>
      <div className="ui-cloud-segments">
        {(["Personal", "Shared"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            aria-pressed={scope === s}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="ui-cloud-environment">
        {entries
          .filter((e) => e.scope === scope)
          .map((e) => (
            <div className="ui-cloud-row" key={e.name}>
              <code>{e.name}</code>
              <span>••••••••</span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setBulk(e.name + "=");
                  setEditing(true);
                }}
              >
                Replace
              </Button>
              <Button
                size="iconXs"
                variant="ghost"
                aria-label={`Remove ${e.name}`}
                onClick={() => onRemove(e.name, scope)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setBulk("");
          setEditing(true);
        }}
      >
        <Plus />
        Add variables
      </Button>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogTitle>{scope} environment variables</DialogTitle>
          <DialogDescription>
            Paste one KEY=VALUE per line. Saved values are hidden. Use sample
            values in this local preview.
          </DialogDescription>
          <Textarea
            aria-label="Environment variables"
            placeholder="API_URL=https://example.test"
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
            spellCheck={false}
          />
          {error && <p role="alert">{error}</p>}
          <Button
            onClick={() => {
              const rows = bulk.split(/\r?\n/).filter((l) => l.trim());
              if (
                !rows.length ||
                rows.some((l) => !/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(l))
              ) {
                setError("Use KEY=VALUE on each line.");
                return;
              }
              onSave(
                rows.map((l) => ({
                  name: l.slice(0, l.indexOf("=")).trim(),
                  scope,
                })),
              );
              setBulk("");
              setError("");
              setEditing(false);
            }}
          >
            Save variables
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
