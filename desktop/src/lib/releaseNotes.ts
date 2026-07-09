// What's New — the post-update note shown once per version.
//
// MAJOR releases earn a one-time modal (real features worth a beat of the
// user's attention). MINOR releases get a small, dismissible card tucked at the
// top of the sidebar — a quiet "here's what changed" they can wave away. Both
// are gated on "this exact version, not yet seen": dismissing either marks the
// version seen, so it never nags twice.
//
// A fresh install sees nothing — onboarding owns that first moment; we silently
// record the version so the first *update* is the first card the user ever sees.
//
// Plain-language only (the audience are non-engineers): say what they can now
// DO, never the mechanism. Update RELEASE_NOTES[0] each release before cutting
// it — and set `major` honestly. Most releases are minor (the small card);
// reserve the modal for releases people would actually want to know about.

export type ReleaseNote = {
  /** Exact app version — must match package.json / getVersion(). */
  version: string;
  /** Human label for display only, e.g. "June 2026". */
  date: string;
  /** true → one-time modal; false → small dismissible sidebar card. */
  major: boolean;
  /** One plain-language headline. */
  title: string;
  /** 2–5 short "you can now…" lines. The card shows the title; the modal
   *  shows the full list. */
  highlights: string[];
};

// Newest first. The entry whose `version` equals the running app version is the
// one shown after an update.
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.19.19",
    date: "July 2026",
    major: false,
    title: "“Check for Updates” is back — plus a menu bar that keeps up",
    highlights: [
      "You can check for a new version any time again: Aura → Check for Updates in the menu bar. It tells you straight away whether there’s an update or you’re already on the latest.",
      "The menu bar now reaches everything the app can do — a new Go menu jumps to your Tasks, Pages, Pull Requests, Extensions, Project Timeline and Time Machine, and the Engine menu adds Ask Aura, Prove a Goal, Plan Builder and Orchestrate.",
      "When two of your accounts are the same person, Aura now reads them both as you — while still keeping them as two separate people on the team, so nobody gets quietly merged.",
    ],
  },
  {
    version: "0.19.18",
    date: "July 2026",
    major: false,
    title: "A security hardening update",
    highlights: [
      "We closed several security gaps across team chat, live sync, and sign-in, and tightened what the app will load from the web. Your messages and your team stay yours.",
      "Nothing changes in how you work day-to-day — this one’s under the hood. Updating is recommended for everyone.",
    ],
  },
  {
    version: "0.19.17",
    date: "July 2026",
    major: false,
    title: "Agents always start in the project you’re in",
    highlights: [
      "Fixed a case where starting an agent could reopen a conversation that belonged to a different project — or a different copy of your work you’d since put away. Each agent now always starts its own conversation in the project you’re actually working in, and never picks up someone else’s.",
    ],
  },
  {
    version: "0.19.16",
    date: "July 2026",
    major: false,
    title: "Turn the floating Aura on or off — plus tab and agent fixes",
    highlights: [
      "Don’t want the floating ⌘⇧A window? You can now switch it off for good in Settings → Floating HUD. Off means off — ⌘⇧A and the menu-bar icon stay quiet, and it stays that way after you restart.",
      "Closing an agent or terminal tab now actually stops what was running inside it, instead of leaving it going in the background.",
      "Fixed a spot where a permission pop-up could freeze the app while it waited on an answer that never came.",
      "“Start all” now gives each agent its own fresh session, instead of accidentally opening the same one in every tab.",
    ],
  },
  {
    version: "0.19.15",
    date: "June 2026",
    major: false,
    title: "A floating Aura you can call up anywhere — and clearer tab controls",
    highlights: [
      "Press ⌘⇧A from anywhere to pop up a small Aura window that floats over your other apps — glance at what your agents are doing and send a quick message without switching back to the full app.",
      "Every tab now has a ⋯ button right before its close ×. Click it to split your screen, add the tab to a split, rename it, or close it — all the layout controls in one obvious place, instead of hidden behind a right-click that didn’t always work.",
      "The floating window also lives in your menu bar, and follows whichever project you’re working in.",
    ],
  },
  {
    version: "0.19.14",
    date: "June 2026",
    major: false,
    title: "Chat sessions show what changed — and check their own work",
    highlights: [
      "Open an Aura chat session and you’ll now see exactly what it changed — every file it touched, with the before-and-after — instead of an empty Changes list.",
      "When a chat session changes your code, Aura checks it against what you asked all on its own. The result shows up by itself — no “check” button to go find.",
      "Start an agent and it always opens inside your project, never your home folder — and its new workspace shows up right away in its own copy.",
      "Fixed a background crash: a helper Aura runs for you could die noisily and pile up macOS crash reports. It now exits quietly when the app no longer needs it.",
    ],
  },
  {
    version: "0.19.13",
    date: "June 2026",
    major: false,
    title: "Auto stays on Auto — and Retry gets straight back to work",
    highlights: [
      "Auto mode no longer leaves you stuck in planning. When it plans something first, it stays on Auto — so your next message just runs, instead of quietly switching you to Plan and never switching back.",
      "Hit “Retry” on a crew task and it gets back to work right away, instead of just sliding back into the queue and waiting.",
    ],
  },
  {
    version: "0.19.12",
    date: "June 2026",
    major: false,
    title: "Crew that recovers on its own — and one-click retry",
    highlights: [
      "When a crew hits a snag, it now gets itself unstuck — it’ll use whichever AI you have installed if the assigned one isn’t set up, save the files an agent forgot to commit, and still merge finished work back even when your project has unsaved changes.",
      "Something didn’t finish? Put it back to work with a single “Retry” on the card — or “Retry all” to re-queue everything that failed at once.",
    ],
  },
  {
    version: "0.19.11",
    date: "June 2026",
    major: false,
    title: "Tabs that stay put, projects in their own window, clearer proof",
    highlights: [
      "Your tabs stay exactly as you left them — same order, same one open — every time you reopen Aura, instead of rearranging on you.",
      "Open any project in its own separate window, so you can keep two side by side.",
      "Reopen a past Aura chat and pick up right where you left off, with a new “Continue chat” button.",
      "When Aura checks its own work, it now tells you up front how many checks passed — like “Done · 3 of 3 checks”.",
    ],
  },
  {
    version: "0.19.10",
    date: "June 2026",
    major: false,
    title: "Your chat name is now your GitHub username — everywhere",
    highlights: [
      "Team chat now shows you under your GitHub username on every project, instead of a piece of your email address.",
      "Your name stays the same across all your machines and projects, even when you commit under different email addresses.",
      "Still no sign-in needed — team chat keeps working for free, the moment you open a project.",
      "Your older messages still show as you, so nothing in your history looks like it came from a stranger.",
    ],
  },
  {
    version: "0.19.9",
    date: "June 2026",
    major: false,
    title: "Redesigned Pages, “this is me” per project, and instant assignment DMs",
    highlights: [
      "Pages got a cleaner redesign — your notes and docs are easier to read, write, and find.",
      "Tell Aura which teammate is you on each project, so your work is always credited to the right person.",
      "Get a direct message the moment someone assigns you a task or mentions you — no more missed handoffs.",
      "Importing a long coding-agent session no longer freezes the app or jams the scroll.",
      "Link your Jira teammates to their Aura profiles — matched by email with a one-click confirm, never silently merged.",
    ],
  },
  {
    version: "0.19.6",
    date: "June 2026",
    major: false,
    title: "Snappier history, one-click workspaces, tidier tabs",
    highlights: [
      "Opening your sessions and activity history is now near-instant — it no longer re-reads everything from scratch each time you switch back to it.",
      "Click a workspace and you land straight in a working view — its main copy is always right there, never hidden behind “other parallel copies”.",
      "Right-click any tab — file, chat, terminal, or agent — for the same menu: split it beside or below, rename, or close.",
      "Opening a folder to work in now lets you create a new folder right from the picker.",
      "Coding agents running inside Aura no longer trip an error on every command.",
    ],
  },
  {
    version: "0.19.5",
    date: "June 2026",
    major: false,
    title: "Switch AIs mid-chat without the thread breaking",
    highlights: [
      "Switching from one AI to another mid-conversation stays seamless — Aura keeps each one's words straight and never claims to be a model it isn't.",
      "If an AI hits its limit or stumbles, Aura quietly continues on another and keeps going, so your conversation doesn't stall.",
      "Long chats stay sharp: the important context carries forward even when Aura hands off between models.",
      "Your direct messages stay between the two of you — a stray message from someone else can no longer show up inside a one-to-one chat.",
    ],
  },
  {
    version: "0.19.4",
    date: "June 2026",
    major: false,
    title: "Fixes for files, agents, and switching models",
    highlights: [
      "Switching the model — say from Claude to Gemini — now actually takes effect for the rest of the chat.",
      "New files and folders land in the folder you're working in, and you can drag a file onto a folder to move it.",
      "Starting a new agent reliably shows up in your sidebar.",
      "Re-opening a past conversation tells you at a glance whether it's an Aura chat or a Claude Code session.",
      "Everyone's on the beta channel now — look for the badge by the Aura name; it means you get fixes the moment they're ready.",
    ],
  },
  {
    version: "0.19.3",
    date: "June 2026",
    major: false,
    title: "Understands your code, and a crew you can watch",
    highlights: [
      "Aura now grasps your code without reading whole files — and each reply shows roughly how much it saved by doing so (turn it off in Settings → Experimental).",
      "When a job needs several agents at once, Aura runs them as one coordinated crew — a tidy strip in chat shows who's on what, with proof when each piece lands.",
      "Re-opening past conversations now finds your Claude Code sessions too, not just Aura's own.",
      "The model picker stays up to date on its own, with clear names for each one.",
    ],
  },
  {
    version: "0.19.1",
    date: "June 2026",
    major: false,
    title: "Snappier chat and friendlier copies",
    highlights: [
      "Chat no longer gets stuck on “Loading…” — even very long conversations open right up.",
      "Long-running work stays quick and light instead of slowly bogging down in the background.",
      "The copies an agent works in now show a friendly name like “New Git · copy” instead of a machine code.",
    ],
  },
  {
    version: "0.19.0",
    date: "June 2026",
    major: true,
    title: "Faster, calmer, and it remembers",
    highlights: [
      "Aura now remembers what it learned across sessions, so it picks up where you left off instead of starting cold.",
      "Plans you can accept and questions Aura asks now stand out clearly in chat — no more hunting for them.",
      "The mode you pick — Auto, Plan, or Ask — sticks for the whole conversation instead of repeating on every message.",
      "Hand Crew a stack of tasks and it works through them on its own, showing you proof each one really did what it set out to.",
      "A fresh look — new blossom mark, calmer onboarding — and you choose up front what anonymous usage data, if any, Aura may collect.",
    ],
  },
];

