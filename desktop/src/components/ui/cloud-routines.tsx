import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight,
  Clock,
  GitFork,
  Webhook,
  Check,
  CircleX,
  LoaderCircle,
  ArrowUpRight,
  Link,
  Plus,
  Play,
  History,
  MoreHorizontal,
  Copy,
  Trash2,
} from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Select } from "./select";
import { Switch } from "./switch";
import { ModelPicker, type ModelSelection } from "./model-picker";
import { type ModelOption } from "./model-picker";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "./context-menu";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./dialog";
export interface RoutineGithubFilter {
  id: string;
  field: "label" | "author" | "base_branch";
  operator: "is" | "is_not";
  value: string;
}
export interface RoutineTrigger {
  id: string;
  type: "Scheduled" | "GitHub" | "Webhook";
  schedule: string;
  time: string;
  event: string;
  filter: string;
  filters?: RoutineGithubFilter[];
  weekday?: string;
}
export interface CloudRoutine {
  id: string;
  name: string;
  /** How many times it ran, when the server counts runs it doesn't list. */
  runCount?: number;
  /** When it last ran, already worded ("2h ago"). */
  lastRunLabel?: string;
  prompt: string;
  repository: string;
  model: ModelSelection;
  enabled: boolean;
  triggers: RoutineTrigger[];
  runs: {
    id: string;
    status: "Completed" | "Failed" | "Running";
    time: string;
    title: string;
  }[];
  versions: {
    name: string;
    prompt: string;
    time: string;
    repository?: string;
    model?: ModelSelection;
    enabled?: boolean;
    triggers?: RoutineTrigger[];
  }[];
}
export type RoutineNavigationGuard = (proceed: () => void) => void;
/** Where routines are kept when they are kept somewhere real. Without one the
 *  component runs as the local example it was drawn as. */
