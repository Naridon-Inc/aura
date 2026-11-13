// The work mode a conversation's next message runs in. For an agent driven
// through its terminal there is no request field to carry it, so Plan and Ask
// travel as a short instruction in front of the message itself.

export type ChatMode = "auto" | "build" | "plan" | "ask";

export function promptForChatMode(text: string, mode: ChatMode): string {
  if (mode === "plan") return `Plan mode: investigate and propose a concrete plan. Do not edit files or run commands that change state. Wait for my instruction before implementation.\n\n${text}`;
  if (mode === "ask") return `Ask mode: answer this question using read-only investigation. Do not edit files or run commands that change state.\n\n${text}`;
  return text;
}
