// Switching branch moves every file in the checkout. An agent mid-turn in
// that checkout is reading and writing those files, so a switch under it
// swaps its ground without telling it. The switcher asks first in that case
// and only then — with nothing running, it switches straight away.
//
// This is the decision alone, kept apart from the stores that say what is
// running, so it can be tested without them.

/** One switch someone asked for: the branch it goes to, and how to do it. */
export type SwitchRequest = {
  branchName: string;
  switchBranch: () => void;
};

export type SwitchOutcome = "confirming" | "switching";

const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Whether an agent is working in this checkout itself. `roots` is the set
 *  `useWorkingRoots` gives — already without trailing slashes. An agent in a
 *  sibling worktree has its own files and doesn't count. */
export function rootIsWorking(roots: ReadonlySet<string>, root: string): boolean {
  return roots.has(bare(root));
}

/** Hold the request for a yes when an agent is running, else switch now. */
export function decideSwitch(
  running: boolean,
  request: SwitchRequest,
  hold: (request: SwitchRequest) => void,
): SwitchOutcome {
  if (running) {
    hold(request);
    return "confirming";
  }
  request.switchBranch();
  return "switching";
}
