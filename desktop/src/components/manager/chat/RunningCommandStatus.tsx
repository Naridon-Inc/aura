import { useEffect, useMemo, useState } from "react";
import type { StreamBlock } from "./types";
import { describeTool } from "./toolDescribe";
import { formatLiveDuration } from "../../../lib/duration";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { ChatStatus } from "../../ui/message";
import "../../ui/live-strips.css";

// ── Live running-command status (#3) ─────────────────────────────────────
//
// The in-flight tool card above shows WHICH command is running; this adds the
// live feedback it lacked — a spinner + a 1s-ticking elapsed timer so a slow
// command (e.g. `aura propose-plan`) visibly keeps working instead of sitting
// as a static line that reads as hung. Undocked it is the chat's own working
// status line; docked it is the strip that sits on the composer. The timer is a
// small `setInterval` that resets whenever the running command changes and
// tears down when nothing is in flight.
//
// True live STDOUT is intentionally NOT shown: neither stream channel
// (`manager-stream` / `manager-chat-chunk`) carries incremental tool output —
// the `tool_result` only lands once, AFTER the command finishes — so the front
// end has no partial output to render. Surfacing it would require a backend
// `ToolProgress`/`ChatChunk::ToolStdout` streaming field; until that exists this
// is the honest quick win on the data we already have. Never fake output.

type RunningToolBlock = StreamBlock & { kind: "tool" };

/** Friendly one-line label for the running command — the full shell command
 *  when the registry extracted one (so `Running aura propose-plan` reads as the
 *  real command), else the verb + subject ("Running propose-plan"). Falls back
 *  to a bare "Running" so the row is never blank. */
function runningLabel(tool: RunningToolBlock): { verb: string; detail: string | null; mono: boolean } {
  const view = describeTool(tool.name, tool.input, undefined);
  if (view.command) {
    return { verb: "Running", detail: view.command, mono: true };
  }
  const detail = view.subject ?? null;
  // The registry verb is present-continuous ("Running" / "Reading"); keep it as
  // the live verb so the row reads as in-flight.
  return { verb: view.verb || "Running", detail, mono: !!view.mono };
}

// `docked` mode renders the strip flush atop the composer, in the same docked
// frame the queued-message strip uses (rounded top, no bottom seam), so it reads
// as part of the composer chrome rather than a loose card mid-stream. The
// default (undocked) variant is the chat's working status line, kept for any
// in-stream callers.
export function RunningCommandStatus({
  tool,
  docked = false,
}: {
  tool: RunningToolBlock;
  docked?: boolean;
}) {
  // Anchor on the block's own start stamp, not this component's mount time.
  // The stamp rides along in the durable block mirror, so a workspace switch
  // mid-command comes back reading "1m 24s" instead of restarting at 0 — the
  // restart is what made a still-running command look like it had been
  // relaunched. Falls back to now for a block with no stamp.
  // Memoized per command so an unstamped block's `Date.now()` fallback stays
  // fixed instead of moving every render (which would tear down and rebuild
  // the interval on each paint).
  const start = useMemo(
    () => tool.started_at ?? Date.now(),
    [tool.tool_use_id, tool.started_at],
  );
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, (Date.now() - start) / 1000),
  );
  // Re-anchor whenever the running command changes. The interval ticks at
  // 10Hz — the row renders a tenth, and a counter that only moves once a
  // second sits frozen beside a spinning glyph, which is what a wedged
  // command looks like. Tears down on unmount / when the running tool swaps,
  // so it's never left dangling.
  useEffect(() => {
    const tick = () => setElapsed(Math.max(0, (Date.now() - start) / 1000));
    tick();
    const iv = window.setInterval(tick, 100);
    return () => window.clearInterval(iv);
  }, [start]);

  const { verb, detail, mono } = runningLabel(tool);
  const label = (
    <>
      <span className="ui-running-verb">{verb}</span>
      {detail && (
        <span
          className="ui-running-detail"
          data-mono={mono ? "" : undefined}
          title={detail}
        >
          {detail}
        </span>
      )}
    </>
  );
  // Live elapsed, in tenths, so a long run visibly keeps working.
  const clock =
    elapsed > 0 ? <span className="ui-running-clock">{formatLiveDuration(elapsed)}</span> : null;
  if (!docked) {
    return (
      <ChatStatus state="working" action={clock}>
        <span className="ui-running-status" aria-live="polite">
          {label}
        </span>
      </ChatStatus>
    );
  }
  return (
    <div className="ui-message-queue ui-running-docked" data-docked role="status" aria-live="polite">
      <div className="ui-queue-caption">
        <span className="ui-running-status">
          <AsciiSpinner />
          {label}
        </span>
        {clock}
      </div>
    </div>
  );
}
