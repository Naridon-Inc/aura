// "In the cloud" — the work this project handed to a machine that isn't this
// one.
//
// Every other row on this page is a copy on your disk. Cloud work has none: no
// worktree, no branch, nothing for the roster to draw. So a job sent from the
// composer was minted on the board and then had nowhere to appear — the card
// closed and the screen was exactly as it had been, which is how "it just went
// away, nothing appeared" happens.
//
// This section is that missing place. It is not a second copy list; it is the
// answer to "where did my work go", which is why it keeps rows the copy list
// can't: work with no branch, and work that has already finished — especially
// work that FAILED, since the runner's reason is the one thing that gets you
// unstuck and the badge view drops it the instant the job stops running.

import { useState, type ReactNode } from "react";

import { CloudGlyph } from "../ui/cloud-glyph";
import { AgentIcon } from "../agent/AgentIcon";
import { labelForAgentId } from "../../lib/useLiveAgentSessions";
import { isCloudJobRunning, type CloudJobWithRoot } from "../../lib/useCloudJobs";
import {
  chatSessionThatSent,
  cloudStatusLine,
  cloudThreadKey,
  orderCloudJobs,
  projectLabel,
} from "../../lib/cloudJobs";
import {
  openCloudThread,
  openManagerSession,
  openRemoteWorkspace,
} from "../../lib/editorStore";
import { relativeAgeFromDelta } from "../../lib/relativeTime";
import { CopyButton } from "../ui/copyButton";

/** Enough to answer "what happened to my work" at a glance without turning the
 *  page into a log. Older jobs stay on the board and in the cloud pane. */
const MAX_ROWS = 6;

function stampOf(iso: string | null, nowMs: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return relativeAgeFromDelta(Math.max(0, Math.floor((nowMs - at) / 1000)), {
    style: "compact",
  });
}

export function WorkspacesCloudSection({
  jobs,
  nowMs,
}: {
  jobs: CloudJobWithRoot[];
  nowMs: number;
}) {
  // Which row is open. One at a time: the point of the list is to scan it, and
  // several expanded rows turn it back into the log this section isn't.
  const [openId, setOpenId] = useState<string | null>(null);
  // The truncation is a kindness on a page you came to read, not a limit on
  // what you're allowed to see — so it is a control, not a note.
  const [showAll, setShowAll] = useState(false);

  // Nothing sent, nothing to say. An empty "In the cloud" heading on every
  // project would be noise on the majority of them.
  if (!jobs.length) return null;

  const ordered = orderCloudJobs(jobs, nowMs);
  const shown = showAll ? ordered : ordered.slice(0, MAX_ROWS);
  const hidden = ordered.length - shown.length;
  // Every task id on the board, so a row whose context is the request it
  // replies to doesn't offer a way back to a chat that never existed. Built
  // from the whole list, not the visible slice — the request being answered is
  // usually older than the six rows on screen.
  const taskIds = new Set(jobs.map((j) => j.id));

  return (
    <section>
      <div className="flex items-center gap-1.5 px-2 pb-1">
        <h3 className="text-xs font-medium text-text-4">In the cloud</h3>
        <span className="text-xs text-text-5 tabular-nums">{jobs.length}</span>
      </div>
      <div className="flex flex-col">
        {shown.map((job) => (
          <CloudJobRow
            key={job.id}
            job={job}
            taskIds={taskIds}
            nowMs={nowMs}
            open={openId === job.id}
            onToggle={() => setOpenId((id) => (id === job.id ? null : job.id))}
          />
        ))}
        {(hidden > 0 || showAll) && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="self-start rounded-md px-2 py-1 text-xs tabular-nums text-text-5 transition-colors hover:bg-state-hover hover:text-text-3"
          >
            {showAll ? "Show fewer" : `${hidden} older`}
          </button>
        )}
      </div>
    </section>
  );
}