const SEEN_KEY = "aura.whatsNew.lastSeenVersion";

export type WhatsNewPending = {
  note: ReleaseNote;
  surface: "modal" | "card";
};

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

/** Record a version as seen so neither surface shows for it again. */
export function markWhatsNewSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    /* private mode — best-effort; worst case the card shows once more */
  }
}

/**
 * What (if anything) to show for `currentVersion`. Returns null when there's
 * nothing to show:
 *  - same version already seen,
 *  - no note authored for this version (advance the baseline silently), or
 *  - a fresh install (no prior baseline → record current, greet nothing;
 *    onboarding owns first-run, so the first *update* is the first card).
 */
export function pendingWhatsNew(
  currentVersion: string,
): WhatsNewPending | null {
  const v = (currentVersion ?? "").trim();
  if (!v) return null;

  const seen = readSeen();
  if (seen == null) {
    // Fresh install — set the baseline, show nothing.
    markWhatsNewSeen(v);
    return null;
  }
  if (seen === v) return null;

  const note = RELEASE_NOTES.find((n) => n.version === v);
  if (!note) {
    // Updated to a version we didn't author notes for — don't show a blank
    // card; just advance the baseline so the next noted release shows once.
    markWhatsNewSeen(v);
    return null;
  }
  return { note, surface: note.major ? "modal" : "card" };
}
