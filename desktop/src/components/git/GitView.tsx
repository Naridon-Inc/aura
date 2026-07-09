// GitView — the full-screen home for everything version-control, opened from
// the branch name in the footer. It replaces the old "source control moved into
// a bigger box": this is a planned Aura surface, not a standalone git client.
//
// Two tabs, each a proper master/detail layout, with one shared top-bar cluster
// (branch switch + sync) so "where am I / switch / publish / catch up" is always
// in reach:
//
//   • Changes — your uncommitted work. File list on the left; the picked file's
//     diff inline on the right, or a calm "where things stand" read.
//   • History — the project's saved versions on the left; the picked version's
//     full Aura intent story on the right (Asked → Said → Did → Lines up? →
//     Recover). That story is the whole point — it's why this is Git+Aura, not
//     bare git.
//
// No title — the tabs carry the context, matching every other focus surface
// (see FullscreenOverlay).

import { GitCompare, History } from "lucide-react";

import { FullscreenOverlay } from "../FullscreenOverlay";
import { WizardStepTabs, useWizard, type WizardStepMeta } from "../ui/wizard";
import { ChangesTab } from "./ChangesTab";
import { HistoryTab } from "./HistoryTab";
import { RepoHeaderControls } from "./RepoHeaderControls";

const STEPS: WizardStepMeta[] = [
  { id: "changes", label: "Changes", icon: <GitCompare size={14} /> },
  { id: "history", label: "History", icon: <History size={14} /> },
];

export function GitView({
  repoRoot,
  onClose,
  onBeforeCommit,
}: {
  repoRoot: string;
  onClose: () => void;
  /** Strict-mode readiness gate — same guard the sidebar/footer commit path
   *  runs, threaded through so committing from here can't skip it. */
  onBeforeCommit?: () => Promise<boolean>;
}) {
  const wiz = useWizard(STEPS.length);

  return (
    <FullscreenOverlay
      onClose={onClose}
      tabs={
        <WizardStepTabs
          steps={STEPS}
          index={wiz.index}
          onJump={wiz.goTo}
          variant="tabs"
        />
      }
      actions={<RepoHeaderControls repoRoot={repoRoot} />}
    >
      {wiz.index === 0 ? (
        <ChangesTab
          repoRoot={repoRoot}
          onClose={onClose}
          onBeforeCommit={onBeforeCommit}
        />
      ) : (
        <HistoryTab repoRoot={repoRoot} />
      )}
    </FullscreenOverlay>
  );
}
