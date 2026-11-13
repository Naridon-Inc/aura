//! Turning pasted text into the bytes a child process should read.
//!
//! A paste is not typing, and the difference is visible: a program that asked
//! for bracketed paste (DECSET 2004) wants the whole block fenced so it can
//! insert it instead of acting on each line, while one that never asked reads
//! the fence as literal input and leaves `[200~` in its buffer. Only the
//! render thread knows which of those the terminal is in, so this encoding is
//! decided there — not in the frontend, which cannot see the mode.

/// Bracketed-paste fence, per DECSET 2004.
const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

/// Encode `text` for a terminal whose child has (or has not) asked for
/// bracketed paste.
pub fn paste_bytes(text: &str, bracketed: bool) -> Vec<u8> {
    // The closing fence is stripped either way. Clipboard contents come from
    // anywhere — a web page, a chat message — and text carrying its own
    // `ESC[201~` would otherwise end the envelope early and have whatever
    // follows read as keystrokes, which for a shell means commands.
    let text = text.replace(PASTE_END, "");
    if bracketed {
        let mut out = Vec::with_capacity(text.len() + PASTE_START.len() + PASTE_END.len());
        out.extend_from_slice(PASTE_START);
        out.extend_from_slice(text.as_bytes());
        out.extend_from_slice(PASTE_END.as_bytes());
        return out;
    }
    // No fence: the child is reading this as typing, and a typed line ends
    // with Return. A `\n` is a line feed — it moves the cursor down without
    // submitting anything — so a multiline paste into a shell that has not
    // asked for brackets must carry `\r`, the way every terminal sends it.
    text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brackets_only_when_the_child_asked() {
        assert_eq!(paste_bytes("ls", true), b"\x1b[200~ls\x1b[201~".to_vec());
        assert_eq!(paste_bytes("ls", false), b"ls".to_vec());
    }

    // Inside the envelope the line breaks are the program's business: a TUI
    // inserts them as newlines. Outside it, they are Return.
    #[test]
    fn newlines_become_returns_only_outside_the_envelope() {
        assert_eq!(
            paste_bytes("a\nb", true),
            b"\x1b[200~a\nb\x1b[201~".to_vec()
        );
        assert_eq!(paste_bytes("a\nb", false), b"a\rb".to_vec());
        assert_eq!(paste_bytes("a\r\nb", false), b"a\rb".to_vec());
    }

    // The injection this guards: text that closes the envelope itself, so the
    // rest of the paste lands as keystrokes at a live prompt.
    #[test]
    fn pasted_text_cannot_close_the_envelope_itself() {
        let bytes = paste_bytes("safe\x1b[201~rm -rf /", true);
        assert_eq!(bytes, b"\x1b[200~saferm -rf /\x1b[201~".to_vec());
        assert_eq!(
            bytes.windows(PASTE_END.len()).filter(|w| *w == PASTE_END.as_bytes()).count(),
            1,
            "exactly one closing fence, at the end"
        );
    }

    #[test]
    fn empty_text_still_encodes_cleanly() {
        assert_eq!(paste_bytes("", true), b"\x1b[200~\x1b[201~".to_vec());
        assert!(paste_bytes("", false).is_empty());
    }
}
