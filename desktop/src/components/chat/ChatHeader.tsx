import type { ReactNode } from "react";
import { MessageSquare, Terminal } from "lucide-react";
import "../agent/chatView.css";

export function ChatHeader({ title, workspace, status, actions, switcher }: { title: string; workspace?: string | null; status?: string; actions?: ReactNode; switcher?: ReactNode }) {
  const workspaceName = workspace?.split(/[\\/]/).filter(Boolean).pop();
  return <header className="chat-heading">
    <div className="chat-identity"><strong>{title}</strong>{workspaceName && <><span className="chat-heading-divider" aria-hidden>/</span><span className="chat-workspace-name" title={workspace ?? undefined}>{workspaceName}</span></>}</div>
    <div className="chat-heading-actions">{status && <span className="chat-state" role="status">{status}</span>}{actions}{switcher}</div>
  </header>;
}

/** Both choices refer to the same session. Arrow keys move between views. */
export function ChatViewSwitcher({ value, onChange, disabled = false }: { value: "terminal" | "chat"; onChange: (view: "terminal" | "chat") => void; disabled?: boolean }) {
  return <div className="chat-view-switcher" role="group" aria-label="Session view" onKeyDown={event => {
    if (disabled || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "terminal" : event.key === "End" ? "chat" : value === "chat" ? "terminal" : "chat";
    onChange(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
  }}>
    {(["terminal", "chat"] as const).map(view => <button key={view} type="button" data-view={view} aria-pressed={value === view} disabled={disabled} title={disabled ? "Start this session to switch views" : view === "chat" ? "Read and reply to this session in Chat" : "Use this session’s native CLI"} onClick={() => onChange(view)}>{view === "chat" ? <MessageSquare size={13} /> : <Terminal size={13} />}<span>{view === "chat" ? "Chat" : "CLI"}</span></button>)}
  </div>;
}
