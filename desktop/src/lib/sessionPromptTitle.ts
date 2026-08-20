// What to call a past session, given the words it holds.
//
// A transcript's identifying line is the last thing the user typed — openings
// are "hi" and "continue" far more often than they are the subject. But a
// meaningful share of turns are not typed by anyone: scheduled wake-ups, agent
// dispatch, slash-command expansions and system reminders all arrive as raw
// XML on the user channel, and 200 characters of `<task-notification>` will
// win any row it is put in.
//
// So this is not a truncate. It recognises each wrapper the runtime writes,
// says what the turn actually was, and only falls through to the text when the
// text is really the user's. It lived inside the resume dialog until a second
// list of past sessions needed the same answer; two copies of a
// wrapper-recognising function is exactly how one of them ends up recognising
// a wrapper the other doesn't.

import { truncate } from "./truncate";

/** The line to show for a session, from one of its prompts. Empty string when
 *  there is nothing to say — callers decide what an untitled session reads as,
 *  since "empty session" and "(no prompt yet)" belong to different surfaces. */
export function sessionPromptTitle(s: string | null | undefined): string {
  if (!s) return "";
  const trimmed = s.trim();
  if (!trimmed) return "";

  // <task-notification> from ScheduleWakeup / scheduled-task fires.
  if (/^<task-notification[\s>]/i.test(trimmed)) {
    const summary = trimmed.match(/<summary>([\s\S]*?)<\/summary>/i);
    if (summary && summary[1].trim()) return `↻ scheduled · ${collapse(summary[1])}`;
    return "↻ scheduled task";
  }

  // <task> from agent dispatch.
  if (/^<task[\s>]/i.test(trimmed)) {
    const desc = trimmed.match(/<description>([\s\S]*?)<\/description>/i);
    if (desc && desc[1].trim()) return `▶ task · ${collapse(desc[1])}`;
    return "▶ subagent task";
  }

  // <command-name> — slash-command dispatch.
  if (/^<command-name>/i.test(trimmed)) {
    const cmd = trimmed.match(/<command-name>([\s\S]*?)<\/command-name>/i);
    if (cmd && cmd[1].trim()) return `/ ${collapse(cmd[1])}`;
    return "/ command";
  }

  // <system-reminder> — runtime nag, not a real prompt.
  if (/^<system-reminder>/i.test(trimmed)) {
    return "(system reminder)";
  }

  // Autonomous-loop sentinel.
  if (trimmed.includes("<<autonomous-loop")) {
    return "↻ autonomous loop";
  }

  // Generic XML opener — keep the user from seeing raw markup.
  if (trimmed.startsWith("<") && trimmed.endsWith(">") && trimmed.includes("</")) {
    return "(system message)";
  }

  return collapse(trimmed);
}

function collapse(s: string): string {
  return truncate(s.replace(/\s+/g, " ").trim(), 160);
}
