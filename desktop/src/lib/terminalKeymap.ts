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

/** IO seam for {@link handleClipboardKey}: pull the pane's current
 *  selection and write raw bytes to its PTY. Each terminal wires its own
 *  write path (agent PTY vs. system PTY). */
export interface ClipboardKeyIO {
  getSelection: () => string;
  writeBytes: (bytes: number[]) => void;
}

/** Handle macOS ⌘C (copy the xterm selection) / ⌘V (paste the clipboard
 *  into the PTY). Returns true when the event was a clipboard shortcut we
 *  consumed — the caller must then `preventDefault()` and suppress xterm.
 *  Returns false to let normal keymap handling proceed.
 *
 *  Why this can't be left to the browser: xterm keeps its selection on a
 *  canvas rather than as a DOM selection, so WKWebView's native ⌘C copies
 *  nothing; and a Tauri window exposes no Edit menu, so ⌘V never reaches
 *  xterm's paste path. We bridge both through navigator.clipboard, which
 *  the webview does grant. Paste is bracketed so multiline content is
 *  inserted rather than submitted by bracketed-paste-aware TUIs (Claude
 *  Code, Codex) — matching the Shift+Enter path above. Images take a
 *  different route; see [`pasteIntoPty`]. */
export function handleClipboardKey(e: KeyboardEvent, io: ClipboardKeyIO): boolean {
  if (e.type !== "keydown" || !e.metaKey || e.altKey || e.ctrlKey) return false;
  const key = e.key.toLowerCase();
  if (key === "c") {
    const sel = io.getSelection();
    // No selection → let ⌘C fall through so it doesn't shadow anything;
    // interrupt stays ⌃C, which is unaffected here.
    if (!sel) return false;
    void navigator.clipboard?.writeText(sel).catch(() => {});
    return true;
  }
  if (key === "v") {
    void pasteIntoPty(io);
    return true;
  }
  return false;
}

/** ⌘V into a PTY. Text is bracketed-pasted; an image is handed to the agent
 *  CLI by forwarding Ctrl+V instead.
 *
 *  A PTY carries bytes, so there is no way to push a screenshot down it. Both
 *  Claude Code and Codex solve that by reading the OS pasteboard themselves
 *  when they see Ctrl+V (0x16) — which is why, until now, ⌘V looked broken for
 *  images and people had to know to press Ctrl+V on a Mac. We ask Rust whether
 *  the clipboard holds an image (the webview can't answer: WKWebView gates
 *  `navigator.clipboard.read()` behind its own paste gesture) and forward the
 *  byte when it does, so one shortcut covers both kinds of paste.
 *
 *  Text wins a tie, and an unanswerable clipboard falls back to the text path —
 *  0x16 is `quoted-insert` in readline, so sending it speculatively would eat
 *  the user's next keystroke. */
async function pasteIntoPty(io: ClipboardKeyIO): Promise<void> {
  let text = "";
  try {
    text = (await navigator.clipboard?.readText()) ?? "";
  } catch {
    /* denied or empty — the image probe below is the remaining chance */
  }
  if (text) {
    io.writeBytes(Array.from(ENC.encode(`\x1b[200~${text}\x1b[201~`)));
    return;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    if (await invoke<boolean>("clipboard_has_image")) {
      io.writeBytes([0x16]);
    }
  } catch {
    /* not running under Tauri, or the command is unavailable — nothing to paste */
  }
}
