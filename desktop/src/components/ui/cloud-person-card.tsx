// The small card a face in a cloud workspace's header opens: who they are,
// whether they are here, what they may do in this workspace, and a Mention
// that puts their @login in the message box. It never takes you anywhere.

import { AtSign } from "lucide-react";

import { Button } from "./button";
import type { CloudMember } from "./cloud-workspace";
import { PopoverClose } from "./popover";
import "./cloud-person-card.css";

export function CloudPersonCard({
  member,
  status,
  here,
  access,
  mention,
  onMention,
  mentionBlocked,
}: {
  member: CloudMember;
  /** "Here now", "Typing…", "Last seen 3m ago", … */
  status: string;
  here: boolean;
  /** Their access to this workspace, when it has been read. */
  access: string | null;
  /** The login a mention names, or why it wouldn't reach them; null for you. */
  mention: { login: string } | { reason: string } | null;
  /** Puts "@login " in this workspace's message box. */
  onMention?: (insert: string) => void;
  /** Why you can't send in this workspace, so a mention has nowhere to go. */
  mentionBlocked?: string | null;
}) {
  const reason =
    mention && "reason" in mention ? mention.reason : mention && mentionBlocked ? mentionBlocked : null;
  return (
    <div className="ui-cloud-person">
      <header>
        <span
          className="ui-cloud-avatar ui-cloud-avatar-static"
          style={{ background: member.color }}
          aria-hidden="true"
        >
          {member.photo ? <img src={member.photo} alt="" draggable={false} /> : member.initials}
        </span>
        <div>
          <strong>{member.name}</strong>
          <span data-here={here || undefined}>{status}</span>
        </div>
      </header>
      {access && (
        <dl>
          <dt>This workspace</dt>
          <dd>{access}</dd>
        </dl>
      )}
      {mention && "login" in mention && !mentionBlocked && onMention ? (
        <PopoverClose asChild>
          <Button variant="secondary" size="sm" onClick={() => onMention(`@${mention.login} `)}>
            <AtSign />
            Mention
          </Button>
        </PopoverClose>
      ) : (
        reason && <p>{reason}</p>
      )}
    </div>
  );
}