function CloudJobRow({
  job,
  taskIds,
  nowMs,
  open,
  onToggle,
}: {
  job: CloudJobWithRoot;
  taskIds: ReadonlySet<string>;
  nowMs: number;
  open: boolean;
  onToggle: () => void;
}) {
  const { label, tint } = cloudStatusLine(job, nowMs);
  const who = labelForAgentId(job.agent);
  const running = isCloudJobRunning(job.status);
  const stamp = stampOf(job.created_at, nowMs);
  const project = projectLabel(job.repo);

  return (
    <div className="flex flex-col">
      {/* This row used to refuse to be a button, on the grounds that there is
          nothing on this machine to open. That was true of the *file system*
          and wrong about the row: the prompt is clipped to one line, the reason
          it failed is clipped with it, and what the machine actually reported
          back was on no screen at all. So it opens — not a checkout, the job
          itself. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left transition-colors ${
          open ? "bg-state-selected" : "hover:bg-state-hover"
        }`}
        title={job.error_message ? `${label} — ${job.error_message}` : label}
      >
        {/* Same glyph the copy rows wear for remote work, and it breathes under
            the same rule: only once a box has actually claimed the job. */}
        <span className="flex-none text-text-4">
          <CloudGlyph size={13} pulse={running && job.status !== "submitted"} />
        </span>
        <AgentIcon agentId={job.agent} label={who} size={16} />

        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-base text-text-1">
            {job.text?.trim() || "Cloud task"}
          </span>
          {/* The reason a job died is the whole value of showing a dead job. */}
          {job.error_message && (
            <span
              className="truncate text-xs"
              style={{ color: "var(--color-red)" }}
            >
              {job.error_message}
            </span>
          )}
        </div>

        {/* Which project it belongs to. Every copy row on this page names its
            project with an avatar; a cloud row had nothing at all, so on the
            all-projects scope it was the only work you couldn't place. */}
        {project && (
          <span className="flex-none max-w-[160px] truncate text-xs text-text-5">
            {project}
          </span>
        )}
        {job.branch && (
          <span className="flex-none max-w-[200px] truncate font-mono text-xs text-text-5">
            {job.branch}
          </span>
        )}
        <span className="flex-none text-xs" style={{ color: tint }}>
          {label}
        </span>
        <span className="w-10 flex-none text-right text-xs tabular-nums text-text-4">
          {stamp}
        </span>
      </button>

      {open && <CloudJobDetail job={job} taskIds={taskIds} />}
    </div>
  );
}

/** What the row could not say in one line: the whole request, whatever the
 *  machine reported back, and the way back to the conversation that sent it. */
function CloudJobDetail({
  job,
  taskIds,
}: {
  job: CloudJobWithRoot;
  taskIds: ReadonlySet<string>;
}) {
  const text = job.text?.trim() || "";
  const session = chatSessionThatSent(job, taskIds);
  return (
    <div className="ml-9 mb-1 flex flex-col gap-3 rounded-lg border border-line-soft px-3 py-2.5">
      {text && (
        <Block label="What was asked for">
          <p className="whitespace-pre-wrap break-words text-sm text-text-2">
            {text}
          </p>
        </Block>
      )}

      {/* A failure's reason is already on the row, clipped. Here it is whole —
          it is usually the one thing standing between you and a rerun. */}
      {job.error_message && (
        <Block label="Why it stopped">
          <p
            className="whitespace-pre-wrap break-words text-sm"
            style={{ color: "var(--color-red)" }}
          >
            {job.error_message}
          </p>
        </Block>
      )}

      {job.result && (
        <Block label="What the machine reported">
          <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs text-text-2">
            {job.result}
          </p>
        </Block>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-5">
        {job.repo && <span className="font-mono">{job.repo}</span>}
        {job.commit_sha && (
          <span className="font-mono" title={job.commit_sha}>
            {job.commit_sha.slice(0, 8)}
          </span>
        )}
        {/* The id is what you paste into `aura a2a task get` or hand to whoever
            runs the box, so it is here to be copied rather than read. */}
        <span className="flex items-center gap-1 font-mono">
          {job.id.slice(0, 8)}
          <CopyButton content={job.id} variant="mini" />
        </span>
        {/* Two different things you might want, and they are genuinely
            different places. The machine is where the work IS — going there
            gives you its shell and its agents, with this conversation as one
            tab. Reading it here keeps you in this workspace and just shows the
            record, which is the right move when the box is off or isn't yours. */}
        <button
          type="button"
          onClick={() =>
            openRemoteWorkspace({
              threadKey: cloudThreadKey(job),
              repoRoot: job.repoRoot,
            })
          }
          className="rounded-md px-1.5 py-0.5 font-medium text-accent transition-colors hover:bg-state-hover"
        >
          Open the machine
        </button>
        <button
          type="button"
          onClick={() => openCloudThread(cloudThreadKey(job), job.repoRoot)}
          className="rounded-md px-1.5 py-0.5 font-medium text-text-4 transition-colors hover:bg-state-hover hover:text-text-2"
        >
          Read it here
        </button>
        {/* Work handed over from a chat keeps its way back to that chat — the
            cloud thread is the machine's side of it, not a replacement. */}
        {session && (
          <button
            type="button"
            onClick={() => openManagerSession(session, text.slice(0, 60) || "Cloud task")}
            className="rounded-md px-1.5 py-0.5 font-medium text-text-4 transition-colors hover:bg-state-hover hover:text-text-2"
          >
            Open the chat that sent it
          </button>
        )}
      </div>
    </div>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-2xs font-medium uppercase tracking-wide text-text-5">
        {label}
      </div>
      {children}
    </div>
  );
}
