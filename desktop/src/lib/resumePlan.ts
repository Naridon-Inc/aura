// What "Resume" is actually about to do — decided once, in words.
//
// AURA-1366. The button said "Resume" and the popover said it "picks up this
// exact conversation where it left off". Four different things could happen
// behind that one sentence:
//
//   • the conversation really is reopened, in the folder it ran in;
//   • it is reopened in a DIFFERENT folder from the one on screen, because the
//     work happened in a sibling worktree;
//   • nothing is reopened at all — the folder it ran in has been deleted, so
//     `claude --resume <id>` finds no transcript, says nothing about it, and
//     hands back a blank agent that looks resumed until you scroll up;
//   • there is no agent conversation here to begin with, only a native Aura
//     chat, or a run by an agent Aura can't reopen.
//
// The third is the one that costs a person their afternoon: a live billed agent
// starts, claims to be the old thread, and knows none of it. So the destination
// is worked out BEFORE the button is drawn, and the button says which of the
// four it is. A continuation and a fresh start get different verbs, because
// they are different acts.
//
// Everything here is a pure function of what the record and the session lister
// already carry. Nothing is launched from this file; see lib/resumeLaunch.

import { agentName } from "./agentNames";
import { resumeCwdOf, resumeReachableFrom } from "./agentSessionScope";
import { basename } from "./paths";
import type { ClaudeSession } from "./api";

/** What pressing the action would do.
 *
 *  `reopen` and `fresh` both launch a live agent; they are kept apart because
 *  only one of them carries the earlier conversation with it. */
export type ResumeKind = "reopen" | "fresh" | "chat" | "none";

export type ResumePlan = {
  kind: ResumeKind;
  /** The word on the button. Empty when there is nothing to press. */
  verb: string;
  /** The folder the agent is launched in. Empty when nothing launches. */
  cwd: string;
  /** The conversation to reopen — null when this starts a new one. */
  sessionId: string | null;
  /** One sentence: what happens when it is pressed. */
  headline: string;
  /** What comes with it, and where the rest still is. Empty for `none`. */
  carries: string;
  /** What a reader would otherwise assume wrongly. Empty when nothing is. */
  warning: string;
};

export type ResumeInput = {
  /** The workspace this page is being read in. */
  repoRoot: string;
  /** The agent conversation correlated to this run, if one was found. */
  session: Pick<ClaudeSession, "session_id" | "cwd" | "file_path"> | null;
  /** Set when the run is a native Aura chat rather than a CLI conversation. */
  managerSessionId?: string | null;
  /** Which agent did the work, from the record. */
  agentId?: string | null;
  /** The folder the record says the work happened in — a name, never a path. */
  worktree?: string | null;
};

/** The folder a launch lands in, as a person would name it. */
function folderWord(cwd: string): string {
  return basename(cwd) || cwd;
}

/** Aura reopens Claude Code conversations. Every other agent's history lives in
 *  its own store and is not ours to replay — saying so by name beats a button
 *  that isn't there and a page that never explains why. */
function otherAgentLine(agentId: string | null | undefined): string {
  const name = agentName(agentId, { empty: "", unknown: "" });
  if (!name || name === "Claude" || name === "Aura") return "";
  return `This run was done by ${name}. Aura can reopen Claude conversations, so this one it can only show you.`;
}

export function resumePlan(input: ResumeInput): ResumePlan {
  const chatId = (input.managerSessionId ?? "").trim();
  if (chatId) {
    return {
      kind: "chat",
      verb: "Continue chat",
      cwd: "",
      sessionId: chatId,
      headline: "Reopens this Aura chat where it stopped.",
      carries:
        "The whole thread comes with it: the original request, what was decided and anything left unfinished. Nothing is replayed and no new agent starts.",
      warning: "",
    };
  }

  const session = input.session;
  if (!session?.session_id) {
    return {
      kind: "none",
      verb: "",
      cwd: "",
      sessionId: null,
      headline:
        "No agent conversation was recorded for this run, so there is nothing here to carry on.",
      carries: "",
      // Only when there is a reason worth printing. A run with no correlated
      // conversation is ordinary and needs no notice; a run by an agent whose
      // history Aura cannot reopen is a question the page should answer before
      // it is asked.
      warning: otherAgentLine(input.agentId),
    };
  }

  const cwd = resumeCwdOf(session, input.repoRoot);
  const here = folderWord(input.repoRoot);
  const there = folderWord(cwd);

  if (!resumeReachableFrom(session, cwd)) {
    // The folder this ran in is registered but gone from disk, so the lister
    // re-homed the session onto this workspace. Launching with `--resume` from
    // here would find nothing and open a blank agent under the old name.
    const named = input.worktree ? `The ${input.worktree} folder` : "The folder";
    return {
      kind: "fresh",
      verb: "Start fresh here",
      cwd: input.repoRoot,
      sessionId: null,
      headline: `Starts a new conversation in ${here}. It is not this one carried on.`,
      carries:
        "What was asked and what changed stay on this page, and the earlier conversation is still readable under Transcript.",
      warning: `${named} this ran in is not on this machine any more, so the original conversation cannot be reopened.`,
    };
  }

  return {
    kind: "reopen",
    verb: "Resume",
    cwd,
    sessionId: session.session_id,
    headline: `Opens this same conversation again, running in ${there}.`,
    carries:
      "Everything already said comes with it: the original request, what was decided and what was left unfinished. It carries on from the end — nothing is replayed.",
    warning:
      cwd.replace(/\/+$/, "") === input.repoRoot.replace(/\/+$/, "")
        ? ""
        : `This work happened in ${there}, not in ${here}. Aura runs it there.`,
  };
}

/** Does this plan start a live, billed agent? `chat` and `none` do not. */
export function planLaunchesAgent(plan: ResumePlan): boolean {
  return plan.kind === "reopen" || plan.kind === "fresh";
}
