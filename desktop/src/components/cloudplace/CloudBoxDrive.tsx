// The pieces of a workspace one of the team's computers answers by itself:
// the button that hands it a workspace, the line that says it is working on
// the newest prompt, and the reading again that brings its answer in.
//
// Nothing here reaches the computer. Handing it the workspace is one call to
// the cloud; from then on every member's send goes the normal way and the
// computer's answer arrives on the log like any other reply.

import { useEffect, useState } from "react";

import { api } from "../../lib/api";
import { auraComputerStatus, stillWaking, type AuraComputer } from "../../lib/auraComputer";
import { boxComputersOf, handToComputer, type BoxComputer } from "../../lib/cloudBoxDrive";
import { setCloudNotice } from "../../lib/cloudPlace";
import type { CloudMessageRow } from "../../lib/cloudWorkspacesApi";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ChatStatus } from "../ui/message";
import { reloadCloudPlace } from "./cloudPlaceStore";

/** How often a waiting prompt's answer is looked for. */
const ANSWER_POLL_MS = 5_000;
/** How often a computer woken by a prompt is asked whether it's back. */
const WAKE_POLL_MS = 5_000;

/** The team's computers a workspace can be handed to, read each time `ask`
 *  turns true. Null until the board answers; empty when it couldn't. */
export function useBoxComputers(ask: boolean): BoxComputer[] | null {
  const [computers, setComputers] = useState<BoxComputer[] | null>(null);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    void api
      .placesList()
      .then((r) => boxComputersOf(r))
      .catch(() => [])
      .then((c) => live && setComputers(c));
    return () => {
      live = false;
    };
  }, [ask]);
  return ask ? computers : null;
}

/** The line under the "no computer" notice that says what handing it over does. */
export function handOverLine(computers: readonly BoxComputer[], on: string): string {
  const who = computers.length === 1 ? computers[0]!.name : "one of your team’s computers";
  return `Run it on ${who}: it answers everyone’s messages here on ${on}, even when your laptop is closed.`;
}

/** "Run on <computer>", or a menu of them when the team has several. */
export function HandToComputer({
  workspaceId,
  branch,
  computers,
  onStep,
}: {
  workspaceId: string;
  /** The workspace's branch: the one the computer works on and pushes to. */
  branch?: string | null;
  computers: readonly BoxComputer[];
  /** What is happening now, or null once it is done; an error says what failed. */
  onStep: (step: { busy: string } | { error: string } | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const hand = async (c: BoxComputer) => {
    if (busy) return;
    setBusy(true);
    onStep({ busy: `Handing this workspace to ${c.name}…` });
    try {
      await handToComputer(workspaceId, c, branch);
      onStep(null);
      setCloudNotice(`${c.name} runs this workspace now. It answers what anyone sends here.`);
      await reloadCloudPlace();
    } catch (e) {
      onStep({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  if (computers.length === 1) {
    const only = computers[0]!;
    return (
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void hand(only)}>
        {busy ? <AsciiSpinner size={10} /> : null}
        {`Run on ${only.name}`}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary" disabled={busy}>
          {busy ? <AsciiSpinner size={10} /> : null}
          Run on a computer
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {computers.map((c) => (
          <DropdownMenuItem key={c.placeId} onSelect={() => void hand(c)}>
            {c.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The quiet line while the computer works on the newest prompt — or, when
 *  that prompt woke the team's sleeping Aura computer, while it boots. */
export function CloudBoxWorking({
  machine,
  prompt,
}: {
  machine: string;
  prompt?: Pick<CloudMessageRow, "id" | "waking"> | null;
}) {
  const waking = useComputerWaking(prompt);
  return <ChatStatus state="working">{waking ? "Waking the computer…" : `${machine} is working on it…`}</ChatStatus>;
}

/** Whether the prompt is still waiting on the boot it started. The server
 *  marks the prompt when the send woke the computer; from then the computer's
 *  own stage is read every few seconds until it is back, and not after. A
 *  read that fails keeps the server's word from the send. */
function useComputerWaking(prompt: Pick<CloudMessageRow, "id" | "waking"> | null | undefined): boolean {
  const flagged = !!prompt?.waking;
  const id = prompt?.id ?? null;
  const [computer, setComputer] = useState<AuraComputer | null | undefined>(undefined);
  useEffect(() => {
    setComputer(undefined);
    if (!flagged) return;
    let live = true;
    let t: ReturnType<typeof setInterval> | undefined;
    const read = () =>
      void auraComputerStatus().then(
        (s) => {
          if (!live) return;
          setComputer(s.computer);
          if (!stillWaking({ waking: true }, s.computer)) clearInterval(t);
        },
        () => {},
      );
    read();
    t = setInterval(read, WAKE_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [flagged, id]);
  return stillWaking(prompt, computer);
}

/** Read the log again every few seconds while a prompt waits for its answer,
 *  whether or not the live socket is up: the answer is written by the
 *  computer, not streamed by a laptop. */
export function useAnswerPoll(waitingId: string | null, read: () => Promise<void>): void {
  useEffect(() => {
    if (!waitingId) return;
    const t = setInterval(() => void read(), ANSWER_POLL_MS);
    return () => clearInterval(t);
  }, [waitingId, read]);
}
