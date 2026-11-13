// Where a chat opens the conversations it hands you.
//
// The same chat view runs in two places: as a workspace's tab, where picking a
// past conversation opens it as another tab, and in Aura's panel on Home,
// where it must switch the panel instead — opening a tab there would put the
// conversation behind the page you are looking at. The view asks this context
// rather than knowing which place it is in.
//
// No provider means the tab behaviour, so every existing mount is unchanged.

import { createContext, useContext, type ReactNode } from "react";

export type ChatHost = {
  /** Show `sessionId` here. */
  openSession: (sessionId: string, label: string) => void;
  /** Which conversations the history lists: the open workspace's chats, or
   *  every conversation Aura has had, each row naming the projects it covers. */
  scope: "workspace" | "aura";
};

const ChatHostContext = createContext<ChatHost | null>(null);

export function ChatHostProvider({ host, children }: { host: ChatHost; children: ReactNode }) {
  return <ChatHostContext.Provider value={host}>{children}</ChatHostContext.Provider>;
}

/** The host, or null inside a workspace tab. */
export function useChatHost(): ChatHost | null {
  return useContext(ChatHostContext);
}
