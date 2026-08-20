// The collab surface, rendered from the recorded wire.
//
// Dev-server only — reached at /collab-harness.html, never bundled (Vite's
// build input is index.html). Every scene below is the real component with the
// real state from `__fixtures__/wire-recording.json`, so what you see here is
// what a guest, a watcher and a host would see in the app. Nothing is mocked
// except the callbacks, which have nowhere to go without a Tauri host.
//
// `scripts/collab-screens.mjs` drives this page and captures each `[data-scene]`
// separately, in both themes.

import { StrictMode } from "react";
import type { JSX } from "react";
import ReactDOM from "react-dom/client";

import { lastWhere, replay } from "../__fixtures__/replay";
import { ParticipantsStrip } from "../ParticipantsStrip";
import { SessionStream } from "../SessionStream";
import { SessionComposer } from "../SessionComposer";
import { SessionTypingLine } from "../SessionTypingLine";
import { ShareSessionPanel } from "../share/ShareSessionPanel";
import { YourAccessBanner } from "../share/YourAccessBanner";
import { PeopleRail } from "../rail/PeopleRail";
import {
  RAIL_FIXTURE_ACTIVE_SESSION_ID,
  railFixtureGroups,
  railFixtureNow,
} from "../rail/railFixtures";
import { fromMsgFrame, mergeSessionStream } from "../collabTypes";
import { TooltipProvider } from "../../ui/tooltip";
import "../../../styles.css";

const guest = replay("guest");
const host = replay("host");
const watching = lastWhere(guest.steps, (s) => s.you?.access === "watch");
const driving = guest.final;

/** One captured frame: a title, a line of intent, and the component itself. */
function Scene({
  id,
  title,
  note,
  width = 720,
  children,
}: {
  id: string;
  title: string;
  note: string;
  width?: number;
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
      <div
        data-scene={id}
        style={{
          width,
          border: "1px solid var(--border, rgba(127,127,127,0.25))",
          borderRadius: 8,
          padding: 12,
          background: "var(--bg-elevated, transparent)",
        }}
      >
        {children}
      </div>
    </section>
  );
}

function Harness(): JSX.Element {
  // The store keeps the wire's own `msg` frames; the stream components take the
  // narrower `SessionMessage`. `fromMsgFrame` is that step, and going through
  // it here is deliberate — it is the same conversion any real mount would have
  // to do, so the harness cannot render something the app could not.
  const stream = mergeSessionStream(driving.entries, driving.messages.map(fromMsgFrame));
  const noop = () => undefined;

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
          id="rail"
          title="People rail. The sidebar with company in it"
          note="Two people, their agents, and what each session is doing. This is what the sidebar shows once somebody else is actually in a session; alone, it draws nothing at all (railHasCompany)."
          width={280}
        >
          <PeopleRail
            groups={railFixtureGroups()}
            activeSessionId={RAIL_FIXTURE_ACTIVE_SESSION_ID}
            onOpenSession={noop}
            onJoinSession={noop}
            nowSecs={railFixtureNow()}
          />
        </Scene>

        <Scene
          id="roster"
          title="Participants strip"
          note="Who is in the session: two people and the host's agent, straight off the wire."
        >
          <ParticipantsStrip
            participants={driving.participants}
            youId={driving.you?.id ?? null}
          />
        </Scene>

        <Scene
          id="stream"
          title="Shared transcript"
          note="The agent's output and the people's messages in one ordered list."
        >
          <SessionStream
            items={stream}
            participants={driving.participants}
            youId={driving.you?.id ?? null}
          />
        </Scene>

        <Scene
          id="composer-watch"
          title="Composer. Watcher"
          note="Access is watch: the box must not offer to send a turn to someone else's agent."
        >
          <div>
            <YourAccessBanner
              level="watch"
              hostName="Ashiq"
              hostMachine="ashiq-mbp"
              hostOnline={watching.hostOnline}
              onRequestDrive={noop}
            />
            <SessionComposer
              participants={watching.participants}
              youId={watching.you?.id ?? null}
              onSend={noop}
              hostOnline={watching.hostOnline}
              disabled
            />
          </div>
        </Scene>

        <Scene
          id="composer-drive"
          title="Composer. Promoted to drive"
          note="Same person after the host promoted them; now they can address the agent."
        >
          <div>
            <YourAccessBanner
              level="drive"
              hostName="Ashiq"
              hostMachine="ashiq-mbp"
              hostOnline={driving.hostOnline}
            />
            <SessionComposer
              participants={driving.participants}
              youId={driving.you?.id ?? null}
              onSend={noop}
              hostOnline={driving.hostOnline}
            />
          </div>
        </Scene>

        <Scene
          id="typing"
          title="Typing line"
          note="What the room is doing right now, under the stream."
        >
          <SessionTypingLine
            typing={driving.participants.filter(
              (p) => p.kind === "human" && p.id !== driving.you?.id,
            )}
            working={driving.participants.filter((p) => p.kind === "agent")}
            participants={driving.participants}
            youId={driving.you?.id ?? null}
          />
        </Scene>

        <Scene
          id="share"
          title="Share panel. Host"
          note="The host's side: the link, the level the link hands out, and everyone's access."
          width={560}
        >
          <ShareSessionPanel
            session={{
              externalId: "sess-e2e-001",
              title: "Retry backoff",
              hostMachine: "ashiq-mbp",
              hostName: "Ashiq",
              repoName: "e2e-org/demo",
              code: "e2e-demo",
              link: "https://auravcs.com/join/e2e-demo",
              defaultAccess: "watch",
              participants: [...host.final.participants],
              access: Object.fromEntries(
                host.final.participants.map((p) => [p.id, p.access]),
              ),
            }}
            repoName="e2e-org/demo"
            loading={false}
            error={null}
            onRetry={noop}
            onShare={noop}
            onStopSharing={noop}
            onDefaultAccessChange={noop}
            onAccessChange={noop}
            youId={host.final.you?.id ?? ""}
          />
        </Scene>
      </div>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("collab-harness") as HTMLElement).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
