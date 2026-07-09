// Slim placeholder shown in the ADE Team sidebar section while the full
// team chat is living in the wide center pane (the `channels` tab). The
// channel rail, message stream, threads, members and huddle all render
// inside that center CommsPanel — so this sidebar slot stops mounting a
// second CommsPanel (which would open a duplicate WebSocket / poller)
// and instead offers the two affordances that still make sense from
// here: re-focus the center tab, or pull chat back into the sidebar.

type TeamCenterLauncherProps = {
  projectName: string;
  /** Re-focus the existing center `channels` tab. */
  onFocus: () => void;
  /** Close the center tab so chat returns to this sidebar section. */
  onCollapse: () => void;
};

export function TeamCenterLauncher({
  projectName,
  onFocus,
  onCollapse,
}: TeamCenterLauncherProps) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center px-5 text-center gap-3 bg-bg-content">
      <span
        className="w-11 h-11 rounded-xl flex items-center justify-center"
        style={{
          background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
          color: "var(--color-accent)",
          border:
            "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)",
        }}
      >
        <ChatGlyph />
      </span>
      <div className="space-y-1">
        <div className="text-[13px] font-semibold text-text-1">
          Team chat is in the main pane
        </div>
        <div className="text-[11.5px] text-text-3 leading-snug max-w-[220px]">
          Channels, threads, members and huddle for{" "}
          <span className="text-text-2">{projectName}</span> are open in the
          center so the stream has room to breathe.
        </div>
      </div>
      <div className="flex flex-col items-stretch gap-1.5 w-full max-w-[220px] mt-1">
        <button
          type="button"
          onClick={onFocus}
          className="h-8 rounded-md text-[12px] font-medium text-bg-deep flex items-center justify-center gap-2 transition-colors"
          style={{ background: "var(--color-accent)" }}
        >
          <FocusGlyph />
          Focus chat
        </button>
        <button
          type="button"
          onClick={onCollapse}
          className="h-8 rounded-md text-[11.5px] text-text-3 hover:text-text-1 border border-line-soft hover:border-line transition-colors"
        >
          Move back to sidebar
        </button>
      </div>
    </div>
  );
}

function ChatGlyph() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
    </svg>
  );
}

function FocusGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}
