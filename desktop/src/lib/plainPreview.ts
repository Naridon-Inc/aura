// Markdown flattened to prose, for the places that show a few lines of
// something an agent wrote.
//
// Agents write markdown. Every one of them, in every turn. The app renders it
// properly wherever it shows a whole message — and then, in the handful of
// places that show a clamped excerpt, printed the source instead:
//
//     ## PR #460 — `feat(backend): honor partner faviconUrl`
//     **Heads up on the number:** you said #458, but …
//
// That is the first thing you read when you reopen a paused agent, and it
// reads as broken software.
//
// Rendering real markdown there is the wrong fix, not just a bigger one: a
// six-line clamp is not a document. An `h2` at heading size inside it would
// blow out the type ladder, and a fenced code block would eat the whole
// excerpt to show you three lines of somebody's diff. What an excerpt owes the
// reader is the sentence, with the markup out of the way.
//
// So: conservative. It removes syntax and never rewrites words. Anything it
// isn't sure about it leaves exactly as it found it — a preview that quietly
// mangles what the agent said would be worse than one showing asterisks.
//
// Two of those places had grown their own answer, and the same message read
// four ways depending on which one you were looking at. Team chat had a
// second flattener that knew about our sentinel tags but not about headings,
// bullets or links; the pinned-message panel had none at all, so the message
// pinned in the header popover and the same message in the side panel didn't
// match; and a crew task's description was printed exactly as written. The
// sentinel knowledge lives here now, and those are all one call.

/** Fenced blocks, lifted out before anything else touches the text so their
 *  contents are never treated as markup. A preview has no room for the code
 *  itself; it says that code was here and gets on with the sentence. */
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]{0,3}\1[^\n]*$/gm;

/** A fence the writer opened and never closed — a turn cut off mid-stream, or
 *  an agent still typing. Everything from it to the end is that block. */
const OPEN_FENCE = /^[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*\n[\s\S]*$/m;

/** Backslash-escaped punctuation, parked out of the way while the inline rules
 *  run. `\*not emphasis\*` is a literal pair of asterisks, and the emphasis
 *  rule below cannot tell the difference — parking the char out of the ASCII
 *  range is what makes it invisible to those rules rather than merely
 *  adjacent to them. Every escapable character is ASCII, so the shifted
 *  codepoint lands in the private-use block, which is not in anyone's
 *  transcript. */
const ESCAPE_SHIFT = 0xe100;

/** Setext underlines (`====` / `----` under a line) and thematic breaks. Both
 *  are pure typography with nothing to say in one line of prose. */
const RULE = /^[ \t]{0,3}(?:-{3,}|_{3,}|\*{3,}|={3,})[ \t]*$/gm;

/** Our own sentinel tags, which carry a JSON payload the message's renderer
 *  turns into chips: the files someone dropped in, the repo files they picked,
 *  and a relay card. None of it is prose, and a preview that leaves it in
 *  prints the JSON.
 *
 *  Each says the smallest true thing instead. Attachments and repo files leave
 *  a marker, because the message may be nothing but the file and an empty
 *  preview would read as an empty message. A relay is dropped outright — it
 *  writes its own human line immediately above the sentinel for exactly this
 *  reason, and a marker after it would say the same thing twice. */
const SENTINELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/<aura:attachments>[\s\S]*?<\/aura:attachments>/g, "(attachment)"],
  [/<aura:repo-files>[\s\S]*?<\/aura:repo-files>/g, "(file)"],
  [/<aura:relay>[\s\S]*?<\/aura:relay>/g, ""],
  // Anything we add later, until it earns a line above.
  [/<aura:([a-z-]+)>[\s\S]*?<\/aura:\1>/g, ""],
];

export function plainPreview(source: string): string {
  if (!source) return "";
  let s = source.replace(/\r\n?/g, "\n");

  // Ours first, before any rule can mistake a payload for markup.
  for (const [re, mark] of SENTINELS) s = s.replace(re, mark);
  // HTML comments, which in this app are never a person talking: a scribble
  // and a team task line each park their own metadata in one, and a preview
  // that keeps it prints `<!--aura:taskbar a=mhask t=1721808000000-->` after
  // the sentence.
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // Block level, in order: fences first (their bodies are not markup), then
  // the line-leading markers.
  s = s.replace(FENCE, "(code)\n");
  s = s.replace(OPEN_FENCE, "(code)\n");
  s = s.replace(RULE, "");
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_m, ch: string) =>
    String.fromCharCode(ch.charCodeAt(0) + ESCAPE_SHIFT),
  );
  // Headings: `## Title` and the closing-hash form `## Title ##`.
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm, "$1");
  // Blockquotes, however deeply nested.
  s = s.replace(/^[ \t]{0,3}(?:>[ \t]?)+/gm, "");
  // Bullets normalise to one marker; numbered lists keep their numbers, since
  // "step 3" is information and "•" is not.
  s = s.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1- ");
  // A task list is a list with a state worth keeping, in words rather than
  // brackets.
  s = s.replace(/^([ \t]*)- \[([ xX])\][ \t]+/gm, (_m, indent, mark) =>
    `${indent}- ${mark === " " ? "" : "done: "}`,
  );

  // Inline. Images before links — `![alt](src)` is a link with a `!` in front,
  // so the link rule would otherwise leave a stray bang behind.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Reference links: `[text][ref]` keeps the text, and the definition line
  // that pairs with it is not prose.
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  s = s.replace(/^[ \t]{0,3}\[[^\]]+\]:[ \t]+\S+.*$/gm, "");
  // Autolinks.
  s = s.replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1");
  // Inline code, longest runs first so ``a `b` c`` survives intact.
  s = s.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, "$2");
  // Emphasis. Asterisk forms and `__bold__` only — a lone `_` is left alone
  // on purpose, because in this app most of them are inside identifiers
  // (`repo_root`, `agent_history_preroll`) and stripping those would rewrite
  // the very words the reader is trying to read.
  //
  // Every rule requires the marked span to begin and end on a non-space, which
  // is what separates emphasis from arithmetic: `*soft*` is emphasis and
  // `2 * 3 * 4` is twelve.
  s = s.replace(/~~(\S(?:[^~]*\S)?)~~/g, "$1");
  s = s.replace(/\*\*\*(\S(?:[^*]*\S)?)\*\*\*/g, "$1");
  s = s.replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, "$1");
  s = s.replace(/__(\S(?:[^_]*\S)?)__/g, "$1");
  s = s.replace(/(^|[^*\w])\*(\S(?:[^*\n]*\S)?)\*(?![*\w])/g, "$1$2");
  // The escapes did their job in the source; the reader wants the character.
  s = s.replace(/[\uE100-\uE17f]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - ESCAPE_SHIFT),
  );

  // Whitespace last, so the removals above don't leave holes: trailing spaces,
  // then any run of blank lines down to one.
  s = s.replace(/[ \t]+$/gm, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** The same flattening for a preview that gets one line — a list row, a pinned
 *  message, a hover label. Line breaks become spaces, so a message whose first
 *  line is short doesn't waste the other three-quarters of the row.
 *
 *  Flatten before you slice: `[the release notes](https://…)` cut at 40
 *  characters leaves `[the release notes](https://gith` on screen, where
 *  flattening first would have spent those characters on words. */
export function plainLine(source: string): string {
  return plainPreview(source).replace(/\s+/g, " ").trim();
}
