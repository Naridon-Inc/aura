// The OS pasteboard, reached through Rust rather than the webview.
//
// `navigator.clipboard` cannot carry this app's copy and paste. WKWebView
// grants `readText()` only inside a paste gesture of its own making — which a
// Tauri window never produces — so reading it threw every time, and
// `writeText()` is refused once the keydown's user gesture has been spent,
// which any `await invoke(...)` spends. Those two gates are why ⌘V in a
// terminal did nothing and why a ⌘C that first had to ask Rust for the
// selection copied nothing.
//
// Rust holds no gesture to spend, so these three are the app's clipboard.
// `navigator` stays as the fallback for running the UI in a plain browser
// (`bun dev`, tests), where there is no Tauri command to call.

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** The pasteboard's text, or `""` when it holds none (or cannot be read). */
export async function readClipboardText(): Promise<string> {
  try {
    return await tauriInvoke<string>("clipboard_read_text");
  } catch {
    /* not under Tauri — try the webview, which may be allowed in a browser */
  }
  try {
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    return "";
  }
}

/** Put `text` on the pasteboard. `false` means it did not get there, so a
 *  caller can say so instead of flashing "Copied". */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    await tauriInvoke<void>("clipboard_write_text", { text });
    return true;
  } catch {
    /* not under Tauri — fall through */
  }
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Does the pasteboard hold an image (and no text)?
 *
 *  Only Rust can answer: `navigator.clipboard.read()` needs the same gesture
 *  WKWebView withholds. Terminals ask because a PTY carries bytes, not
 *  pictures — the agent CLIs read the pasteboard themselves when they see
 *  Ctrl+V, so an image is forwarded as that byte rather than pasted. */
export async function clipboardHasImage(): Promise<boolean> {
  try {
    return await tauriInvoke<boolean>("clipboard_has_image");
  } catch {
    return false;
  }
}
