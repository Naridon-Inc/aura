import { useState } from "react";
import type { ChatImageAttachment } from "../../../lib/api";
import { ImageLightbox } from "../../media/ImageLightbox";
import "../../ui/transcript-chips.css";

// Direct port of the prototype's `.user-bubble` and `.agent-text` —
// no avatars, no right-align, no accent tint. The bubble is a simple
// bordered box; the agent reply is plain prose.
//
// User turns that resolved a QuestionCard render as a paired Q+A block:
// the originating question sits above the answer in
// the same bordered card, prefixed with a tiny "Q" label so the reader
// sees what the answer was answering even on reload.

// User-attached images on a chat turn, rendered as the composer's own
// attachment chips (a small thumbnail and the name) that sit BELOW the text
// bubble, not inside it — so the bubble stays text-only and a pasted screenshot
// reads as the attachment it was when it was sent. Clicking a chip toggles a
// larger preview under the row, drawn with the chat's one image treatment. The
// bytes are persisted base64 on the turn (the same copy the brain receives), so
// this re-renders correctly on reload. Renders nothing when the turn carried no
// images.
export function ChatAttachmentCards({
  attachments,
}: {
  attachments?: ChatImageAttachment[] | null;
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  if (!attachments || attachments.length === 0) return null;
  const open = openIdx !== null ? attachments[openIdx] : null;
  return (
    <div className="ui-sent-attachments">
      <div className="ui-attachments">
        {attachments.map((a, i) => (
          <AttachmentCard
            key={i}
            att={a}
            active={openIdx === i}
            onToggle={() => setOpenIdx((v) => (v === i ? null : i))}
          />
        ))}
      </div>
      {open && (
        // AURA-1298 — same picture, now clickable to full size with copy/save.
        <ImageLightbox
          src={`data:${open.media_type};base64,${open.data_base64}`}
          alt={open.name ?? "attached image"}
          className="chat-media"
        />
      )}
    </div>
  );
}

function AttachmentCard({
  att,
  active,
  onToggle,
}: {
  att: ChatImageAttachment;
  active: boolean;
  onToggle: () => void;
}) {
  const src = `data:${att.media_type};base64,${att.data_base64}`;
  const name = att.name || "image";
  return (
    <button
      type="button"
      className="ui-attachment"
      aria-pressed={active}
      onClick={onToggle}
      title={active ? "Hide preview" : name}
    >
      <img src={src} alt={att.name || "attached image"} />
      <span className="ui-attachment-name">{name}</span>
    </button>
  );
}
