// What the composer does with a paste that is too long to read in the box.
//
// Past 90 lines or 5,000 characters, a paste goes in as a text file attached
// to the message rather than as text in the field: the box stays readable and
// the agent still gets every line.

const LONG_PASTE_LINES = 90;
const LONG_PASTE_CHARS = 5000;

/** Whether pasted text is long enough to attach as a file instead. */
export function isLongPaste(text: string): boolean {
  return (
    text.length > 0 &&
    (text.split("\n").length > LONG_PASTE_LINES || text.length > LONG_PASTE_CHARS)
  );
}

/** The pasted text as a plain-text file, named for when it was pasted. */
export function longPasteFile(text: string, now: number = Date.now()): File {
  return new File([text], `pasted_text_${now.toString(36)}.txt`, { type: "text/plain" });
}
