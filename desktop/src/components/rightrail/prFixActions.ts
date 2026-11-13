// The header's two hand-offs of a pull request's feedback to an agent, under
// the chat ids the Checks tab uses, so a send from either place shows as one:
// "Fix errors" sends the failing checks, "Add all comments to chat" sends the
// review comments that say something. Each reads what it sends at the press,
// so the chat gets the checks and comments as they are now.

import { useEffect, useState } from "react";

import type { PrComment } from "../../lib/api";
import { runGitChatAfter } from "../../lib/gitChat";
import { prChecks } from "../../lib/prApi";
import { fetchPrComments, subscribePrComments } from "../../lib/prCommentsCache";
import { bucketOf } from "../pr/checks/PrCheckRows";
import { saidComments } from "../pr/overview/prOverviewModel";

export const fixErrorsChatId = (prNumber: number) => `fix-errors:${prNumber}`;
export const addCommentsChatId = (prNumber: number) => `add-comments:${prNumber}`;

export function sendFailingChecks(repoRoot: string, prNumber: number): Promise<string | null> {
  return runGitChatAfter(repoRoot, fixErrorsChatId(prNumber), async () => {
    const failing = (await prChecks(repoRoot, prNumber)).filter((c) => bucketOf(c) === "failure");
    if (failing.length === 0) throw new Error("No checks are failing right now.");
    return { action: "fix-errors", failing };
  });
}

export function sendPrComments(
  repoRoot: string,
  pr: { number: number; title: string },
): Promise<string | null> {
  return runGitChatAfter(repoRoot, addCommentsChatId(pr.number), async () => {
    const comments = saidComments(await fetchPrComments(repoRoot, pr.number));
    if (comments.length === 0) throw new Error("This pull request has no comments to add.");
    return { action: "add-comments", pr: { number: pr.number, title: pr.title }, comments };
  });
}

/** How many comments on the pull request say something; `null` until read.
 *  Read only while `wanted` (the row is asking for changes), and kept live
 *  from the comments cache the Checks tab fills. */
export function useSaidCommentCount(
  repoRoot: string,
  prNumber: number | null,
  wanted: boolean,
  tick: number,
): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!wanted || prNumber == null) {
      setCount(null);
      return;
    }
    let alive = true;
    const apply = (list: PrComment[]) => {
      if (alive) setCount(saidComments(list).length);
    };
    void fetchPrComments(repoRoot, prNumber)
      .then(apply)
      .catch(() => {});
    const off = subscribePrComments(repoRoot, prNumber, apply);
    return () => {
      alive = false;
      off();
    };
  }, [repoRoot, prNumber, wanted, tick]);
  return count;
}
