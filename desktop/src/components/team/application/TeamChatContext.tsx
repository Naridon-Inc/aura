import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import { useTeamChat, type TeamChatModel } from "./useTeamChat";

/** Which screen the Team surface is showing: a conversation, or the
 *  catch-up screen seen through one of its four lenses.
 *
 *  It used to carry a "tasks" member as well, which mounted the whole Tasks
 *  page inside Team — the board in the centre, the board's filter rail in
 *  Team's sidebar. Tasks is its own destination in the nav; Team is the
 *  team. */
export type TeamWorkspaceView =
  | "conversation"
  | "unreads"
  | "recap"
  | "threads"
  | "drafts";

type TeamChatContextValue = {
  repoRoot: string;
  chat: TeamChatModel;
  workspaceView: TeamWorkspaceView;
  setWorkspaceView: Dispatch<SetStateAction<TeamWorkspaceView>>;
};

const TeamChatContext = createContext<TeamChatContextValue | null>(null);

export function TeamChatProvider({
  repoRoot,
  projectName,
  children,
}: {
  repoRoot: string;
  projectName: string;
  children: ReactNode;
}) {
  const chat = useTeamChat(repoRoot, projectName);
  const [workspaceView, setWorkspaceView] =
    useState<TeamWorkspaceView>("conversation");

  // This provider wraps the whole Team shell, so a fresh object literal here
  // re-renders every consumer below it on every render of this component —
  // including the ones nothing changed for. `chat` is itself memoised inside
  // useTeamChat, so this value only ever changes when the model or the
  // workspace view genuinely does.
  const value = useMemo<TeamChatContextValue>(
    () => ({ repoRoot, chat, workspaceView, setWorkspaceView }),
    [repoRoot, chat, workspaceView],
  );

  return (
    <TeamChatContext.Provider value={value}>
      {children}
    </TeamChatContext.Provider>
  );
}

export function useTeamChatContext(repoRoot: string): TeamChatContextValue {
  const value = useContext(TeamChatContext);
  if (!value || value.repoRoot !== repoRoot) {
    throw new Error("TeamSurface must be mounted inside its project TeamChatProvider");
  }
  return value;
}
