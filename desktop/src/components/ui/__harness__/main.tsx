// The shell's chrome, rendered on its own.
//
// Dev-server only — reached at /chrome-harness.html, never bundled (Vite's
// build input is index.html). Every scene is the real component, so what you
// see here is what the surface wears.
//
// It exists because chrome is the part of the app that is hardest to look at:
// the real Tasks header is three clicks into a project, and the thing that
// actually has to be right about a tab strip — that it meets the bar's rule,
// that it doesn't nest one hairline inside another, that the selected cell
// still reads as selected when the theme flips — is invisible to a unit test
// and invisible in a full-window screenshot of whatever page happened to be
// open.
//
// `PAGE=chrome-harness.html node scripts/collab-screens.mjs` drives this page
// and captures each `[data-scene]` separately, in both themes.

import { StrictMode, useState } from "react";
import type { JSX } from "react";
import ReactDOM from "react-dom/client";

import { Filter, Plus, Search } from "lucide-react";

import { Button } from "../button";
import { Segment } from "../segment";
import { SurfaceHeader } from "../SurfaceHeader";
import { WorkLensTabs } from "../../tasks/WorkLensTabs";
import { FleetLensTabs, type Lens } from "../../workspaces/FleetLensTabs";
import { TraceTabs } from "../../trace/TraceTabs";
import type { TraceHandlers } from "../../trace/traceDestinations";
import type { WorkLens } from "../../../lib/workRoute";
import { TooltipProvider } from "../tooltip";
import "../../../styles.css";

const noop = () => undefined;

/** Every destination, wired to nothing. Spelled out rather than cast, so the
 *  day a destination is added this file stops compiling instead of quietly
 *  shooting a strip with a missing tab in it. */
const traceHandlers: TraceHandlers = {
  onOverview: noop,
  onSessions: noop,
  onTeamActivity: noop,
  onCostUsage: noop,
  onIntentAst: noop,
  onReview: noop,
  onChecks: noop,
  onImpacts: noop,
  onProve: noop,
  onRewind: noop,
  onTimeline: noop,
  onAttest: noop,
  onCodeMap: noop,
  onMemory: noop,
  onDoctor: noop,
};

/** One captured frame: a title, a line of intent, and the component itself. */
function Scene({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section style={{ marginBottom: 40 }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          opacity: 0.55,
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 10 }}>{note}</div>
      {/* No padding and no border of its own: a header's whole job is to sit
          against the page's edge, and a frame around it would put a second
          hairline next to the one being judged. */}
      <div data-scene={id} style={{ background: "var(--color-bg-content)" }}>
        {children}
      </div>
    </section>
  );
}

function Harness(): JSX.Element {
  const [lens, setLens] = useState<WorkLens>("list");
  const [fleet, setFleet] = useState<Lens>("all");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");

  return (
    <TooltipProvider>
      <div
        style={{
          padding: 28,
          fontFamily: "var(--font-sans, system-ui)",
          minHeight: "100vh",
        }}
      >
        <Scene
          id="header-tabs"
          title="Surface header. The Tasks strip in its bar"
          note="Full-height cells on the header's own rule, divided by a hairline, the selected one marked by a 2px accent rail and nothing else. The count and the actions keep their centre line."
        >
          <div>
            <SurfaceHeader
              tabs={
                <>
                  <WorkLensTabs lens={lens} onLens={setLens} />
                  <span className="truncate text-xs text-text-5">
                    18 of 141 tasks
                  </span>
                </>
              }
              actions={
                <>
                  <Button variant="ghost" size="sm">
                    <Search className="h-3.5 w-3.5" aria-hidden />
                    Search
                  </Button>
                  <Button variant="ghost" size="sm">
                    <Filter className="h-3.5 w-3.5" aria-hidden />
                    Filters
                  </Button>
                  <Button size="sm">
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    New task
                  </Button>
                </>
              }
            />
            {/* A strip of page under the bar. Without it the rail the selected
                tab paints has nothing to join, which is the whole claim. */}
            <div style={{ height: 56 }} />
          </div>
        </Scene>

        <Scene
          id="header-tabs-middle"
          title="Same strip, second tab selected"
          note="The rail moves; nothing else does. Cells keep their width, so the strip cannot appear to resize under the cursor."
        >
          <div>
            <SurfaceHeader
              tabs={<WorkLensTabs lens="board" onLens={() => undefined} />}
            />
            <div style={{ height: 56 }} />
          </div>
        </Scene>

        <Scene
          id="fleet-tabs"
          title="Workspaces. The fleet lens, with its glyphs"
          note="A label alone is a tab you can only learn by clicking it. Each lens now carries a mark — the list and the lanes are Tasks' own two glyphs, so the strip reads the same on both surfaces, and Live gets a pulse because it is the only lens that asks the backend anything. The hint is the cell's tooltip."
        >
          <div>
            <SurfaceHeader
              tabs={<FleetLensTabs lens={fleet} onLens={setFleet} />}
              actions={
                <Button variant="accentSoft" size="sm">
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  New workspace
                </Button>
              }
            />
            <div style={{ height: 56 }} />
          </div>
        </Scene>

        <Scene
          id="trace-tabs"
          title="Trace. The same strip, and the line it draws"
          note="Nine places are tabs; the two questions on the right hand work to Aura and change nothing below, so they are buttons and now visibly a different kind of control."
        >
          <div>
            <TraceTabs
              repoRoot="/Users/you/project"
              handlers={traceHandlers}
              activeKey="timeline"
              impactsCount={3}
            />
            <div style={{ height: 56 }} />
          </div>
        </Scene>

        <Scene
          id="segment-vs-tabs"
          title="The other control, for contrast"
          note="Segment answers a question inside the page and has to look like a control wherever it lands, so it keeps its track. Tabs answer which page, and the bar is their frame."
        >
          <div style={{ padding: 12 }}>
            <Segment<"newest" | "oldest">
              value={sort}
              onChange={setSort}
              ariaLabel="Sort direction"
              options={[
                { value: "newest", label: "Newest" },
                { value: "oldest", label: "Oldest" },
              ]}
            />
          </div>
        </Scene>
      </div>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("chrome-harness") as HTMLElement).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
