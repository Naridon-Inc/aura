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
import { Check, CloudOff, Copy } from "lucide-react";

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
import { AgentMessageBody } from "../manager/chat/AgentMessageBody";
import { Button } from "../ui/button";
import { ChatComposerArea, ChatNotice, ChatTranscript } from "../ui/chat-surface";
import { CloudGlyph } from "../ui/cloud-glyph";
import { Composer } from "../ui/composer";
import { ChatStatus, Message, MessageActions, MessageBody } from "../ui/message";
import { EmptyState, LoadingState } from "../ui/state";
import "../ui/cloud-thread.css";

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
      <div className="ui-cloud-thread-state">
        <LoadingState size="md" label="Reading the board…" />
      </div>
    );
  }

  if (!thread) {
    // The board is the only record, and it has a retention window. Say that,
    // rather than showing an empty chat that implies nothing was ever said.
    return (
      <div className="ui-cloud-thread-state">
        <EmptyState
          icon={CloudOff}
          title="This conversation isn’t on the board"
          body="Cloud work is kept for a while and then rolls off. If you sent this a long time ago, its record is gone — nothing on this machine held a copy."
        />
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
    <div className="ui-cloud-thread">
      <header className="ui-cloud-thread-head">
        <CloudGlyph size={14} pulse={running && latest.status !== "submitted"} />
        <div className="ui-cloud-thread-title">
          <strong>{thread.title}</strong>
          <small>
            <span style={{ color: tint }}>{label}</span>
            <span>{who}</span>
            {latest.repo && <code>{latest.repo}</code>}
          </small>
        </div>
        {chat && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openManagerSession(chat, thread.title.slice(0, 60))}
            title="This work was handed over from a chat. Open it."
          >
            Open the chat that sent it
          </Button>
        )}
      </header>

      <ChatTranscript ref={scrollRef}>
        {thread.jobs.map((job) => (
          <Turn key={job.id} job={job} nowMs={nowMs} />
        ))}
      </ChatTranscript>

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
 *  so far. They are one task on the board, so the answer's facts — status,
 *  commit, branch, task id, age — sit under the answer, the way a chat turn's
 *  footer does. */
function Turn({ job, nowMs }: { job: CloudJobWithRoot; nowMs: number }) {
  const { label, tint } = cloudStatusLine(job, nowMs);
  const asked = job.text?.trim() || "";
  const stamp = stampOf(job.created_at, nowMs);
  const answered = job.result || job.error_message;
  const working = isCloudJobRunning(job.status) && job.status !== "submitted";

  return (
    <>
      {asked && (
        <Message role="user">
          <div className="ui-chat-user-stack">
            <MessageBody tone="user">{asked}</MessageBody>
            <MessageActions text={asked} />
          </div>
        </Message>
      )}

      <Message role="assistant">
        <MessageBody className="ui-chat-answer">
          {job.error_message && <ChatStatus state="error">{job.error_message}</ChatStatus>}
          {job.result && <AgentMessageBody source={job.result} />}
          {/* Nothing has come back yet. The status IS the answer here, so it
              stands where the reply would be — an empty space under a
              question reads as a dropped message. */}
          {!answered && (
            <ChatStatus state={working ? "working" : "empty"}>
              <span style={{ color: tint }}>{label}</span>
              {job.status === "submitted" && " — it starts as soon as a machine is free"}
            </ChatStatus>
          )}
          <MessageActions text={job.result || undefined}>
            {answered && (
              <span className="ui-turn-fact" style={{ color: tint }}>
                {label}
              </span>
            )}
            {job.commit_sha && (
              <code className="ui-turn-fact" title={job.commit_sha}>
                {job.commit_sha.slice(0, 8)}
              </code>
            )}
            {job.branch && <code className="ui-turn-fact">{job.branch}</code>}
            <code className="ui-turn-fact" title={job.id}>
              {job.id.slice(0, 8)}
            </code>
            <CopyId id={job.id} />
            {stamp && <span className="ui-turn-fact">{stamp}</span>}
          </MessageActions>
        </MessageBody>
      </Message>
    </>
  );
}

/** Copies a task's full id — what a runner log or the board is searched by. */
function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const label = copied ? "Copied" : "Copy task id";
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={label}
      aria-label={label}
      onClick={() => {
        navigator.clipboard.writeText(id).then(
          () => setCopied(true),
          () => {
            // A denied clipboard leaves the id on screen to select by hand.
          },
        );
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

/** Say something else to the machine.
 *
 *  A reply is a new task carrying the thread's context, not a keystroke into a
 *  live process — the runner claims tasks, it isn't holding a socket open for
 *  us. That difference is stated under the composer rather than hidden behind
 *  a chat bubble, because it changes what you should expect: your words land
 *  when the box next looks at the board, and if it is mid-job they land after
 *  that job. */
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
      <ChatComposerArea>
        <ChatNotice>
          This repository isn’t open on this machine, so there’s nowhere to send a
          reply from. Open the repository to keep the conversation going.
        </ChatNotice>
      </ChatComposerArea>
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
    <ChatComposerArea>
      {error && (
        <ChatNotice onDismiss={() => setError(null)}>
          <span className="ui-cloud-thread-error">Couldn’t send: {error}</span>
        </ChatNotice>
      )}
      <Composer
        value={text}
        onChange={setText}
        onSend={() => void send()}
        sendDisabled={sending}
        ariaLabel="Reply to the machine"
        placeholder="Say something else to the machine…"
      />
      <ChatNotice>
        {sending
          ? "Sending…"
          : latestIsRunning
            ? "The machine is busy with this thread — your reply is picked up after it finishes."
            : "Goes on the board as the next piece of work in this conversation."}
      </ChatNotice>
    </ChatComposerArea>
  );
}
