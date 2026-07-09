// Shared terminal keymap. Translates browser KeyboardEvents into the
// PTY byte sequences a Warp-style rich text input expects, so xterm
// panes (system shell + agent CLIs) feel like a native macOS text
// editor instead of a bare-bones VT220.
//
// Returning a Uint8Array means "write these bytes to the PTY and
// suppress xterm's default handling". Returning null means "let xterm
// process the key normally".
//
// Coverage:
//   • Shift+Enter / Alt+Enter — insert literal newline at the prompt.
//     Sent as a bracketed-paste single-LF block so multiline-aware
//     TUIs (Claude Code, Codex, Cursor) reliably treat it as inserted
//     content rather than another submit. Falls back to the iTerm-
//     style ESC+CR sequence for Alt+Enter on terminals that don't
//     advertise bracketed paste.
//   • macOS line / word navigation:
//       Cmd+Left  → ^A (start of line)
//       Cmd+Right → ^E (end of line)
//       Cmd+Backspace → ^U (kill line)
//       Cmd+K     → ^L (clear screen — macOS muscle memory)
//       Option+Left  → ESC+b (backward-word)
//       Option+Right → ESC+f (forward-word)
//       Option+Backspace → ESC+DEL (backward-kill-word, readline)

const ENC = new TextEncoder();

/** True when keyboard focus is currently inside an xterm pane. Used to
 *  scope terminal-only shortcuts (⌘F find, ⌘\ split, ⌘↑/⌘↓ command-nav)
 *  so they don't hijack the editor or other surfaces. xterm parks focus
 *  on a hidden `.xterm-helper-textarea`; the surrounding `.xterm` element
 *  is the robust anchor whether the helper textarea or the screen has
 *  focus. */
export function isTerminalFocused(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  return !!el && !!el.closest(".xterm");
}

/** Returns the bytes to write to the PTY for this key, or null to let
 *  xterm handle the event with its default behavior. */
export function mapKeyEvent(e: KeyboardEvent): Uint8Array | null {
  if (e.type !== "keydown") return null;

  const enter = e.key === "Enter" || e.code === "Enter";
  // Shift+Enter — bracketed-paste-wrapped LF. TUIs that support
  // bracketed paste (Claude Code, Codex, modern shells) see this as a
  // pasted newline and insert it without submitting; TUIs that don't
  // ignore the markers and see a stray LF, which most also accept as
  // "newline in input".
  if (enter && e.shiftKey && !e.metaKey && !e.ctrlKey) {
    return ENC.encode("\x1b[200~\n\x1b[201~");
  }
  // Alt+Enter — legacy iTerm "Esc+ as Meta" sequence, kept distinct so
  // users with different terminal muscle memory still get a newline.
  if (enter && e.altKey && !e.metaKey && !e.ctrlKey) {
    return ENC.encode("\x1b\r");
  }

  // macOS Cmd+ shortcuts. Browsers report metaKey for Cmd on macOS and
  // for Win on Windows — we map them the same since the readline
  // sequences are platform-neutral.
  if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
    switch (e.key) {
      case "ArrowLeft":
        return ENC.encode("\x01"); // Ctrl+A — start of line
      case "ArrowRight":
        return ENC.encode("\x05"); // Ctrl+E — end of line
      case "Backspace":
        return ENC.encode("\x15"); // Ctrl+U — kill to start of line
      case "k":
      case "K":
        return ENC.encode("\x0c"); // Ctrl+L — clear screen
    }
  }

  // Option+ shortcuts (word-level navigation). Browsers may report the
  // typed character (e.key) as a non-ascii glyph when Option is held,
  // so we prefer e.code for these.
  if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    switch (e.code) {
      case "ArrowLeft":
        return ENC.encode("\x1bb"); // ESC+b — backward word
      case "ArrowRight":
        return ENC.encode("\x1bf"); // ESC+f — forward word
      case "Backspace":
        return ENC.encode("\x1b\x7f"); // ESC+DEL — backward-kill-word
    }
  }

  return null;
}
