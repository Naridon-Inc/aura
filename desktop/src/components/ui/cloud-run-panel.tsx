import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Play,
  Square,
  Plus,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  RotateCw,
} from "lucide-react";
import { Button } from "./button";
import { Kbd } from "./kbd";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Checkbox } from "./checkbox";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./dropdown-menu";

export type CloudRunState = "idle" | "starting" | "running" | "failed";

/** One command the panel can run. */
export type CloudRunAction = { name: string; command: string; detail?: string };

/** A Run panel driven from outside: what it runs, where that stands, and
 *  what its buttons do. Given, the panel shows exactly this and keeps no run
 *  of its own. */
export type CloudRunControl = {
  actions: readonly CloudRunAction[];
  /** The action the button starts. */
  selected: string | null;
  onSelect: (name: string) => void;
  state: CloudRunState;
  /** What the running command has printed. */
  output?: string;
  /** The line under the button while nothing runs. */
  note?: string;
  onStart: () => void;
  onStop: () => void;
  /** Opens the command's own terminal; given, the output offers it. */
  onOpen?: () => void;
};

export function CloudRunPanel({
  available,
  children,
  onRun,
  run,
}: {
  available: boolean;
  children?: ReactNode;
  onRun?: () => void;
  run?: CloudRunControl;
}) {
  const onRunRef = useRef(onRun);
  useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);
  const [state, setState] = useState<
      "idle" | "starting" | "running" | "failed"
    >("idle"),
    [collapsed, setCollapsed] = useState(false),
    [height, setHeight] = useState(() =>
      Math.min(600, Math.round(window.innerHeight * 0.48)),
    );
  const [adding, setAdding] = useState(false);
  const [actionName, setActionName] = useState("");
  const [command, setCommand] = useState("");
  const [destinations, setDestinations] = useState<string[]>([
    "cloud",
    "local",
  ]);
  const [actions, setActions] = useState([
    { name: "Dev", command: "npm run dev", destinations: ["cloud", "local"] },
  ]);
  const [selectedAction, setSelectedAction] = useState("Dev");
  const selected = actions.find((action) => action.name === selectedAction);
  const canAdd =
    !!actionName.trim() &&
    !!command.trim() &&
    destinations.length > 0 &&
    !actions.some(
      (action) => action.name.toLowerCase() === actionName.trim().toLowerCase(),
    );
  const saveAction = () => {
    if (!canAdd) return;
    const name = actionName.trim();
    setActions((items) => [
      ...items,
      { name, command: command.trim(), destinations },
    ]);
    setSelectedAction(name);
    setState("idle");
    setAdding(false);
  };
  const drag = useRef<{ y: number; height: number } | null>(null);
  useEffect(() => {
    if (state !== "starting") return;
    const t = setTimeout(() => {
      setState(available ? "running" : "failed");
      if (available) onRunRef.current?.();
    }, 900);
    return () => clearTimeout(t);
  }, [state, available]);
  const start = () => {
    if (available && state !== "starting") setState("starting");
  };
  // What is shown: the caller's run when it drives the panel, else the
  // panel's own preview.
  const shown: CloudRunState = run ? run.state : state;
  const label = run ? (run.selected ?? "Run") : selectedAction;
  const shownCommand = run
    ? run.actions.find((action) => action.name === run.selected)?.command
    : selected?.command;
  const begin = () => {
    if (!available || shown === "starting") return;
    if (run) run.onStart();
    else start();
  };
  const end = () => (run ? run.onStop() : setState("idle"));
  const keys = useRef({ begin, end, shown, available });
  keys.current = { begin, end, shown, available };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "r" &&
        !document.querySelector('[role="dialog"],[role="menu"]')
      ) {
        event.preventDefault();
        const k = keys.current;
        if (k.available && k.shown !== "starting") {
          setCollapsed(false);
          if (k.shown === "running") k.end();
          else k.begin();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <section
      className="ui-cloud-run-panel"
      style={{ height: collapsed ? 36 : height }}
      aria-label="Run panel"
    >
      <div
        className="ui-cloud-run-resize"
        role="separator"
        aria-label="Resize Run panel"
        aria-orientation="horizontal"
        aria-valuenow={height}
        aria-valuemin={160}
        aria-valuemax={600}
        tabIndex={0}
        onPointerDown={(e) => {
          drag.current = { y: e.clientY, height };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current)
            setHeight(
              Math.max(
                160,
                Math.min(600, drag.current.height + drag.current.y - e.clientY),
              ),
            );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setHeight((h) =>
              Math.max(
                160,
                Math.min(600, h + (e.key === "ArrowUp" ? 16 : -16)),
              ),
            );
          }
        }}
      />
      <header>
        <Button
          variant="ghost"
          size="iconXs"
          aria-label={collapsed ? "Expand Run panel" : "Collapse Run panel"}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronRight /> : <ChevronDown />}
        </Button>
        <span>Run</span>
        {run ? (
          run.actions.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="iconXs" aria-label="Choose run command">
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {run.actions.map((action) => (
                  <DropdownMenuItem key={action.name} onSelect={() => run.onSelect(action.name)}>
                    {action.name}
                    {action.detail && <span className="ui-cloud-note">{action.detail}</span>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="iconXs" aria-label="Add run action">
              <Plus />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {actions.map((action) => (
              <DropdownMenuItem
                key={action.name}
                onSelect={() => {
                  setSelectedAction(action.name);
                  setState("idle");
                }}
              >
                {action.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              onSelect={() => {
                setActionName("");
                setCommand("");
                setDestinations(["cloud", "local"]);
                setAdding(true);
              }}
            >
              <Plus /> Add action
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setState("failed")}>
              Preview failed action
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        )}
        <div className="ui-cloud-run-spacer" />
        <Button
          variant="outline"
          size="xs"
          onClick={shown === "running" ? end : begin}
          disabled={shown === "starting" || !available}
        >
          {shown === "running" ? <Square /> : <Play />}
          {shown === "running" ? "Stop" : label}
          <Kbd>⌘R</Kbd>
        </Button>
      </header>
      {!collapsed &&
        (shown === "running" ? (
          <div className="ui-cloud-run-output">
            <pre>
              {shownCommand}
              {"\n"}
              {run ? (run.output ?? "") : "Local preview · action started"}
            </pre>
            {run?.onOpen && (
              <Button variant="outline" size="xs" onClick={run.onOpen}>
                Open in a terminal tab
              </Button>
            )}
            {children}
          </div>
        ) : (
          <div className="ui-cloud-run-empty">
            {shown === "starting" ? (
              <LoaderCircle size={36} />
            ) : shown === "failed" ? (
              <RotateCw size={36} />
            ) : (
              <Play size={40} fill="currentColor" />
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={shown === "starting" || !available}
              onClick={begin}
            >
              {shown === "starting"
                ? "Starting…"
                : shown === "failed"
                  ? `Retry ${label}`
                  : `Start ${label}`}
              {shown === "idle" && <Kbd>⌘R</Kbd>}
            </Button>
            <p>
              {!available
                ? (run?.note ?? "Wake the workspace to run commands.")
                : shown === "failed"
                  ? (run?.note ?? "The action stopped. Try running it again.")
                  : (run?.note ?? "Test your changes here.")}
            </p>
          </div>
        ))}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent
          style={{ maxWidth: 512 }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              saveAction();
            }
          }}
        >
          <DialogTitle>Add action</DialogTitle>
          <DialogDescription>
            Configure an action for this repository.
          </DialogDescription>
          <div className="ui-cloud-row">
            <Play size={20} />
            <Input
              aria-label="Action name"
              placeholder="Action name"
              value={actionName}
              onChange={(event) => setActionName(event.target.value)}
            />
          </div>
          <Textarea
            aria-label="Action command"
            placeholder="npm run dev"
            rows={4}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            style={{ fontFamily: "var(--ui-font-mono)" }}
          />
          <div className="ui-cloud-row" style={{ flexWrap: "wrap", gap: 16 }}>
            <span>Can run in</span>
            {[
              ["cloud", "Cloud workspace"],
              ["local", "Local mirror"],
            ].map(([value, label]) => (
              <label
                key={value}
                style={{ display: "flex", gap: 8, alignItems: "center" }}
              >
                <Checkbox
                  checked={destinations.includes(value)}
                  onCheckedChange={(checked) =>
                    setDestinations((items) =>
                      checked
                        ? [...items, value]
                        : items.filter((item) => item !== value),
                    )
                  }
                />
                {label}
              </label>
            ))}
          </div>
          {actionName.trim() &&
            actions.some(
              (action) =>
                action.name.toLowerCase() === actionName.trim().toLowerCase(),
            ) && <p role="alert">Action names must be unique.</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button disabled={!canAdd} onClick={saveAction}>
              Add action
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
