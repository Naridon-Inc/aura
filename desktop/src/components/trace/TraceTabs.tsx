// TraceTabs — Trace's own strip, on the surface, above the view it switches.
//
// Trace used to be reached only through a 232px rail: click "Trace" in the nav
// and a second column appeared listing ten rows, of which one was showing. That
// column cost a seventh of the window to draw a menu that never changed, on a
// page whose content is wide tables and timelines. Workspaces and Mission
// Control already put their view switch ON the surface; Trace is the last page
// that made you keep a column open to change tabs.
//
// The split down the middle of this bar is the honest part. Seven of Trace's
// entries are PLACES — click and this area shows that. Two of them, Goals and
// Safety check, are not: they hand a question to Aura and the answer arrives in
// the chat, with nothing new rendering here at all. As rows in a menu that was
// merely vague. As tabs it would be a lie — a tab promises the area beneath it
// changes. So the places are tabs, on the left, in the app's tab control
// (`ui/tabs`, the same strip Tasks wears); the two questions are buttons, on
// the right, where every other verb in this app lives. Both read off the same
// TRACE_DESTINATIONS list the rail reads, so the two entrances can never drift
// apart.

import type { JSX, ReactNode } from "react";

import { ViewTabs, type ViewTabOption } from "../ui/tabs";
import { SurfaceHeader } from "../ui/SurfaceHeader";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Select, type SelectOption } from "../ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
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

/** The strip's icon wrapper — the same 24-viewbox, 1.7-stroke line art the
 *  rail draws, so a destination wears one mark wherever you meet it. Sized by
 *  the cell (`[&_svg]:size-3`) rather than here. */
function TabGlyph({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** One of the two questions, as a button. Deliberately NOT shaped like a tab:
 *  it doesn't change what the area below shows, so it shouldn't be able to look
 *  like the thing that does. A quiet 22px button, centred on the bar, is what
 *  every other verb in this app wears — and it now reads as a different kind of
 *  control at a glance, which is the honest answer, where before it borrowed an
 *  inactive Segment cell's shape and blurred the line the bar exists to draw. */
function AskButton({
  dest,
  busy,
  onRun,
}: {
  dest: TraceDestination;
  busy: boolean;
  onRun: () => void;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${dest.label} · ${dest.hint}`}
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={busy ? undefined : onRun}
          className="inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs font-medium text-text-3 transition-colors hover:bg-state-hover hover:text-text-1 disabled:cursor-default [&_svg]:size-3"
        >
          {busy ? <AsciiSpinner className="text-xs leading-none" /> : <TabGlyph>{dest.glyph}</TabGlyph>}
          {dest.label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[240px]">
        {dest.hint}
      </TooltipContent>
    </Tooltip>
  );
}

/** Which project Trace is reading — at the far end of the strip, opposite the
 *  views.
 *
 *  Trace is the surface where being on the wrong project is worst: every
 *  destination under it is a claim about history, and a timeline, an intent
 *  log or a code map from the folder you happen to have open looks exactly as
 *  authoritative as the one you meant. So the answer is named on the strip,
 *  always, and is a control wherever the surface underneath can follow it.
 *
 *  `switchable` is what decides that, and it is opt-in per host rather than
 *  free. Trace-as-a-page reads the shared place scope, so its strip writes the
 *  scope and the page moves with it. A Trace pane inside a work surface reads
 *  the root of the window it lives in and cannot follow — there the project is
 *  named and nothing more, because a switcher whose surface ignores it is the
 *  precise bug this strip keeps being asked to fix. */
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

  // One project is not a choice. Naming it is still worth the space; drawing a
  // menu that can only re-pick what it already shows is not — a control that
  // does nothing when clicked is the thing this strip should least resemble.
  if (!switchable || known.length < 2) {
    return (
      <span
        className="inline-flex h-[22px] max-w-[180px] items-center gap-1.5 px-2 text-xs text-text-3"
        title={value}
      >
        <FolderGlyph />
        <span className="truncate">
          {nameOf(value, known.find((k) => k.root === value)?.label)}
        </span>
      </span>
    );
  }

  const options: SelectOption[] = known.map((p) => ({
    value: p.root,
    label: nameOf(p.root, p.label),
  }));
  // The scope can point at a project the enumerator hasn't listed (a folder
  // opened directly, a registry that hasn't caught up). Carry it rather than
  // showing a blank trigger over a surface that is reading it.
  if (!known.some((p) => p.root === value)) {
    options.unshift({ value, label: nameOf(value) });
  }

  return (
    <Select
      value={value}
      onChange={setProjectScope}
      options={options}
      aria-label="Which project Trace is reading"
      align="end"
      className="h-[22px] max-w-[190px] text-xs"
    />
  );
}

function FolderGlyph(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.75 4.25c0-.55.45-1 1-1h3.1c.3 0 .58.13.77.36l.76.9c.19.23.47.36.77.36h5.33c.55 0 1 .45 1 1v6.02c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1V4.25z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
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

  const options: ViewTabOption<TraceKey>[] = places.map((d) => ({
    value: d.key,
    title: d.hint,
    icon: <TabGlyph>{d.glyph}</TabGlyph>,
    label:
      d.key === "impacts" && impactsCount > 0 ? (
        <span className="inline-flex items-center gap-1.5">
          {d.label}
          {/* Amber, like every other count in this app that is asking for you —
              an unresolved impact is an attention state, not a place. */}
          <span
            className="min-w-[16px] rounded-full bg-amber px-1 text-center text-2xs font-semibold tabular-nums text-bg-1"
            aria-label={`${impactsCount} ${impactsCount === 1 ? "impact" : "impacts"}`}
          >
            {impactsCount > 99 ? "99+" : impactsCount}
          </span>
        </span>
      ) : (
        d.label
      ),
  }));

  return (
    // `SurfaceHeader`, not a bar of its own. Trace drew its own 36px row while
    // Tasks put the identical strip in the shared 44px one, so the same control
    // was two heights and two left insets depending on which page you were on.
    // The bar was already the same idea drawn twice — tabs left, verbs right,
    // one hairline under — so this is that idea's one element.
    <SurfaceHeader
      tabs={
        <ViewTabs
          ariaLabel="Trace views"
          // ViewTabs wants a value from its own options; the two asking keys and
          // `null` belong to neither, and light nothing — which is correct, since
          // nothing on this surface changed when you pressed them.
          value={(activeKey ?? "") as TraceKey}
          onChange={(key) => {
            const dest = places.find((d) => d.key === key);
            dest?.run(handlers);
          }}
          options={options}
        />
      }
      actions={
        <>
          {asks.length > 0
            ? asks.map((d) => (
                <AskButton
                  key={d.key}
                  dest={d}
                  busy={busyKey === (d.key as "goals" | "review")}
                  onRun={() => d.run(handlers)}
                />
              ))
            : null}
          <span aria-hidden className="mx-0.5 h-4 w-px bg-line-soft" />
          <TraceProject repoRoot={repoRoot} switchable={switchProject} />
        </>
      }
    />
  );
}
