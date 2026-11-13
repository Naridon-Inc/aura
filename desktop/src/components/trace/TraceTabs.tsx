// TraceTabs — Trace's page header and the view strip under it.
//
// The header is the 40px bar every top-level page wears: the page's name on
// the left, its verbs on the right. The strip beneath it is the underline tab
// list the Dashboard uses to switch what the board shows. Every view is a tab
// with its name spelled out.
//
// The split between the two rows is the honest part. Most of Trace's entries
// are PLACES — click and this area shows that — so they are tabs, Goals among
// them (the list of what you asked for, each with its own Prove). Safety check
// is not: it hands a question to Aura and the answer arrives in the chat, with
// nothing new rendering here at all. A tab promises the area beneath it
// changes, so that one is a button in the header, where every other verb in
// this app lives. Both rows read off the same TRACE_DESTINATIONS list, so the
// two can never drift apart.

import type { JSX } from "react";
import { Folder } from "lucide-react";

import { Button } from "../ui/button";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  TraceFilterMenu,
  TraceHeader,
  TraceStrip,
  type TraceStripOption,
} from "../ui/trace-page";
import {
  placeRootOf,
  projectNameFromRoot,
  setProjectScope,
  useKnownProjects,
  useProjectScope,
} from "../../lib/projectRoots";
import { humanizeWorkspaceName } from "../../lib/workspaceLabel";
import {
  visibleTraceDestinations,
  type TraceDestination,
  type TraceHandlers,
  type TraceKey,
} from "./traceDestinations";

/** A question to Aura, as a quiet header button. It doesn't change what
 *  the area below shows, so it must not look like the thing that does. While
 *  Aura is answering, the button holds the spinner and refuses a second click
 *  — a second click would buy a second agent turn. */
function AskButton({
  dest,
  busy,
  onRun,
}: {
  dest: TraceDestination;
  busy: boolean;
  onRun: () => void;
}): JSX.Element {
  const Icon = dest.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`${dest.label} · ${dest.hint}`}
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={busy ? undefined : onRun}
        >
          {busy ? <AsciiSpinner /> : <Icon />}
          {dest.label}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[240px]">
        {dest.hint}
      </TooltipContent>
    </Tooltip>
  );
}

/** Which project Trace is reading — at the far end of the header.
 *
 *  Trace is the surface where being on the wrong project is worst: every view
 *  under it is a claim about history, and a timeline from the folder you
 *  happen to have open looks exactly as authoritative as the one you meant. So
 *  the answer is named in the header, always, and is a control wherever the
 *  surface underneath can follow it.
 *
 *  `switchable` decides that, and it is opt-in per host. Trace-as-a-page reads
 *  the shared place scope, so its header writes the scope and the page moves
 *  with it. A Trace pane inside a work surface reads the root of the window it
 *  lives in and cannot follow — there the project is named and nothing more,
 *  because a switcher whose surface ignores it is the bug this exists to fix. */
function TraceProject({
  repoRoot,
  switchable,
}: {
  repoRoot: string;
  switchable: boolean;
}): JSX.Element | null {
  const known = useKnownProjects(repoRoot);
  const scope = useProjectScope();
  const value = switchable ? placeRootOf(scope, repoRoot, known) : repoRoot;

  const nameOf = (root: string, label?: string) =>
    label?.trim() || humanizeWorkspaceName(root, projectNameFromRoot(root));

  // No root at all is the one case with nothing true to say.
  if (!value) return null;

  // One project is not a choice. Naming it is still worth the space; a menu
  // that can only re-pick what it already shows is not.
  if (!switchable || known.length < 2) {
    return (
      <span className="ui-trace-header-project" title={value}>
        <Folder size={14} />
        <span>{nameOf(value, known.find((k) => k.root === value)?.label)}</span>
      </span>
    );
  }

  const options = known.map((p) => ({ value: p.root, label: nameOf(p.root, p.label) }));
  // The scope can point at a project the enumerator hasn't listed (a folder
  // opened directly, a registry that hasn't caught up). Carry it rather than
  // showing a blank trigger over a surface that is reading it.
  if (!known.some((p) => p.root === value)) {
    options.unshift({ value, label: nameOf(value) });
  }

  return (
    <TraceFilterMenu
      label="Which repository Trace is reading"
      icon={<Folder />}
      value={value}
      options={options}
      onChange={setProjectScope}
      align="end"
    />
  );
}

export function TraceTabs({
  repoRoot,
  switchProject = false,
  handlers,
  activeKey,
  impactsCount = 0,
  busyKey = null,
}: {
  /** The project the surface below is reading. */
  repoRoot: string;
  /** Whether that surface follows the shared place scope. Only Trace-as-a-page
   *  does; a Trace pane is bound to its window's repo. See `TraceProject`. */
  switchProject?: boolean;
  handlers: TraceHandlers;
  /** Which destination the surface below is showing. `null` (or one of the two
   *  asking keys) simply lights nothing. */
  activeKey: TraceKey | null;
  impactsCount?: number;
  busyKey?: "goals" | "review" | null;
}): JSX.Element {
  const visible = visibleTraceDestinations(impactsCount);
  const places = visible.filter((d) => !d.asks);
  const asks = visible.filter((d) => d.asks);

  const options: TraceStripOption<TraceKey>[] = places.map((d) => {
    const Icon = d.icon;
    return {
      value: d.key,
      label: d.label,
      hint: d.hint,
      icon: <Icon />,
      // An unresolved impact is an attention state; the count says how many.
      count: d.key === "impacts" ? impactsCount : undefined,
    };
  });
  const lit = places.some((d) => d.key === activeKey) ? activeKey : null;

  return (
    <>
      <TraceHeader
        title="Trace"
        actions={
          <>
            {asks.map((d) => (
              <AskButton
                key={d.key}
                dest={d}
                busy={busyKey === (d.key as "goals" | "review")}
                onRun={() => d.run(handlers)}
              />
            ))}
            {asks.length > 0 && <span aria-hidden className="ui-trace-header-divider" />}
            <TraceProject repoRoot={repoRoot} switchable={switchProject} />
          </>
        }
      />
      <TraceStrip
        ariaLabel="Trace views"
        value={lit}
        options={options}
        onChange={(key) => places.find((d) => d.key === key)?.run(handlers)}
      />
    </>
  );
}
