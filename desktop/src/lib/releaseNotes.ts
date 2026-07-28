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
  /** An optional one-tap action offered next to "Got it" — for the rare
   *  release where the note isn't the whole story and there's something the
   *  user can actually do about it. `kind` is the thing to open; App owns
   *  what that means. */
  cta?: { label: string; kind: ReleaseCta };
};

/** Things a release note is allowed to offer. Keep this list short. */
export type ReleaseCta = "mobile-waitlist";

// Newest first. The entry whose `version` equals the running app version is the
// one shown after an update.
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.19.33",
    date: "July 2026",
    major: true,
    title: "Every copy of your project in one place — and a commit that has to match what you asked for",
    highlights: [
      "See every copy of your project at once. When several things are being worked on in parallel, each gets its own copy of your project — and until now they were easy to lose track of. Workspaces lists them all in one place: what's unfinished in each, how far each has moved from your main line, and who or what is working in it.",
      "Agents in different copies stop colliding. Aura now watches every copy of a project together, so when two agents are about to change the same thing in different copies, they find out before it happens instead of after. What's inside each copy still stays private to that copy.",
      "A commit now has to match what you said you'd do. Before work is committed, Aura compares it against the intent behind it — and if the two disagree, it stops and shows you the disagreement rather than letting it through quietly.",
      "If something you asked to keep was rewritten anyway, Aura names it. It won't block the commit — the piece is still there — but nobody gets to rewrite something you'd protected without you hearing about it.",
      "Undo now reaches things that were deleted, not just changed. Rewind could already put back a piece that had been rewritten; it can now bring back one that was removed outright.",
      "Smaller things: strict mode reads as a setting rather than an alarm when it's simply on, a sealed stamp shows its real date instead of a question mark, a change whose description couldn't be written says so instead of showing you the refusal, colour means something again across the app, and the Team surface stops redrawing itself on checks that found nothing new.",
    ],
  },
  {
    // Carries two releases' worth: 0.19.31 was built but never published, so
    // everyone updating from 0.19.30 lands here and this note is the only one
    // they'll see. Its best lines are folded in below.
    version: "0.19.32",
    date: "July 2026",
    major: true,
    title: "Changes in plain English, a shared place to write, and Aura on your phone",
    highlights: [
      "Changes now tells you what actually happened, in plain English. Every change says what that piece of your project used to do, what it does now, and why — written out for you, instead of leaving you to read the code and guess.",
      "See how a feature is really going. Open one and you get an honest read at a glance — how sure Aura is it works, where the risk is, and whether it drifted from what you asked for — with the whole thread of work behind it, across every session and commit.",
      "Ask Aura anything about your project and get the answer first. Press ⌘K, ask in your own words, and it answers from what has actually happened in this project — not a guess.",
      "Nothing disappears quietly. If work would delete part of your project, Aura stops and names exactly what would go, so a deletion is always something you agreed to.",
      "Scribble — a shared place to write. It's the first thing on the right-hand rail now: jot anything, tick things off, pin what matters, and drop in a picture. Anything you didn't finish yesterday carries over to today, and mentioning a teammate puts it in front of them.",
      "Your tasks now sit beside the conversation about them. One Chats / Tasks switch under the project name, instead of the board living off in its own corner.",
      "Your old messages are back. If you or a teammate changed the name you go by, conversations from before could look empty — every one of them now finds its history again, whatever you were called at the time.",
      "No more freezing after you step away. If one program in a terminal stopped reading, it used to take every other terminal down with it and eventually the whole window — quitting Aura was the only way out. Now a busy terminal only affects itself, says so, and starts taking your typing again on its own.",
      "See who's working where, live. A team panel at the bottom of Changes shows what your teammates and their agents are touching right now, with their real photos and a verified tick — so two people don't quietly edit the same thing.",
      "See the actual change without leaving the rail. Open a file under Changes and the before-and-after lines expand right there, in plain colour.",
      "Steer an agent while it's working. Tap Steer (or press ⌘↵) to change course mid-task instead of waiting for it to finish — and 'Take {name} out' pulls a single agent out of an Aura chat into its own session.",
      "Let Aura open your pull request. When there's no PR yet, one tap has Aura commit, push, and write a clear title and description from what actually changed. Your Team list also tidies itself, quietly offering 'Same person' when someone shows up twice.",
      "Smoother in the small places: Pages and past sessions open instantly instead of loading from scratch, typing in the terminal keeps up on Intel Macs, messages no longer appear twice, ⌘K jumps between projects, the Mac installer is back to drag-onto-Applications, and Aura wears its new mark.",
      "Aura is coming to iPhone and Android — check on your agents, steer them, and approve work from anywhere. Join the waitlist and we'll email you an invite when it's ready.",
    ],
    cta: { label: "Join the phone waitlist", kind: "mobile-waitlist" },
  },
  {
    version: "0.19.31",
    date: "July 2026",
    major: true,
    title: "Steer with a tap, pull one agent out, and a self-tidying Team",
    highlights: [
      "Steer an agent with one button. While it's working, tap Steer (or press ⌘↵) to change course — your new direction lands right away instead of waiting for it to finish.",
      "Pull a single agent out of an Aura chat in one tap. 'Take {name} out' hands you its own session — and that same session shows up in your terminal, so you can keep going there too.",
      "Your Team list tidies itself. When one person shows up twice — a work email next to a personal one, a name that matches their GitHub handle — Aura quietly offers 'Same person' to fold them into one. Nothing merges without your say-so, and 'Different people' makes the hint stop.",
      "Let Aura open your pull request. When there's no PR yet, one tap has Aura commit, push, and write a clear title and description from what actually changed.",
      "New here? A ready-made sample project is waiting on first launch, and the Get-started tour now speaks to people who already build with agents — less 'what is an AI coder', more what makes Aura different.",
    ],
  },
  {
    version: "0.19.30",
    date: "July 2026",
    major: true,
    title: "Steer a working agent, browse your Pages, and a cleaner Team view",
    highlights: [
      "Change course mid-task: while an agent is working, send a follow-up and it redirects right away instead of waiting for it to finish. Press ⌘↵ to steer, or set Queue vs Steer as your default in Settings → Behavior → Chat.",
      "Pages now work like a browser — back and forward arrows to retrace your steps, and every page opens instantly instead of reloading from scratch. Switch projects and you stay on Pages or Tasks instead of being bounced back to Build.",
      "The Team view reads like a real conversation now: activity grouped into plain-language threads, a tidier member list, and cleaner headers.",
      "Nicer editing: code blocks are clean and colour-coded with a language picker, and Undo (⌘Z) works again in the file editor.",
      "Images you send in chat show as a neat little card under your message instead of stretching the bubble.",
    ],
  },
  {
    version: "0.19.29",
    date: "July 2026",
    major: false,
    title: "Start new work on your always-on cloud machine",
    highlights: [
      "When you start new work, pick where it runs: Local keeps it on this computer, Cloud hands it to your always-on machine so it keeps going after you close your laptop.",
      "Not set up for cloud yet? A one-tap 'Set up cloud' signs you in — then the same button sends your work to the cloud.",
      "Cloud shows a quick status: green means a machine is ready and your work starts right away, amber means it waits in line until one comes online.",
    ],
  },
  {
    version: "0.19.28",
    date: "July 2026",
    major: false,
    title: "Files open properly, and dropped screenshots land",
    highlights: [
      "Open a file and you'll actually see it. On some setups a file could open to a blank page — now the text shows every time, whatever the file.",
      "Drag a screenshot into the terminal or a chat and it lands where you drop it, instead of quietly going nowhere.",
    ],
  },
  {
    version: "0.19.27",
    date: "July 2026",
    major: false,
    title: "Folders you open now stay put",
    highlights: [
      "Open a folder and it stays in your sidebar — even when your recent list is already full — so a project you just opened never quietly disappears on you.",
    ],
  },
  {
    version: "0.19.23",
    date: "July 2026",
    major: true,
    title: "Connect Linear, bring your own AI cloud, and watch your deploys",
    highlights: [
      "Plan in Linear? Connect it the same way you connect Jira. Your Linear issues flow straight onto Aura’s task board, so the work in front of you lines up with the tickets that describe it.",
      "Use the AI account your company already pays for. Aura now works with Claude through Amazon Bedrock and Google Vertex, and with Azure OpenAI — point Aura at your cloud and it just works, no extra key to buy.",
      "Stacked pull requests finally read as a stack. If you use Graphite, Aura shows your PRs in the order they build on each other — marked as a Graphite stack — instead of a flat, out-of-order list.",
      "See your deploy right on the pull request. When a change is building or live on Vercel, Aura shows the status and a one-click link to open the preview — no switching tabs to find out whether it shipped.",
      "Open your project anywhere. A new “Open in…” jumps a repo or file straight into VS Code, Cursor, or whichever editor you prefer. And Settings got a cleaner, more compact makeover that’s quicker to move around.",
    ],
  },
  {
    version: "0.19.22",
    date: "July 2026",
    major: false,
    title: "More coding agents, and connecting Codex just got clearer",
    highlights: [
      "Aura now knows more coding agents out of the box — Google’s Antigravity (agy), Aider and Amp join Claude, Gemini, Codex, Cursor and the rest. Any of them shows up ready to launch the moment it’s installed, and you can still point Aura at any other command-line agent yourself.",
      "Pin the agents you actually use. A new pin sits next to each agent in Settings → Agents (and the quick-launch bar) — pin the two or three you reach for so they’re one tap away, and unpin the rest. Your installed agents come pinned to start with.",
      "Connecting Codex now tells you what’s actually going on. If Codex isn’t installed — or is installed but won’t run — Aura says so and hands you the exact command to fix it, instead of a Connect button that quietly does nothing. Already signed in to Codex through the ChatGPT app? Aura now sees that too.",
      "The #aura channel used to count only you — its header said “· 1” and its member list showed just your own machine. Now it reflects everyone who has posted there, so the count, the members rail, and @-mentions all show the real community around you.",
    ],
  },
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
