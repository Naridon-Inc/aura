// Why the pull request info couldn't be read, in the words the git status row
// shows: a title, one sentence on what happened, and the one thing that may
// fix it (try again, or open settings).
//
// A failed read with a pull request already on screen was a refresh: the row
// keeps its label and only warns. With none on screen nothing was learned, so
// the row's label becomes the problem itself.

import type { GitWorkflowIssue } from "../ui/git-workflow";
import { originToHttpBase } from "../../lib/worktreeActions";

export type PrFetchIssueKind =
  | "offline"
  | "unsupported"
  | "access-required"
  | "refresh-error"
  | "initial-error";

export type PrFetchIssue = GitWorkflowIssue & {
  kind: PrFetchIssueKind;
  /** The row's label is replaced by the title (nothing was loaded yet). */
  replacesLabel: boolean;
};

export type PrFetchInput = {
  /** What the last read failed with; `null` when it landed. */
  reason: string | null;
  /** A pull request is already on screen, so the failed read was a refresh. */
  showingPr: boolean;
  /** `origin`'s URL, for naming the host and the repository. Typed loosely:
   *  it comes over the native bridge, and a non-string reads as no remote. */
  origin: unknown;
  online: boolean;
};

/** Forges other than GitHub: pull requests there aren't read at all. */
const OTHER_FORGES = /(^|\.)(gitlab\.com|bitbucket\.org|codeberg\.org|dev\.azure\.com|visualstudio\.com|sr\.ht|gitea\.com)$/i;

/** The remote's host and `owner/name`, from any of git's URL spellings. */
export function remoteHostAndRepo(origin: unknown): { host: string; repo: string } | null {
  const base = originToHttpBase(origin);
  if (!base) return null;
  try {
    const url = new URL(base);
    const repo = url.pathname.replace(/^\/+|\/+$/g, "");
    return { host: url.hostname, repo };
  } catch {
    return null;
  }
}

function repoNamed(reason: string, origin: unknown): string {
  const fromError = reason.match(/Repository with the name '([^']+)'/i)?.[1];
  return fromError ?? remoteHostAndRepo(origin)?.repo ?? "this repository";
}

export function prFetchIssue({ reason, showingPr, origin, online }: PrFetchInput): PrFetchIssue | null {
  const remote = remoteHostAndRepo(origin);
  // Offline says so even before a read fails: nothing can be read until the
  // connection is back. Only where a read is expected — a repo with a remote.
  if (!online && (remote || reason)) {
    return {
      kind: "offline",
      title: "No internet connection",
      description: showingPr
        ? "PR info can’t be refreshed while offline. The status shown may be out of date."
        : "PR info can’t be loaded while offline.",
      replacesLabel: !showingPr,
    };
  }
  if (!reason) return null;
  // No remote at all: there is no pull request to read, so nothing failed.
  if (/no git remotes found/i.test(reason)) return null;

  if (/known GitHub host|not a GitHub (host|repository)/i.test(reason) || (remote && OTHER_FORGES.test(remote.host))) {
    return {
      kind: "unsupported",
      title: "PR info unavailable",
      description: remote?.host
        ? `PR information isn’t available for ${remote.host}.`
        : "PR information isn’t available for this remote.",
      replacesLabel: !showingPr,
    };
  }

  const missing = /Could not resolve to a Repository|HTTP 404|Repository not found/i.test(reason);
  const noAccess =
    !/gh CLI not found/i.test(reason) &&
    /HTTP 40[13]|Bad credentials|Resource not accessible|SAML|gh auth login|not logged in|authentication required|token .*(expired|revoked|invalid)/i.test(
      reason,
    );
  const repo = repoNamed(reason, origin);
  if (noAccess) {
    return {
      kind: "access-required",
      title: "GitHub access required",
      description: `The current GitHub connection can’t access ${repo}.`,
      action: "open-settings",
      replacesLabel: !showingPr,
    };
  }
  const timedOut = /timed? ?out|deadline exceeded/i.test(reason);
  return {
    kind: showingPr ? "refresh-error" : "initial-error",
    title: showingPr ? "Couldn’t refresh PR info" : "Couldn’t load PR info",
    description: missing
      ? `GitHub couldn’t find ${repo}. It may have been renamed, deleted, or be inaccessible with the current connection.`
      : timedOut
        ? showingPr
          ? "The latest PR refresh timed out. The status shown may be out of date."
          : "GitHub didn’t respond before the request timed out."
        : showingPr
          ? "The latest PR refresh failed. The status shown may be out of date."
          : "Aura couldn’t get PR information from GitHub.",
    action: "retry",
    replacesLabel: !showingPr,
  };
}
