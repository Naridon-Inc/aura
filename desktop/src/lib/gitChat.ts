// Agent-run git actions open in a chat you can watch.
//
// Create PR, Commit and push, Resolve, Fix errors, Pull latest, Update the PR
// and Add comments to chat each open a NEW chat tab — the same new chat the
// tab strip's ＋ menu makes — and send their message there. The work streams
// in that tab like any conversation; nothing runs out of sight, and the chat
// you were already in keeps its thread.
//
// The button that started it is busy only while the message goes out. When
// the chat's turn ends, the git surfaces re-read, so a pull request it opened
// appears in the panel on its own.

import { useCallback, useSyncExternalStore } from "react";
import { placeForNewWork } from "./ambientSession";
import { api } from "./api";
import { openManagerSession } from "./editorStore";
import { withRepoContext } from "./gitChatContext";
import type { GitChat, GitChatRequest } from "./gitChatPrompts";
import { isManagerTurnInFlight, subscribeManagerTurns } from "./managerStore";
import { sendAmbientManagerTurn } from "./managerTurn";
import { runPrGuards } from "./prGuards";
import { toast } from "./toast";

export function gitChatKey(repoRoot: string, id: string): string {
  return `${repoRoot}\u0000${id}`;
}

// One frozen snapshot, replaced on every change, so `useSyncExternalStore`
// sees a stable reference between updates. The header's Create PR button and
// the Checks rows share ids, so a send from one shows in the other.
let sending: Readonly<Record<string, true>> = {};
const listeners = new Set<() => void>();

function set(key: string, on: boolean): void {
  if (on === (key in sending)) return;
  const next = { ...sending };
  if (on) next[key] = true;
  else delete next[key];
  sending = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isGitChatSending(repoRoot: string, id: string): boolean {
  return gitChatKey(repoRoot, id) in sending;
}

/** `useGitChats(root)("create-pr")` is true while that action's message is
 *  going out. */
export function useGitChats(repoRoot: string): (id: string) => boolean {
  const snapshot = useSyncExternalStore(subscribe, () => sending, () => sending);
  return useCallback((id: string) => gitChatKey(repoRoot, id) in snapshot, [snapshot, repoRoot]);
}

/** Re-read git and the pull requests once `sid`'s turn has run and ended. */
function refreshWhenDone(sid: string): void {
  let seen = isManagerTurnInFlight(sid);
  const stop = subscribeManagerTurns(() => {
    const now = isManagerTurnInFlight(sid);
    if (now) {
      seen = true;
      return;
    }
    if (!seen) return;
    stop();
    window.dispatchEvent(new CustomEvent("aura:git-changed"));
  });
}

export type GitChatDeps = {
  start: (repoRoot: string, title: string, place: string | null) => Promise<string>;
  open: (sessionId: string, label: string) => void;
  send: (repoRoot: string, text: string, sessionId: string, place: string | null) => Promise<unknown>;
  fail: (title: string, detail: string) => void;
};

const liveDeps: GitChatDeps = {
  start: (repoRoot, title, place) => api.managerChatStart(repoRoot, title, place ?? undefined),
  open: openManagerSession,
  send: (repoRoot, text, sessionId, place) =>
    sendAmbientManagerTurn(repoRoot, text, { sessionId, machineId: place }),
  fail: (title, detail) => toast.danger(detail ? `${title}: ${detail}` : title),
};

/**
 * Open a new chat for `repoRoot` titled `chat.label`, and send `chat.text`
 * into it. Resolves to the chat's session id, or null when it was already
 * sending or the send failed (the failure is toasted in `chat.failure`'s
 * words). A second press while one is going out does nothing.
 */
export async function startGitChat(
  input: { repoRoot: string; id: string; chat: GitChat | (() => Promise<GitChat>) },
  deps: GitChatDeps = liveDeps,
): Promise<string | null> {
  const { repoRoot, id } = input;
  const key = gitChatKey(repoRoot, id);
  if (key in sending) return null;
  set(key, true);
  let chat: GitChat | null = typeof input.chat === "function" ? null : input.chat;
  try {
    // Built after the busy flag is up, so a double press can't read the
    // repo's settings twice and open two chats.
    if (typeof input.chat === "function") chat = await input.chat();
    if (!chat) return null;
    // The chat runs where the work lives: a machine's workspace on that
    // machine, this laptop's here — the same place the ＋ menu would use.
    const place = placeForNewWork(repoRoot);
    const sid = await deps.start(repoRoot, chat.label, place);
    deps.open(sid, chat.label);
    await deps.send(repoRoot, chat.text, sid, place);
    if (deps === liveDeps) refreshWhenDone(sid);
    return sid;
  } catch (e) {
    deps.fail(chat?.failure ?? "Couldn't start the chat", e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    set(key, false);
  }
}

/** Start `req`'s chat with the repo's own settings filled in: its pull request
 *  rules and template for Create PR, its conflict rules for Resolve. Create PR
 *  also starts the checks that run underneath it (lib/prGuards), beside the
 *  chat rather than in front of it. */
export function runGitChat(repoRoot: string, id: string, req: GitChatRequest): Promise<string | null> {
  // The project's checks read the project; a nested repository's PR skips them.
  if (req.action === "create-pr" && !req.folder && !isGitChatSending(repoRoot, id)) {
    void runPrGuards(repoRoot, { branch: req.branch, target: req.target });
  }
  return startGitChat({ repoRoot, id, chat: () => withRepoContext(repoRoot, req) });
}

/** `runGitChat` for a request that has to be read first (a pull request's
 *  failing checks, its review comments): the button is busy from the press,
 *  and a second press while the read runs does nothing. A read that throws
 *  shows its message instead of opening a chat. */
export function runGitChatAfter(
  repoRoot: string,
  id: string,
  read: () => Promise<GitChatRequest>,
): Promise<string | null> {
  return startGitChat({ repoRoot, id, chat: async () => withRepoContext(repoRoot, await read()) });
}
