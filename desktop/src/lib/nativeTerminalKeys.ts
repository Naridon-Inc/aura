//! Keyboard-event → PTY byte encoding for the native terminal.
//!
//! xterm.js does this internally; the native terminal renders in Rust, so the
//! DOM hole captures keydown and we translate here to the same byte sequences a
//! VT/xterm terminal sends: control codes, CSI arrow/nav sequences, Alt-prefix
//! (meta), and printable characters. Returns `null` for keys we don't own
//! (bare modifiers, ⌘ chords, F-keys) so the browser/app keeps its default —
//! never a silent swallow.

/** Translate a keydown into the bytes to write to the shell, or `null` to let
 *  the event fall through to the browser/app. */
export function keyEventToBytes(e: KeyboardEvent): string | null {
  const { key, ctrlKey, altKey, metaKey } = e;

  // ⌘ chords (copy/paste, app shortcuts) are never terminal input.
  if (metaKey) return null;
  // Bare modifier presses produce no bytes.
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") {
    return null;
  }

  // Named keys → fixed sequences.
  switch (key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return ctrlKey ? "\x08" : "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    case "Delete":
      return "\x1b[3~";
    case "Insert":
      return "\x1b[2~";
    default:
      break;
  }

  // Ctrl + key → C0 control code (^A..^Z + a few symbols).
  if (ctrlKey && !altKey && key.length === 1) {
    const lower = key.toLowerCase();
    if (lower >= "a" && lower <= "z") {
      return String.fromCharCode(lower.charCodeAt(0) - 0x60); // ^A = 0x01
    }
    const symbols: Record<string, string> = {
      "[": "\x1b",
      "\\": "\x1c",
      "]": "\x1d",
      "^": "\x1e",
      _: "\x1f",
      " ": "\x00",
    };
    if (key in symbols) return symbols[key];
    return null;
  }

  // Alt/Option + char → ESC-prefixed (meta) byte.
  if (altKey && !ctrlKey && key.length === 1) {
    return "\x1b" + key;
  }

  // A single printable character (letters, digits, punctuation, and — since
  // `key` carries the composed value — most IME/dead-key results too).
  if (!ctrlKey && !altKey && key.length === 1) {
    return key;
  }

  return null;
}
