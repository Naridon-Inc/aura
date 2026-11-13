import { useState } from "react";
import { ChevronDown, GitBranch } from "lucide-react";
import { Button } from "../ui/button";
import { BranchSwitcherModal } from "../git/BranchSwitcherModal";
import { useCurrentBranch } from "./useCurrentBranch";

/** The workspace's branch, in the header slot a state menu sits in: the
 *  checked-out ref, a dot while there is uncommitted work, and the branch
 *  switcher (search, check out, create) on click.
 *
 *  It prints the raw ref on purpose. The header title already carries the
 *  workspace's plain name; this control is the explicitly-git one, and the
 *  switcher it opens lists refs by those same names. */
export function HeaderBranch({
  repoRoot,
  dirty,
}: {
  repoRoot: string | null;
  dirty: boolean;
}) {
  const branch = useCurrentBranch(repoRoot);
  const [open, setOpen] = useState(false);
  if (!repoRoot) return null;
  const title = branch
    ? `On branch ${branch}${dirty ? " · uncommitted changes" : ""}. Switch branch`
    : "Not on a branch right now. Switch branch";
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        title={title}
        aria-label={title}
        onClick={() => setOpen(true)}
        style={{ maxWidth: 220 }}
      >
        <GitBranch />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {branch ?? "No branch"}
        </span>
        {dirty && (
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              flexShrink: 0,
              background: "var(--ui-link)",
            }}
          />
        )}
        <ChevronDown />
      </Button>
      {open && (
        <BranchSwitcherModal repoRoot={repoRoot} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