export interface RoutineBackend {
  repositories: { value: string; label: string }[];
  author: { name: string; initials: string; photo?: string };
  /** The zone schedule times are read in ("UTC", "+05:30"). */
  timezone: string;
  /** The trigger kinds the server accepts. */
  triggerTypes: RoutineTrigger["type"][];
  /** The schedule choices the server can express. */
  schedules: string[];
  /** Save a new routine; resolves to it as stored, and anything shown once. */
  create: (draft: CloudRoutine) => Promise<{ routine: CloudRoutine; message?: string }>;
  remove: (id: string) => Promise<void>;
  /** Why a saved routine can't be changed here, when it can't. */
  readOnlyReason?: string;
  /** A trigger's webhook address, when the server handed one back. */
  webhookUrl?: (trigger: RoutineTrigger) => string | null;
}
function routineNextRun(routine: CloudRoutine, timezone = "IST") {
  if (!routine.enabled) return "Paused";
  const trigger = routine.triggers.find((t) => t.type === "Scheduled");
  if (!trigger) return "No upcoming runs";
  if (trigger.schedule === "Custom") return `Custom schedule · ${timezone}`;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time))
    return "Set a valid time";
  return `${trigger.schedule} at ${trigger.time} ${timezone}`;
}
export function CloudRoutines({
  routines,
  models,
  onChange,
  onRun,
  onOpenWorkspace,
  onNavigationGuard,
  backend,
  noModels,
}: {
  routines: CloudRoutine[];
  models: ModelOption[];
  onChange: (routines: CloudRoutine[]) => void;
  onRun: (routine: CloudRoutine) => void;
  onOpenWorkspace: (id: string) => void;
  onNavigationGuard?: (guard: RoutineNavigationGuard | undefined) => void;
  backend?: RoutineBackend;
  /** Drawn in place of the model picker when there are no models: no agent
   *  is set up, so a routine would have nothing to run on. */
  noModels?: ReactNode;
}) {
  const [id, setId] = useState<string>(),
    [draft, setDraft] = useState<CloudRoutine>(),
    [history, setHistory] = useState(false),
    [deleting, setDeleting] = useState<string>(),
    [discard, setDiscard] = useState(false),
    [message, setMessage] = useState(""),
    [saving, setSaving] = useState(false);
  const pendingNavigation = useRef<(() => void) | undefined>(undefined);
  const current = routines.find((r) => r.id === id);
  const tz = backend?.timezone ?? "IST";
  const locked = !!(backend?.readOnlyReason && current);
  const repositoryOptions = backend?.repositories ?? [
    { value: "interface-system", label: "interface-system" },
    { value: "design-system", label: "design-system" },
  ];
  const defaultRepository = repositoryOptions[0]?.value ?? "";
  const defaultModel = models.find((m) => !m.disabled)?.id ?? (backend ? "" : "astra");
  const needsAgent = !models.length && !!noModels;
  const configuration = (routine?: CloudRoutine) =>
    routine && {
      name: routine.name,
      prompt: routine.prompt,
      repository: routine.repository,
      model: routine.model,
      enabled: routine.enabled,
      triggers: routine.triggers,
    };
  const dirty =
    !!draft &&
    JSON.stringify(configuration(current)) !==
      JSON.stringify(configuration(draft));
  useEffect(() => {
    onNavigationGuard?.(
      dirty
        ? (proceed) => {
            pendingNavigation.current = proceed;
            setDiscard(true);
          }
        : undefined,
    );
    return () => onNavigationGuard?.(undefined);
  }, [dirty, onNavigationGuard]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const validTriggers =
    draft?.triggers.every((t) =>
      t.type === "GitHub"
        ? (t.filters ?? []).every((filter) => filter.value.trim().length > 0)
        : t.type !== "Scheduled" ||
          t.schedule === "Every hour" ||
          (t.schedule === "Custom"
            ? t.time.trim().split(/\s+/).length === 5
            : /^([01]\d|2[0-3]):[0-5]\d$/.test(t.time)),
    ) ?? true;
  const back = () =>
    dirty ? setDiscard(true) : (setDraft(undefined), setId(undefined));
  const open = (r: CloudRoutine) => {
    setId(r.id);
    setDraft(structuredClone(r));
  };
  const save = async () => {
    if (!draft?.name.trim()) return;
    if (backend) {
      if (locked || saving) return;
      setSaving(true);
      setMessage("");
      try {
        const saved = await backend.create({ ...draft, name: draft.name.trim() });
        onChange([saved.routine, ...routines.filter((r) => r.id !== saved.routine.id)]);
        setId(saved.routine.id);
        setDraft(structuredClone(saved.routine));
        setMessage(saved.message ?? "Routine saved.");
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
      return;
    }
    const next = {
      ...draft,
      name: draft.name.trim(),
      runs: current?.runs ?? draft.runs,
      versions: [
        {
          ...configuration(draft),
          name: draft.name,
          prompt: draft.prompt,
          time: "Just now",
        },
        ...draft.versions,
      ],
    };
    onChange(
      current
        ? routines.map((r) => (r.id === id ? next : r))
        : [next, ...routines],
    );
    setDraft(next);
    setMessage("Routine saved in this local example.");
  };
  const update = (patch: Partial<CloudRoutine>) =>
    setDraft((r) => (r ? { ...r, ...patch } : r));
  const addTrigger = (type: RoutineTrigger["type"]) =>
    update({
      triggers: [
        ...(draft?.triggers ?? []),
        {
          id: crypto.randomUUID(),
          type,
          schedule: backend?.schedules[0] ?? "Every weekday",
          time: "09:00",
          event: "PR opened",
          filter: "",
        },
      ],
    });
  const removeRoutine = async (target: string) => {
    if (backend) {
      try {
        await backend.remove(target);
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e));
        setDeleting(undefined);
        return;
      }
    }
    onChange(routines.filter((r) => r.id !== target));
    setDeleting(undefined);
    setDraft(undefined);
    setId(undefined);
  };
  return (
    <div className="ui-cloud-routines" data-editing={!!draft}>
      <header>
        <nav
          className="ui-cloud-routine-breadcrumb"
          aria-label="Routine breadcrumb"
        >
          <button
            onClick={draft ? back : undefined}
            aria-label={draft ? "Back to routines" : undefined}
          >
            Routines
          </button>
          {draft && (
            <>
              <ChevronRight size={12} />
              <span>{draft.name || "Untitled routine"}</span>
            </>
          )}
        </nav>
        {draft ? (
          <div className="ui-cloud-inline">
            <Button
              size="sm"
              disabled={
                !dirty ||
                !draft.name.trim() ||
                !draft.prompt.trim() ||
                !validTriggers ||
                needsAgent ||
                locked ||
                saving
              }
              title={locked ? backend?.readOnlyReason : needsAgent ? "Set up an agent first." : undefined}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            {current && (
              <Button
                size="sm"
                variant="outline"
                aria-label="Run routine"
                disabled={
                  dirty ||
                  !draft.enabled ||
                  current.runs.some((r) => r.status === "Running")
                }
                onClick={() => onRun(draft)}
              >
                <Play />
                Run
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="iconSm"
                  variant="ghost"
                  aria-label="Routine actions"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!backend && (
                  <DropdownMenuItem onSelect={() => setHistory(true)}>
                    <History />
                    Version history
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onSelect={() =>
                    open({
                      ...draft,
                      id: crypto.randomUUID(),
                      name: draft.name + " copy",
                      runs: [],
                      versions: [],
                    })
                  }
                >
                  <Copy />
                  Duplicate
                </DropdownMenuItem>
                {!backend && (
                  <DropdownMenuItem
                    onSelect={() =>
                      void navigator.clipboard.writeText(
                        location.origin + location.pathname + "#cloud/routines",
                      )
                    }
                  >
                    <Link />
                    Copy link
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  disabled={!current}
                  onSelect={() => setDeleting(draft.id)}
                >
                  <Trash2 />
                  Delete routine
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : (
          <Button
            size="sm"
            onClick={() =>
              open({
                id: crypto.randomUUID(),
                name: "",
                prompt: "",
                repository: defaultRepository,
                model: { model: defaultModel, effort: "High" },
                enabled: true,
                triggers: [],
                runs: [],
                versions: [],
              })
            }
          >
            <Plus />
            New routine
          </Button>
        )}
      </header>
      {draft ? (
        <div className="ui-cloud-routine-split">
          <div className="ui-cloud-routine-editor">
            <input
              className="ui-cloud-routine-name"
              aria-label="Routine name"
              placeholder="Untitled routine"
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
            />
            <div className="ui-cloud-routine-meta">
              <label>
                <Switch
                  aria-label="Routine enabled"
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => update({ enabled })}
                />
                {draft.enabled ? "Active" : "Paused"}
              </label>
              <i />
              <Select
                indicator="down"
                aria-label="Routine repository"
                value={draft.repository}
                onChange={(repository) => update({ repository })}
                options={repositoryOptions}
              />
              <i />
              <span className="ui-cloud-routine-author">
                <span
                  className="ui-cloud-avatar ui-cloud-avatar-static"
                  role="img"
                  aria-label="Your avatar"
                >
                  {backend?.author.photo ? (
                    <img src={backend.author.photo} alt="" draggable={false} />
                  ) : (
                    (backend?.author.initials ?? "Y")
                  )}
                </span>
                By {backend?.author.name ?? "You"}
              </span>
            </div>
            {locked && (
              <p role="note" className="ui-cloud-note">
                {backend?.readOnlyReason}
              </p>
            )}
            <h3>Triggers</h3>
            {draft.triggers.map((t) => (
              <div className="ui-cloud-trigger" key={t.id}>
                {t.type === "Scheduled" ? (
                  <Clock size={16} />
                ) : t.type === "GitHub" ? (
                  <GitFork size={16} />
                ) : (
                  <Webhook size={16} />
                )}
                {t.type === "Scheduled" ? (
                  <>
                    <Select
                      indicator="none"
                      aria-label="Schedule frequency"
                      value={t.schedule}
                      onChange={(schedule) =>
                        update({
                          triggers: draft.triggers.map((x) =>
                            x.id === t.id
                              ? {
                                  ...x,
                                  schedule,
                                  time:
                                    schedule === "Custom"
                                      ? "0 9 * * *"
                                      : "09:00",
                                }
                              : x,
                          ),
                        })
                      }
                      options={(
                        backend?.schedules ?? [
                          "Every hour",
                          "Every day",
                          "Every weekday",
                          "Every week",
                          "Custom",
                        ]
                      ).map((v) => ({ value: v, label: v }))}
                    />
                    <span>at</span>
                    <Input
                      aria-label={
                        t.schedule === "Custom"
                          ? "Cron expression"
                          : "Schedule time"
                      }
                      type="text"
                      inputMode={t.schedule === "Custom" ? "text" : "numeric"}
                      pattern={
                        t.schedule === "Custom"
                          ? undefined
                          : "([01][0-9]|2[0-3]):[0-5][0-9]"
                      }
                      value={t.time}
                      onChange={(e) =>
                        update({
                          triggers: draft.triggers.map((x) =>
                            x.id === t.id ? { ...x, time: e.target.value } : x,
                          ),
                        })
                      }
                    />
                    <span>{tz}</span>
                    <small className="ui-cloud-trigger-next">
                      {draft.enabled
                        ? routineNextRun({ ...draft, triggers: [t] }, tz)
                        : "Paused"}
                    </small>
                  </>
                ) : t.type === "GitHub" ? (
                  <RoutineGithubTrigger
                    trigger={t}
                    onChange={(patch) =>
                      update({
                        triggers: draft.triggers.map((x) =>
                          x.id === t.id ? { ...x, ...patch } : x,
                        ),
                      })
                    }
                  />
                ) : backend ? (
                  <code>
                    {backend.webhookUrl?.(t) ??
                      (current?.triggers.some((x) => x.id === t.id)
                        ? "Webhook address was shown once, when the routine was saved"
                        : "The webhook address and secret are shown once, after you save")}
                  </code>
                ) : (
                  <>
                    <code>https://example.test/hooks/{t.id.slice(0, 8)}</code>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        update({
                          triggers: draft.triggers.map((x) =>
                            x.id === t.id
                              ? { ...x, id: crypto.randomUUID() }
                              : x,
                          ),
                        });
                        setMessage(
                          "Example webhook URL rotated. Save to keep the change.",
                        );
                      }}
                    >
                      Rotate secret
                    </Button>
                  </>
                )}
                <Button
                  size="iconXs"
                  variant="ghost"
                  aria-label="Remove trigger"
                  onClick={() =>
                    update({
                      triggers: draft.triggers.filter((x) => x.id !== t.id),
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  <Plus />
                  Add trigger
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {(
                  backend?.triggerTypes ??
                  (["Scheduled", "GitHub", "Webhook"] as const)
                ).map((t) => (
                  <DropdownMenuItem key={t} onSelect={() => addTrigger(t)}>
                    {t}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {!validTriggers && (
              <p role="alert" className="ui-cloud-note">
                Enter a valid schedule and a value for each GitHub filter.
              </p>
            )}
            <h3 className="ui-cloud-routine-prompt-label">Prompt</h3>
            <div className="ui-cloud-routine-prompt">
              <Textarea
                aria-label="Routine prompt"
                placeholder="What should this routine do?"
                value={draft.prompt}
                onChange={(e) => update({ prompt: e.target.value })}
              />
              <div className="ui-cloud-routine-model">
                {needsAgent ? (
                  noModels
                ) : (
                  <ModelPicker
                    models={models.map((model) => ({ ...model, fast: false }))}
                    value={draft.model}
                    onChange={(model) => update({ model })}
                  />
                )}
              </div>
            </div>
          </div>
          <aside className="ui-cloud-routine-runs">
            <header>
              <h3>Runs</h3>
              <small>{routineNextRun(draft, tz)}</small>
            </header>
            {!current?.runs.length && (
              <p>
                {current?.runCount
                  ? `${current.runCount} ${current.runCount === 1 ? "run" : "runs"} · each opens a workspace on Home`
                  : "No runs yet"}
              </p>
            )}
            {current?.runs.map((run) => (
              <ContextMenu key={run.id}>
                <ContextMenuTrigger asChild>
                  <button
                    className="ui-cloud-routine-run"
                    onClick={() => onOpenWorkspace(run.id)}
                  >
                    {run.status === "Completed" ? (
                      <Check size={15} className="ui-cloud-run-success" />
                    ) : run.status === "Failed" ? (
                      <CircleX size={15} />
                    ) : (
                      <LoaderCircle size={15} />
                    )}
                    <strong>{run.status}</strong>
                    <span>{run.time}</span>
                    <ArrowUpRight size={12} />
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => onOpenWorkspace(run.id)}>
                    Open workspace
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() =>
                      setMessage("Run workspace archived in this example.")
                    }
                  >
                    Archive
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </aside>
        </div>
      ) : (
        <div className="ui-cloud-routine-list">
          <div className="ui-cloud-routine-table">
            <table>
              <thead>
                <tr>
                  {["Name", "Runs", "Last run", "Next run", "Author", ""].map(
                    (h) => (
                      <th key={h}>{h}</th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {routines.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button onClick={() => open(r)}>{r.name}</button>
                    </td>
                    <td>{r.runCount ?? r.runs.length}</td>
                    <td>{r.lastRunLabel ?? r.runs[0]?.time ?? "—"}</td>
                    <td>{routineNextRun(r, tz)}</td>
                    <td>{backend?.author.name ?? "You"}</td>
                    <td>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="iconXs"
                            aria-label={`Actions for ${r.name}`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem
                            onSelect={() =>
                              open({
                                ...r,
                                id: crypto.randomUUID(),
                                name: r.name + " copy",
                                runs: [],
                                versions: [],
                              })
                            }
                          >
                            <Copy />
                            Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!!backend?.readOnlyReason}
                            title={backend?.readOnlyReason}
                            onSelect={() =>
                              onChange(
                                routines.map((x) =>
                                  x.id === r.id
                                    ? { ...x, enabled: !x.enabled }
                                    : x,
                                ),
                              )
                            }
                          >
                            {r.enabled ? "Pause" : "Resume"}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setDeleting(r.id)}>
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!routines.length && <p>Add your first routine</p>}
          <h3>Suggested routines</h3>
          <div className="ui-cloud-routine-suggestions">
            {[
              [
                "Daily standup",
                "Summarize recent pull requests and open work.",
              ],
              [
                "Find papercuts",
                "Review the interface and identify small usability fixes.",
              ],
              [
                "Check dependencies",
                "Review dependency updates and run relevant checks.",
              ],
            ].map(([name, prompt]) => (
              <button
                key={name}
                onClick={() =>
                  open({
                    id: crypto.randomUUID(),
                    name,
                    prompt,
                    repository: defaultRepository,
                    model: { model: defaultModel, effort: "High" },
                    enabled: true,
                    triggers: [
                      {
                        id: crypto.randomUUID(),
                        type: "Scheduled",
                        schedule: "Every weekday",
                        time: "09:00",
                        event: "",
                        filter: "",
                      },
                    ],
                    runs: [],
                    versions: [],
                  })
                }
              >
                <strong>{name}</strong>
                <p>{prompt}</p>
                <small>Every weekday at 9:00</small>
              </button>
            ))}
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="ui-cloud-note">
          {message}
        </p>
      )}
      <Dialog open={history} onOpenChange={setHistory}>
        <DialogContent>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Previous saved routine settings.
          </DialogDescription>
          {draft?.versions.map((v, i) => (
            <div key={i} className="ui-cloud-row">
              <span>
                {v.name} · {v.time}
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  update({
                    name: v.name,
                    prompt: v.prompt,
                    ...(v.repository && { repository: v.repository }),
                    ...(v.model && { model: v.model }),
                    ...(v.enabled !== undefined && { enabled: v.enabled }),
                    ...(v.triggers && {
                      triggers: structuredClone(v.triggers),
                    }),
                  });
                  setHistory(false);
                }}
              >
                Revert
              </Button>
            </div>
          ))}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(undefined)}
      >
        <DialogContent>
          <DialogTitle>Delete routine?</DialogTitle>
          <DialogDescription>
            {backend
              ? "This removes the routine from your organization. Workspaces it already opened stay on Home."
              : "This removes the routine and its run history from this local example."}
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleting) void removeRoutine(deleting);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={discard}
        onOpenChange={(open) => {
          setDiscard(open);
          if (!open) pendingNavigation.current = undefined;
        }}
      >
        <DialogContent>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>
            Save or discard changes before continuing.
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setDiscard(false);
                pendingNavigation.current = undefined;
              }}
            >
              Keep editing
            </Button>
            <Button
              onClick={() => {
                setDraft(undefined);
                setId(undefined);
                setDiscard(false);
                const proceed = pendingNavigation.current;
                pendingNavigation.current = undefined;
                proceed?.();
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RoutineGithubTrigger({
  trigger,
  onChange,
}: {
  trigger: RoutineTrigger;
  onChange: (patch: Partial<RoutineTrigger>) => void;
}) {
  const filters =
    trigger.filters ??
    (trigger.filter
      ? [
          {
            id: "legacy",
            field: "label" as const,
            operator: "is" as const,
            value: trigger.filter,
          },
        ]
      : []);
  const update = (id: string, patch: Partial<RoutineGithubFilter>) =>
    onChange({
      filters: filters.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
      filter: "",
    });
  return (
    <div className="ui-cloud-github-trigger">
      <div className="ui-cloud-github-event">
        <Select
          aria-label="GitHub event"
          value={trigger.event}
          onChange={(event) => onChange({ event })}
          options={["PR opened", "PR pushed", "PR merged"].map((value) => ({
            value,
            label: value,
          }))}
        />
        <Button
          variant="ghost"
          size="xs"
          onClick={() =>
            onChange({
              filters: [
                ...filters,
                {
                  id: crypto.randomUUID(),
                  field: "label",
                  operator: "is",
                  value: "",
                },
              ],
              filter: "",
            })
          }
        >
          <Plus /> Filter
        </Button>
      </div>
      {filters.map((filter, index) => (
        <div className="ui-cloud-github-filter" key={filter.id}>
          <span>{index === 0 ? "where" : "and"}</span>
          <Select
            aria-label={`Filter field ${index + 1}`}
            value={filter.field}
            onChange={(field) =>
              update(filter.id, {
                field: field as RoutineGithubFilter["field"],
                value: "",
              })
            }
            options={[
              { value: "label", label: "Label" },
              { value: "author", label: "Author" },
              { value: "base_branch", label: "Base branch" },
            ]}
          />
          <Select
            aria-label={`Filter operator ${index + 1}`}
            value={filter.operator}
            onChange={(operator) =>
              update(filter.id, {
                operator: operator as RoutineGithubFilter["operator"],
              })
            }
            options={[
              { value: "is", label: "is" },
              { value: "is_not", label: "is not" },
            ]}
          />
          <Input
            aria-label={`Filter value ${index + 1}`}
            aria-invalid={!filter.value.trim()}
            value={filter.value}
            placeholder={
              filter.field === "label"
                ? "Label"
                : filter.field === "author"
                  ? "GitHub username"
                  : "Branch"
            }
            onChange={(event) =>
              update(filter.id, { value: event.target.value })
            }
          />
          <Button
            variant="ghost"
            size="iconXs"
            aria-label={`Remove filter ${index + 1}`}
            onClick={() =>
              onChange({
                filters: filters.filter((item) => item.id !== filter.id),
                filter: "",
              })
            }
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </div>
  );
}
