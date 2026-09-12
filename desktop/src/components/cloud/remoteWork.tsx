// What each work surface of a remote workspace is called and drawn with —
// shared by the strip (its tab and the picker) and the pane that hosts it.
//
// The kinds themselves live in `lib/remoteWorkspaceSnapshot`, which is
// pure and persisted; this is the one place they meet a label and an icon.

import {
  Files,
  GitBranch,
  GitCompare,
  GitPullRequest,
  Play,
  type LucideIcon,
} from "lucide-react";

import type { RemoteWorkKind } from "../../lib/remoteWorkspaceSnapshot";

export type RemoteWorkFace = {
  /** The tab's word, as the local strip spells the same surface. */
  label: string;
  /** What hovering the tab or the picker row says. Says "machine", never
   *  "place". */
  hint: string;
  Icon: LucideIcon;
};

export const REMOTE_WORK: Record<RemoteWorkKind, RemoteWorkFace> = {
  files: {
    label: "Files",
    hint: "The project's files on the machine — browse and edit them",
    Icon: Files,
  },
  changes: {
    label: "Changes",
    hint: "What has changed in the checkout on the machine, and commit it",
    Icon: GitCompare,
  },
  git: {
    label: "Git",
    hint: "Branches, sync and history of the checkout on the machine",
    Icon: GitBranch,
  },
  prs: {
    label: "PRs",
    hint: "Pull requests for this project, opened from the machine's branch",
    Icon: GitPullRequest,
  },
  run: {
    label: "Run",
    hint: "The project's run and setup scripts, run on the machine",
    Icon: Play,
  },
};
