// A cloud conversation — the work you handed to a machine that isn't this one,
// read and answered the way you'd read and answer any other chat.
//
// Sending to the cloud used to end at a confirmation line: the card stayed open
// saying "sent", and there was no destination, because a cloud job has no
// worktree for the rail to draw and no local session for the chat view to read.
// So the natural question — "why didn't it open anything?" — had a real answer
// and a bad one: nothing existed to open.
//
// This is that destination. It is deliberately NOT a fake live transcript: the
// runner drains a board, it does not stream tokens here. What it shows is what
// genuinely exists — every task in the thread, in order, each one a thing you
// asked for and the machine's answer to it — and a reply box that appends the
// next task to the same A2A context, which is exactly how the runner learns you
// said something else.

import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../../lib/api";
import {
  cloudStatusLine,
  groupCloudThreads,
  type CloudThread,
} from "../../lib/cloudJobs";
import {
  isCloudJobRunning,
  refreshCloudJobs,
  useCloudJobs,
  type CloudJobWithRoot,
} from "../../lib/useCloudJobs";
import { openManagerSession } from "../../lib/editorStore";
import { labelForAgentId } from "../../lib/useLiveAgentSessions";
import { relativeAgeFromDelta } from "../../lib/relativeTime";
import { AgentIcon } from "../agent/AgentIcon";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copyButton";
import { CloudGlyph } from "../ui/cloud-glyph";

/** The agent a reply is addressed to when the thread can't say. Only reachable
 *  for a thread whose every row somehow lost its agent; every real row carries
 *  the one the send picked. */
const FALLBACK_AGENT = "claude";

function stampOf(iso: string | null, nowMs: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return relativeAgeFromDelta(Math.max(0, Math.floor((nowMs - at) / 1000)), {
    style: "compact",
  });
}

export function CloudThreadPane({
  threadKey,
  repoRoot,
}: {
  threadKey: string;
  /** The checkout whose board this thread came from. Empty when the thread was
   *  found by the account-wide read — the pane still reads, and says why it
   *  can't send. */
  repoRoot: string;
}) {
  // With a root, poll that repo's board; without one, the account-wide read is
  // the only place this thread is visible at all.
  const { jobs, loaded } = useCloudJobs(repoRoot ? [repoRoot] : null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Ages on a page you sit and watch have to move. One tick a minute is enough
  // for "2m" to become "3m" and costs nothing.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const thread = useMemo<CloudThread | null>(() => {
    const mine = groupCloudThreads(jobs).find((t) => t.key === threadKey);
    return mine ?? null;
  }, [jobs, threadKey]);

  if (!loaded && !thread) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-4">
        <AsciiSpinner /> <span className="ml-2">Reading the board…</span>
      </div>
    );
  }

  if (!thread) {
    // The board is the only record, and it has a retention window. Say that,
    // rather than showing an empty chat that implies nothing was ever said.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-sm text-text-3">This conversation isn’t on the board.</p>
        <p className="max-w-md text-xs text-text-5">
          Cloud work is kept for a while and then rolls off. If you sent this a
          long time ago, its record is gone — nothing on this machine held a copy.
        </p>
      </div>
    );
  }

  return <ThreadBody thread={thread} repoRoot={repoRoot} nowMs={nowMs} />;
}

