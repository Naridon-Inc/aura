// What the person has highlighted, remembered outside React.
//
// An agent asking "what am I looking at?" gets answered from here. It has to
// live outside the component tree because the editor that owns the selection
// and the listener that answers the agent are in different places, and the
// answer must survive the editor losing focus — clicking into an agent's
// terminal tab to type a question is exactly when the selection matters
// most, and it is also the moment Monaco stops being the focused element.

export type EditorSelection = {
  filePath: string;
  /** The highlighted text. Empty when the cursor is just sitting somewhere,
   *  which is a legitimate answer — "here, nothing selected". */
  text: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

let last: EditorSelection | null = null;

export function rememberSelection(sel: EditorSelection): void {
  last = sel;
}

/** The last selection, which may name a file that has since been closed —
 *  callers check that the tab is still open before reporting it. */
export function currentSelection(): EditorSelection | null {
  return last;
}
