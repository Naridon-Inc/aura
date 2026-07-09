/** Team (chat) presentation — the pinned-messages drop panel.
 *
 *  Moved verbatim out of the CommsPanel monolith; logic unchanged. */

import { type TeamMember } from "../../../lib/api";
import { formatPinTime, type Msg } from "../domain";

export function PinnedPanel({
  pins,
  members,
  onJump,
  onUnpin,
  onClose,
}: {
  pins: Msg[];
  members: TeamMember[];
  selfHandle: string;
  onJump: (msgId: string) => void;
  onUnpin: (msgId: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="flex-shrink-0 border-b border-line-soft bg-bg-1"
      style={{ maxHeight: 220 }}
    >
      <div className="flex items-center justify-between px-3 py-1.5 text-[10.5px] uppercase tracking-wide text-text-3">
        <span className="font-semibold">
          {pins.length === 0 ? "No pinned messages" : `Pinned (${pins.length})`}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-text-4 hover:text-text-1"
          title="Close pinned"
          aria-label="Close pinned"
        >
          ×
        </button>
      </div>
      {pins.length > 0 && (
        <div className="overflow-y-auto" style={{ maxHeight: 188 }}>
          {pins
            .slice()
            .sort((a, b) => b.ts - a.ts)
            .map((m) => {
              const author = members.find((x) => x.handle === m.sender)?.name
                || m.sender
                || "Unknown";
              const preview = (m.body ?? "").trim().slice(0, 160);
              return (
                <div
                  key={m.id}
                  className="flex gap-2 px-3 py-1.5 hover:bg-bg-2 cursor-pointer border-t border-line-soft/40"
                  onClick={() => onJump(m.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-text-2 flex items-baseline gap-1.5">
                      <span className="font-medium text-text-1 truncate">{author}</span>
                      <span className="text-text-4 text-[10px] tabular-nums">
                        {formatPinTime(m.ts)}
                      </span>
                    </div>
                    <div className="text-[12px] text-text-2 truncate">{preview || "(empty)"}</div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUnpin(m.id);
                    }}
                    className="text-[10.5px] text-text-4 hover:text-text-1 shrink-0 self-start mt-0.5"
                    title="Unpin"
                  >
                    Unpin
                  </button>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
