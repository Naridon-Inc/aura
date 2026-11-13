// One version as `git show --no-color --stat -p` prints it, read into parts.
//
// A machine answers the History detail with that text and nothing else — the
// same read the History sidebar already makes over the machine's connection —
// so who saved it, when, what it says, which files moved and each file's own
// patch all come out of one answer. Kept out of the component so it is under
// test: a `.tsx` in this codebase is not.

import type { GitCommitFileStat } from "../../../lib/api";

export type ShownCommit = {
  sha: string;
  author: string;
  /** Unix seconds; 0 when the date line could not be read. */
  time: number;
  message: string;
  files: GitCommitFileStat[];
  /** Each file's own patch, keyed by its path after the change. */
  patches: Record<string, string>;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** git's default date, `Mon Nov 9 14:02:11 2026 +0000`, as unix seconds.
 *  Read by hand rather than handed to `Date.parse`, which only some engines
 *  accept for this shape — and the app's engine is not the one tests run on. */
export function parseGitDate(text: string): number {
  const m = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4}) ([+-])(\d{2})(\d{2})$/.exec(
    text.trim(),
  );
  if (!m) return 0;
  const month = MONTHS.indexOf(m[1]);
  if (month < 0) return 0;
  const utc = Date.UTC(+m[6], month, +m[2], +m[3], +m[4], +m[5]);
  const offset = (+m[8] * 60 + +m[9]) * 60_000 * (m[7] === "-" ? -1 : 1);
  return Math.floor((utc - offset) / 1000);
}

const DIFF_HEAD = /^diff --git a\/(.+) b\/(.+)$/;

/** `null` when the text is not a shown version at all — an unknown sha comes
 *  back as git's complaint, which the caller shows as the reason. */
export function parseShownCommit(text: string): ShownCommit | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const head = /^commit ([0-9a-f]{7,64})\b/.exec(lines[0] ?? "");
  if (!head) return null;

  let i = 1;
  let author = "";
  let time = 0;
  for (; i < lines.length && lines[i] !== ""; i++) {
    const line = lines[i];
    if (line.startsWith("Author:")) author = line.slice(7).trim().replace(/\s*<[^>]*>$/, "");
    else if (line.startsWith("Date:")) time = parseGitDate(line.slice(5));
  }

  // The message is the indented block after the header. The stat that follows
  // is indented by one space, so it ends the block on its own.
  const message: string[] = [];
  for (i++; i < lines.length && (lines[i].startsWith("    ") || lines[i] === ""); i++) {
    message.push(lines[i].slice(4));
  }

  const files: GitCommitFileStat[] = [];
  const patches: Record<string, string> = {};
  let block: string[] = [];
  let current: GitCommitFileStat | null = null;
  let inHunk = false;
  const close = () => {
    if (current) {
      files.push(current);
      patches[current.path] = block.join("\n") + "\n";
    }
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const d = DIFF_HEAD.exec(line);
    if (d) {
      close();
      current = { path: d[2], status: "M", added: 0, deleted: 0 };
      block = [line];
      inHunk = false;
      continue;
    }
    if (!current) continue;
    block.push(line);
    if (!inHunk) {
      if (line.startsWith("new file mode")) current.status = "A";
      else if (line.startsWith("deleted file mode")) current.status = "D";
      else if (line.startsWith("rename from")) current.status = "R";
      else if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.deleted++;
  }
  close();

  return { sha: head[1], author, time, message: message.join("\n").trim(), files, patches };
}
