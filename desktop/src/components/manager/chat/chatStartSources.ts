// What a new chat can start from: the earlier conversations in this project
// and the plans saved as Pages. Both are read once when the chat opens; a read
// that fails leaves the row out rather than claiming there is nothing.

import { useEffect, useState } from "react";
import { api, type ManagerSummary, type NoteSummary } from "../../../lib/api";
import { fetchManagerList } from "../../../lib/managerCache";
import { chatTranscriptMarkdown, transcriptFileName } from "../../../lib/chatTranscriptMarkdown";
import { stripSteeringDirective } from "../../../lib/steeringDirective";

export type PriorChat = { id: string; title: string; at: number };

export function priorChatsFrom(rows: ManagerSummary[], currentSessionId?: string | null): PriorChat[] {
  return rows
    .filter((r) => r.id !== currentSessionId)
    .map((r) => ({ id: r.id, title: stripSteeringDirective(r.objective ?? "").trim(), at: r.updated_at }))
    .filter((r) => r.title)
    .sort((a, b) => b.at - a.at);
}

export function planPagesFrom(rows: NoteSummary[]): NoteSummary[] {
  return rows
    .filter((n) => n.tags.includes("plan") && !n.archived_at)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** The other conversations in this project that have a message in them,
 *  newest first. `null` until read. */
export function usePriorChats(repoRoot?: string | null, sessionId?: string | null): PriorChat[] | null {
  const [chats, setChats] = useState<PriorChat[] | null>(null);
  useEffect(() => {
    let live = true;
    setChats(null);
    fetchManagerList(repoRoot ?? null)
      .then((rows) => live && setChats(priorChatsFrom(rows, sessionId)))
      .catch(() => live && setChats(null));
    return () => {
      live = false;
    };
  }, [repoRoot, sessionId]);
  return chats;
}

/** The plans saved as Pages in this project, newest first. */
export function usePlanPages(repoRoot?: string | null): NoteSummary[] {
  const [plans, setPlans] = useState<NoteSummary[]>([]);
  useEffect(() => {
    let live = true;
    setPlans([]);
    if (!repoRoot) return;
    api
      .notesList({ repoRoot, scope: "team" })
      .then((rows) => live && setPlans(planPagesFrom(rows)))
      .catch(() => live && setPlans([]));
    return () => {
      live = false;
    };
  }, [repoRoot]);
  return plans;
}

/** An earlier conversation as a Markdown file. `null` when it has no
 *  messages. */
export async function transcriptFile(chat: PriorChat): Promise<File | null> {
  const session = await api.managerStatus(chat.id);
  const md = chatTranscriptMarkdown(chat.title, session.chat ?? []);
  if (md === null) return null;
  return new File([md], transcriptFileName(chat.title), { type: "text/markdown" });
}

export function planFileName(plan: NoteSummary): string {
  const clean = plan.title.replace(/[\\/:*?"<>|\n\r]+/g, " ").replace(/\s+/g, " ").trim();
  return `${clean || "Plan"}.md`;
}

/** A saved plan as a Markdown file. */
export async function planFile(repoRoot: string, plan: NoteSummary): Promise<File> {
  const note = await api.notesRead(repoRoot, plan.scope, plan.bucket, plan.id);
  return new File([note.body], planFileName(plan), { type: "text/markdown" });
}