function ThreadBody({
  thread,
  repoRoot,
  nowMs,
}: {
  thread: CloudThread;
  repoRoot: string;
  nowMs: number;
}) {
  const latest = thread.latest;
  const { label, tint } = cloudStatusLine(latest, nowMs);
  const agent = latest.agent || FALLBACK_AGENT;
  const who = labelForAgentId(agent);
  const running = isCloudJobRunning(latest.status);
  // Thread-level, not row-level: a reply keys itself by the id of the request
  // it answers, and only the thread can tell that id apart from a chat's.
  const chat = thread.chatSession;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // New turns arrive from a poll, not from typing, so the view has to follow
  // them or a reply's answer lands below the fold with nothing to say it did.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.jobs.length]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-line-soft px-4 py-2.5">
        <span className="flex-none text-text-4">
          <CloudGlyph size={14} pulse={running && latest.status !== "submitted"} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-text-1">{thread.title}</span>
          <span className="flex items-center gap-1.5 text-xs text-text-5">
            <span style={{ color: tint }}>{label}</span>
            <span>·</span>
            <span>{who}</span>
            {latest.repo && (
              <>
                <span>·</span>
                <span className="font-mono">{latest.repo}</span>
              </>
            )}
          </span>
        </div>
        {chat && (
          <Button
            variant="ghost"
            onClick={() => openManagerSession(chat, thread.title.slice(0, 60))}
            title="This work was handed over from a chat. Open it."
          >
            Open the chat that sent it
          </Button>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          {thread.jobs.map((job) => (
            <Turn key={job.id} job={job} nowMs={nowMs} agent={agent} />
          ))}
        </div>
      </div>

      <ReplyBox
        threadKey={thread.key}
        repoRoot={repoRoot}
        agent={agent}
        latestIsRunning={running}
      />
    </div>
  );
}

/** One exchange: what you asked, and whatever the machine has to say about it
 *  so far. They are one task on the board, which is why they are one block
 *  here rather than two unrelated bubbles. */
function Turn({
  job,
  nowMs,
  agent,
}: {
  job: CloudJobWithRoot;
  nowMs: number;
  agent: string;
}) {
  const { label, tint } = cloudStatusLine(job, nowMs);
  const asked = job.text?.trim() || "";
  const stamp = stampOf(job.created_at, nowMs);
  const answered = job.result || job.error_message;

  return (
    <div className="flex flex-col gap-2">
      {/* Yours. Right-aligned like every other chat in the app, so a thread
          reads as a conversation at a glance rather than as a log. */}
      {asked && (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl bg-surface-3 px-3.5 py-2">
            <p className="whitespace-pre-wrap break-words text-sm text-text-1">
              {asked}
            </p>
          </div>
        </div>
      )}

      <div className="flex gap-2.5">
        <span className="mt-0.5 flex-none">
          <AgentIcon agentId={job.agent || agent} label={labelForAgentId(job.agent || agent)} size={18} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {job.error_message && (
            <p
              className="whitespace-pre-wrap break-words text-sm"
              style={{ color: "var(--color-red)" }}
            >
              {job.error_message}
            </p>
          )}
          {job.result && (
            <p className="whitespace-pre-wrap break-words text-sm text-text-2">
              {job.result}
            </p>
          )}
          {/* Nothing has come back yet. The status IS the answer here, so it
              stands where the reply would be instead of only in the meta line
              — an empty space under a question reads as a dropped message. */}
          {!answered && (
            <p className="flex items-center gap-1.5 text-sm" style={{ color: tint }}>
              {isCloudJobRunning(job.status) && job.status !== "submitted" && (
                <AsciiSpinner />
              )}
              {label}
              {job.status === "submitted" && (
                <span className="text-text-5">
                  — it starts as soon as a machine is free
                </span>
              )}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-5">
            {answered && <span style={{ color: tint }}>{label}</span>}
            {job.commit_sha && (
              <span className="font-mono" title={job.commit_sha}>
                {job.commit_sha.slice(0, 8)}
              </span>
            )}
            {job.branch && <span className="font-mono">{job.branch}</span>}
            <span className="flex items-center gap-1 font-mono">
              {job.id.slice(0, 8)}
              <CopyButton content={job.id} variant="mini" />
            </span>
            {stamp && <span className="tabular-nums">{stamp}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Say something else to the machine.
 *
 *  A reply is a new task carrying the thread's context, not a keystroke into a
 *  live process — the runner claims tasks, it isn't holding a socket open for
 *  us. That difference is stated on screen rather than hidden behind a chat
 *  bubble, because it changes what you should expect: your words land when the
 *  box next looks at the board, and if it is mid-job they land after that job. */
function ReplyBox({
  threadKey,
  repoRoot,
  agent,
  latestIsRunning,
}: {
  threadKey: string;
  repoRoot: string;
  agent: string;
  latestIsRunning: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!repoRoot) {
    return (
      <div className="border-t border-line-soft px-4 py-3 text-xs text-text-5">
        This project isn’t open on this machine, so there’s nowhere to send a
        reply from. Open the project to keep the conversation going.
      </div>
    );
  }

  const send = async () => {
    const mission = text.trim();
    if (!mission || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await api.loopCloudSend(repoRoot, mission, agent, undefined, threadKey);
      setText("");
      // The row for what you just said has to appear now. The poller is slow on
      // purpose; this is the same event the composer fires.
      window.dispatchEvent(
        new CustomEvent("aura:cloud-task-created", {
          detail: { repoRoot, id: res.id, status: res.status },
        }),
      );
      refreshCloudJobs(repoRoot);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-line-soft px-4 py-3">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder="Say something else to the machine…"
            // bg-state-hover, matching the app's own Input: `bg-surface-2` was
            // a class that does not exist in this stylesheet, so the composer
            // had no fill at all and whatever sat behind it showed through.
            className="min-h-[46px] flex-1 resize-none rounded-lg border border-line-soft bg-state-hover px-3 py-2 text-sm text-text-1 outline-none placeholder:text-text-5 focus:border-line"
          />
          <Button
            variant="accentSoft"
            onClick={() => void send()}
            disabled={!text.trim() || sending}
          >
            {sending ? (
              <span className="flex items-center gap-1.5">
                <AsciiSpinner /> Sending…
              </span>
            ) : (
              "Send"
            )}
          </Button>
        </div>
        {error ? (
          <p className="text-xs" style={{ color: "var(--color-red)" }}>
            {error}
          </p>
        ) : (
          <p className="text-xs text-text-5">
            {latestIsRunning
              ? "The machine is busy with this thread — your reply is picked up after it finishes."
              : "Goes on the board as the next piece of work in this conversation."}
          </p>
        )}
      </div>
    </div>
  );
}
