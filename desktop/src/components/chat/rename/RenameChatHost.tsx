// Holds the one "Rename chat" dialog for the app and opens it when a chat tab
// asks. Mounted once, beside the tab-title sync. A failed rename says so in a
// toast and leaves the old name in place.

import { useEffect, useState } from "react";

import { RenameChatDialog } from "../../ui/rename-chat-dialog";
import { toast } from "../../../lib/toast";
import { RENAME_CHAT_EVENT, renameChat, type RenameChatRequest } from "./renameChat";

export function RenameChatHost() {
  const [request, setRequest] = useState<RenameChatRequest | null>(null);

  useEffect(() => {
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<RenameChatRequest>).detail;
      if (detail?.sessionId) setRequest(detail);
    };
    window.addEventListener(RENAME_CHAT_EVENT, onRequest);
    return () => window.removeEventListener(RENAME_CHAT_EVENT, onRequest);
  }, []);

  return (
    <RenameChatDialog
      open={request !== null}
      currentTitle={request?.currentTitle ?? ""}
      onOpenChange={(open) => {
        if (!open) setRequest(null);
      }}
      onRename={(title) => {
        if (!request) return;
        renameChat(request.sessionId, title, request.currentTitle).catch(() => {
          toast.danger("Couldn't rename this chat. Try again.");
        });
      }}
    />
  );
}
