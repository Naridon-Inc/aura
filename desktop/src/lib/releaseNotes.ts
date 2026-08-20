// What's New — the post-update note shown once per version.
//
// Every release gets the same small, dismissible card at the foot of the
// sidebar — a quiet "here's what changed" the user can wave away. It is gated
// on "this exact version, not yet seen": dismissing it marks the version seen,
// so it never nags twice.
//
// A fresh install sees nothing — onboarding owns that first moment; we silently
// record the version so the first *update* is the first card the user ever sees.
//
// Plain-language only (the audience are non-engineers): say what they can now
// DO, never the mechanism. Update RELEASE_NOTES[0] each release before cutting
// it.
//
// There is one surface: the small dismissible card at the foot of the sidebar.
// Big releases used to take over the middle of the screen with a full-screen
// modal instead, which interrupts the thing you opened the app to do in order
// to tell you about work that is already done and will still be there in a
// minute. The card says the same thing from the corner and waits.

export type ReleaseNote = {
  /** Exact app version — must match package.json / getVersion(). */
  version: string;
  /** Human label for display only, e.g. "June 2026". */
  date: string;
  /** One plain-language headline. */
  title: string;
  /** 2–5 short "you can now…" lines. The card leads with the first. */
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
    version: "0.19.39",
    date: "August 2026",
    title: "Your project can say no to an agent, and stop asking about the rest",
    highlights: [
      "A project can now refuse things outright. Until now, every risky thing an agent did arrived as the same question waiting on a click \u2014 which cannot say \u201cnobody here does that\u201d, and only works if somebody is watching at the moment it happens. A new Authority section in your project settings lets you answer three questions once, in writing: deleting something other code may be calling, editing a file a teammate is holding, and sending work off to another machine. Each one can be allowed, asked about, or refused. A refusal cannot be clicked past.",
      "The rules live in the project, in writing. They sit in the settings file that goes into your history alongside the code, so a change to what an agent may do shows up in a review like any other change. Nothing changes for anyone until you write a rule \u2014 the starting point is exactly what it was.",
      "A typo makes an agent do less, never more. An unreadable rule, a missing section or a missing file all fall back to asking, so getting the spelling wrong can never quietly grant something.",
      "Saying yes once means once. Permission cards for these three no longer offer \u201calways allow\u201d \u2014 \u201cyes, delete this function\u201d must never quietly become \u201cyes, delete anything\u201d. A standing yes is a rule you write down, where it can be read.",
      "The wall of red \u201cunexplained change\u201d rows is gone. A build or a formatter touching a lot of files at once could fill the screen with things to accept or revert, because Aura had briefly stopped recording reasons while it waited out a cooldown. Recording never pauses now, and working out why something changed is Aura\u2019s job rather than a question that interrupts you. The reasons still land in your history, and the check that runs when you commit is unchanged.",
      "It calls them machines. The word \u201cplace\u201d had leaked into a few screens where \u201cmachine\u201d is what people actually say.",
    ],
  },
  {
    version: "0.19.38",
    date: "August 2026",
    title: "A parallel copy opens where you want it, not always in a chat",
    highlights: [
      "A new parallel copy stops assuming you want a chat. Making a copy of a project always dropped you into an Aura chat, which is one opinion about how you work — and the wrong one if you drive Claude Code or Codex from a terminal, or if you only wanted to read the code. Settings → Copies now has a single choice: just the code, an Aura chat, or any agent you have installed. Whatever you typed as the objective is carried into whichever one you pick.",
      "The default changed. A new copy now opens the code and nothing else. If you liked the chat, it is one setting away and it behaves exactly as it did.",
      "The choice follows you, not the project. It is the same setting in every project, because which tool you reach for is a fact about you. You can change it with no project open at all.",
      "Uninstall an agent and your copies keep opening. If the agent you picked isn't on this machine any more, a copy quietly opens the code instead of failing, and the setting tells you why.",
      "An agent's icon stops looking like it has a stray border. A working agent was drawn with a box around its logo in one of three colours depending on what it was doing. The logo now simply breathes while it works and pulses when it needs you, which reads as status instead of as a rendering mistake.",
      "The web console got its own home. app.auravcs.com is a real control plane now — the machines your team can work on, what each person spent, who is in a session right now, and the task and crew board, each as its own screen rather than something buried behind a tab.",
    ],
  },
  {
    version: "0.19.37",
    date: "August 2026",
    title: "Committing stops freezing the app, and undo undoes",
    highlights: [
      "Saving your work no longer looks like a crash. On a big project the check Aura runs before every commit could sit for nearly two minutes with nothing on screen, and on some machines it stopped forever waiting on a question it had no way to ask you. It now finishes in about five seconds on the same project, and when it does need an answer it only asks where you can actually give one — otherwise it decides for itself and says what it decided.",
      "Undo works where you are typing. ⌘Z and ⌘⇧Z had quietly stopped doing anything in the file editor, in Pages and in the chat box, because the Mac's own menu was catching the key first and handing it somewhere that knew nothing about your text. Whatever you're typing in now gets the undo.",
      "Links an agent prints are clickable. A web address in a terminal underlined when you hovered it and then did nothing at all. Clicking one opens it now.",
      "Paste a screenshot with ⌘V. Images only went in with ⌃V, which nobody would guess. ⌘V takes them now, and still pastes text as text.",
      "A tab tells you one thing, once. A working agent used to be announced three times over — a spinner, a coloured dot and the agent's own icon — and the yellow dot read like something had gone wrong. The icon itself now breathes while the agent works and wears a quiet ring when it's waiting for you. And when a tab belongs to another project, that project's name sits underneath the tab name instead of shoving the close button off the edge.",
      "Aura tells you when an agent's update is stuck. Some CLIs asked to be updated over and over because the update landed somewhere your shell never looks. Settings → Agents now names the copy that's actually running, the one that's hiding, and what to do about it.",
      "We count a little more of what happens in the app, and we made the rules about it enforceable. Only counts and flags — never your code, your prompts, your file names or your project paths — and anything that even looks like one of those is thrown away before it can leave your machine. It stays off unless you said yes, and you can turn it off whenever you like in Settings → Privacy.",
    ],
  },
  {
    version: "0.19.36",
    date: "August 2026",
    title: "A computer your whole team can work on — and Aura can make it for you",
    highlights: [
      "Your team can share a computer to work on, and only one person ever has to set it up. An admin names a place, picks a size, and Aura makes the machine — or points at a box you already own. Everyone the admin lets in just signs in and starts working there: no keys to copy, nothing to install, no wizard. Both kinds behave the same, deliberately: anything you can do on a machine you built yourself you can do on one Aura made, and the other way round.",
      "Sharing a machine no longer means sharing an account. Each person gets their own login on the box, their own tools, their own agent credentials, and their own share of the machine — so one person's build can't starve everyone else's. And what you do there is yours: a commit made on a shared machine says who made it, instead of being signed by whoever set the box up.",
      "Push as yourself from a machine you share. Aura can mint a short-lived credential just for you, borrow the key already on your laptop for the length of the connection, or use a token you've stored — and it always says which one it's using, so a credential everyone shares is labelled as one. GitLab, Bitbucket and your own server work too, not only GitHub.",
      "A machine nobody is using goes to sleep, and wakes up when you come back. You can see it's asleep and roughly how long it takes to be ready, so an idle machine stops billing you for sitting there. Works on the machines Aura makes, and on your own cloud account if you let Aura start and stop things in it.",
      "Your project's setup gets built once, not once per person. A project can declare what it needs — languages, tools, packages — and every place becomes that, so the second person to arrive starts from what the first one built. Need one tool just for yourself? Install it for yourself, without root, without touching anyone else's. And a machine will tell you what it actually has against what the project asked for, so \"works over there, not on mine\" is a list rather than a mystery.",
      "Two places at once, side by side, in one window. Open a second project — or a second machine — without losing the first: your tabs, open files and terminals all stay where you left them on both, and either one can pop out into its own window. Before, entering a machine emptied everything else out of the app.",
      "Pick which team you're acting as. In more than one? Switch between them without signing out, and each shows its own projects and its own machines, with your personal work alongside. An admin turns cloud on one person at a time, only members can reach the team's machines, and taking someone out of the team takes their reach with it. You can also see what you spent, separately from what your teammates spent.",
      "Fixes: on Linux the window had two title bars stacked, one covering the app · Aura sat on the Mac's audio devices, which made AirPods bounce between iPhone and Mac · the \"Aura is off\" banner had a Try again button that did nothing and hid the real reason · everyone without a profile picture was handed the same face · opening a fresh copy of a repo could offer you a teammate's identity as your own · and Claude Code and the other agent CLIs can open files in Aura's own tabs now.",
    ],
  },
  {
    version: "0.19.35",
    date: "August 2026",
    title: "Aura can read the web now, and tells you what each answer cost",
    highlights: [
      "Aura can look things up. Ask it to check a site, read the docs for something you're integrating, or find out why an error message says what it says, and it will actually go and read the page. Until now it couldn't, and it said so: asked to look at a website, it replied that it had no way to open one. It searches too, so it can find the page without you pasting a link.",
      "You can see what you're spending. When Aura is running on your own API key, every answer now shows what that answer cost, right next to the message, not buried, not on hover. Open the meter and you'll also see the total that key has run up since you added it, across every project you've used it in. Swap the key and the count honestly starts again. Where a model's price isn't published yet, the figure is marked as an estimate rather than quietly guessed, and you can set your own rates if you'd rather be exact.",
      "Screenshots work with every model. Dropping an image into the chat only ever reached one of the models Aura can talk to; on the others it arrived as unreadable text or was refused outright. Gemini and the OpenAI models can see your images now.",
      "Aura's own Gemini key, separate from the Gemini CLI's. Adding a key to Aura no longer means signing anything else in or out, and the model list refreshes the moment you add it. You don't have to restart to find the models the key can reach.",
      "Gemini conversations survive their own tools. A Gemini answer that used a tool would break on the very next message. It holds together now, however many steps it takes.",
      "Codex picks up where it left off. Starting an agent on a Codex session opened a brand new one instead of resuming the conversation that was already there.",
      "Closing a tab closes what it started. A closed file left its processes running behind it; they go with it now.",
      "The thinking timer counts in tenths, so a fast answer looks as fast as it was.",
    ],
  },
  {
    version: "0.19.34",
    date: "August 2026",
    title: "One way around the app, and it stops telling you things it never checked",
    highlights: [
      "There is one way around the app now. Every destination (your work, your team, your pages, your history, your parallel copies) opens the same way, in the same place, with one row of tabs across the top instead of two, and one bar of chrome instead of three stacked on each other. Panels no longer open by announcing the name of the tab you just clicked. Clicking a destination takes you to it; before, several of them only lit up and left you where you were.",
      "The app stopped claiming things it hadn't looked at. This is the biggest single sweep in the release, and it was everywhere: a review that said \"all clear\" having read half the evidence, \"no secrets found\" from a scan that never ran, \"your project's in good shape\" over problems it had already found, \"Verified\" printed over a proof that said the work was never wired up, \"Safe to keep\" over a critical finding, a clean working tree reported when git had failed, and a dozen lists that told you they were empty before they had read anything. Every one of those now either says what it found or says it couldn't look.",
      "It is much faster to open, and to move around in. Sixteen different panels used to ask the same question separately. Now they ask once and share the answer, and the same is true of your team roster, your project history, your crew and your tasks. Reading the most recent checkpoint used to read every checkpoint you have ever made; on this machine that was 4.7 GB, every time. Panes remember what they last showed instead of reloading from scratch, and sections you never opened stop loading at all.",
      "Your work has one home, and three ways to look at it. Tasks used to offer five, and two of them were the same tasks arranged differently: the plan was your list with its goals above it, and the sprint view was a dashboard about a sprint rather than a way of seeing the work. What's left is a list, a board and a map, genuinely different pictures, and the row above them that made you pick a saved view before any of that is gone. Every row now wears what it used to take a second screen to tell you: what state the work is in, which you can change straight from the row, and which goal it belongs to. Your sprints, workstreams, goals and crews all narrow the work from the rail beside it.",
      "Tasks knows who you are. \"My tasks\" was missing from the list of ways to narrow your work, and filtering by yourself found nothing, not because you had none, but because nothing ever told the page which person you are. It asks now, once per project, so your own work is one click away and a task you create starts out assigned to you.",
      "Team is the team. Real names on messages instead of git logins, one rule for who's online, direct messages that list people as people, a profile with buttons that work, drafts that survive leaving a conversation, and Aura's own bots no longer counted as your colleagues.",
      "Run your project from the terminal, with ⌘R. One command per project, remembered, and it never guesses what to run.",
      "An agent's conversation no longer loses what happened while you were looking elsewhere. Switch to another tab and back, and everything the agent wrote in between used to be gone for good, not late, gone. It's all there now, and it always was; the app simply wasn't going back for it.",
      "Agents stop hanging forever on a question you were never shown. When a chat agent asked permission to do something, nothing drew the prompt, so it waited, indefinitely, looking like it had frozen. The prompt is rendered now, and answering it lets the work continue.",
      "Aura works in your language. Twelve places in the app crashed outright on text that wasn't English. A name, a commit message, a filename. Text that's too long now cuts at a boundary you can read rather than through the middle of a character, dates say which year, and counts stop reading \"5 dependencys\".",
      "A branch no longer has to come with a second folder, and your parallel copies can be named something you'd actually say out loud. They also can't disappear from the sidebar any more: when Aura couldn't read the list of them, it used to show you an empty space rather than say so, and never looked again for as long as the app was open. Nothing had been deleted, but an empty sidebar doesn't look like that.",
      "Upgrading to Pro works. The button couldn't have worked, every request for the individual plan was refused by the server, and it told you nothing when it failed: no message, no error, the spinner simply stopped. It goes to checkout now, and a paid plan gets the allowance it was sold with.",
      "Menus always appear. Filters, Display and the project picker could open with nothing on screen. The menu was there, positioned, listening, and drawn at zero opacity because the fade-in it relies on never started. It looks exactly like a button that does nothing. Menus no longer wait on an animation to become visible.",
      "Smaller things: one loader instead of four, colour that means one thing across the whole app, selected no longer looks like hovered, empty screens that say what the screen is for and what to do next, keyboard shortcuts that do what they say, Escape closing every menu rather than half of them, and money shown the same way in every window.",
    ],
  },
  {
    version: "0.19.33",
    date: "July 2026",
    title: "Every copy of your project in one place, and a commit that has to match what you asked for",
    highlights: [
      "See every copy of your project at once. When several things are being worked on in parallel, each gets its own copy of your project, and until now they were easy to lose track of. Workspaces lists them all in one place: what's unfinished in each, how far each has moved from your main line, and who or what is working in it.",
      "Agents in different copies stop colliding. Aura now watches every copy of a project together, so when two agents are about to change the same thing in different copies, they find out before it happens instead of after. What's inside each copy still stays private to that copy.",
      "A commit now has to match what you said you'd do. Before work is committed, Aura compares it against the intent behind it, and if the two disagree, it stops and shows you the disagreement rather than letting it through quietly.",
      "If something you asked to keep was rewritten anyway, Aura names it. It won't block the commit, the piece is still there, but nobody gets to rewrite something you'd protected without you hearing about it.",
      "Undo now reaches things that were deleted, not just changed. Rewind could already put back a piece that had been rewritten; it can now bring back one that was removed outright.",
      "Turning Aura on now works in every copy of your project. In a separate copy it used to fail every time, and because the reason was thrown away, \"Aura is off\" sat there with a Retry button that did nothing when you pressed it. It works now, and if it still can't turn on, it tells you why in plain words instead of leaving you tapping. The health check was telling the same lie from the other side: in a separate copy it reported Aura's protection as missing and told you to run a command to fix it, when protection was already on and the command changed nothing. It looks in the right place now, so a healthy project reads as healthy.",
      "Your team chat now follows the project, not the folder. If you were working in a separate copy of a project, Aura quietly put you in a room of your own. You could type, and nothing looked broken, but nobody on your team was in there. Separate copies now share one room with the project they came from. Anything said in one of those private rooms stays behind.",
      "An answer being written keeps going while you look at something else. If you switched project or workspace mid-reply and came back, the reply was gone and the timer had reset to a couple of seconds. It looked like Aura had thrown the work away and started over. It never had: the answer was still being written the whole time, you just couldn't see it any more. Now it's still there when you come back, still counting from when it actually began.",
      "Aura is at the top of the sidebar, and clicking Workspaces opens Workspaces. Aura. The one you give a goal to, that hands the work out to your agents and brings their results back together. Had no permanent place to click; you reached it through whatever happened to put it in front of you. It now sits at the top of the list, and picks up the conversation you already had in that project rather than starting a new one each time. Underneath it, the Workspaces row used to only re-select the list beneath it, so clicking it looked like nothing happened. The real view was tucked behind a small arrow next to the label. The row opens it now.",
      "Full screen actually fills the screen. On the newer MacBooks, the ones with a camera notch in the top edge, going full screen left a black strip across the whole top of the window, above everything. That strip was space macOS was holding back for the notch and never giving to Aura. It's Aura's now, so full screen goes all the way up.",
      "Starting a new copy of your project now opens Aura, with what you asked for already in it. You'd type what you wanted, watch the setup steps run, and land in a bare coding tool with your message nowhere to be found. It was being typed in for you the moment that tool started up, and it often got there too early to stick. Now the new copy opens in a conversation with Aura, your request already sent as the first message, on whichever model you picked.",
      "The newest models are in the picker, Opus 5 at the top. Claude's 5 line (Opus 5, Sonnet 5 and Fable 5) sits above the older ones wherever you choose a model, and a fresh install now starts on it rather than last year's. If you've already picked a model yourself, yours is kept.",
      "Every agent you have running shows up when you open a new tab, whatever project it's in. Before, the \"jump to something already open\" list only knew about tabs in the project you were looking at. An agent working in another project, or in a separate copy of one, was invisible until you switched over to find it. They're all listed now, each with the project it's in and a dot showing it's still running, and picking one brings it into the tab you're in.",
      "When Aura hands work to several agents at once, you can see them, and their answers come back. Aura would tell you it had started two agents and then show you nothing, because the moment it saved the conversation it wrote over its own record of them. They were really running the whole time; nobody could see them, and worse, when one finished there was no longer anything for its answer to come back to, so a piece of work that had run for ten minutes was quietly thrown away. Both are fixed: the agents appear as they're handed out, and every one of them reports back.",
      "Smaller things: strict mode reads as a setting rather than an alarm when it's simply on, a sealed stamp shows its real date instead of a question mark, a change whose description couldn't be written says so instead of showing you the refusal, colour means something again across the app, and the Team surface stops redrawing itself on checks that found nothing new.",
    ],
  },
  {
    // Carries two releases' worth: 0.19.31 was built but never published, so
    // everyone updating from 0.19.30 lands here and this note is the only one
    // they'll see. Its best lines are folded in below.
    version: "0.19.32",
    date: "July 2026",
    title: "Changes in plain English, a shared place to write, and Aura on your phone",
    highlights: [
      "Changes now tells you what actually happened, in plain English. Every change says what that piece of your project used to do, what it does now, and why. Written out for you, instead of leaving you to read the code and guess.",
      "See how a feature is really going. Open one and you get an honest read at a glance. How sure Aura is it works, where the risk is, and whether it drifted from what you asked for, with the whole thread of work behind it, across every session and commit.",
      "Ask Aura anything about your project and get the answer first. Press ⌘K, ask in your own words, and it answers from what has actually happened in this project, not a guess.",
      "Nothing disappears quietly. If work would delete part of your project, Aura stops and names exactly what would go, so a deletion is always something you agreed to.",
      "Scribble. A shared place to write. It's the first thing on the right-hand rail now: jot anything, tick things off, pin what matters, and drop in a picture. Anything you didn't finish yesterday carries over to today, and mentioning a teammate puts it in front of them.",
      "Your tasks now sit beside the conversation about them. One Chats / Tasks switch under the project name, instead of the board living off in its own corner.",
      "Your old messages are back. If you or a teammate changed the name you go by, conversations from before could look empty. Every one of them now finds its history again, whatever you were called at the time.",
      "No more freezing after you step away. If one program in a terminal stopped reading, it used to take every other terminal down with it and eventually the whole window. Quitting Aura was the only way out. Now a busy terminal only affects itself, says so, and starts taking your typing again on its own.",
      "See who's working where, live. A team panel at the bottom of Changes shows what your teammates and their agents are touching right now, with their real photos and a verified tick, so two people don't quietly edit the same thing.",
      "See the actual change without leaving the rail. Open a file under Changes and the before-and-after lines expand right there, in plain colour.",
      "Steer an agent while it's working. Tap Steer (or press ⌘↵) to change course mid-task instead of waiting for it to finish, and 'Take {name} out' pulls a single agent out of an Aura chat into its own session.",
      "Let Aura open your pull request. When there's no PR yet, one tap has Aura commit, push, and write a clear title and description from what actually changed. Your Team list also tidies itself, quietly offering 'Same person' when someone shows up twice.",
      "Smoother in the small places: Pages and past sessions open instantly instead of loading from scratch, typing in the terminal keeps up on Intel Macs, messages no longer appear twice, ⌘K jumps between projects, the Mac installer is back to drag-onto-Applications, and Aura wears its new mark.",
      "Aura is coming to iPhone and Android. Check on your agents, steer them, and approve work from anywhere. Join the waitlist and we'll email you an invite when it's ready.",
    ],
    cta: { label: "Join the phone waitlist", kind: "mobile-waitlist" },
  },
  {
    version: "0.19.31",
    date: "July 2026",
    title: "Steer with a tap, pull one agent out, and a self-tidying Team",
    highlights: [
      "Steer an agent with one button. While it's working, tap Steer (or press ⌘↵) to change course. Your new direction lands right away instead of waiting for it to finish.",
      "Pull a single agent out of an Aura chat in one tap. 'Take {name} out' hands you its own session, and that same session shows up in your terminal, so you can keep going there too.",
      "Your Team list tidies itself. When one person shows up twice. A work email next to a personal one, a name that matches their GitHub handle. Aura quietly offers 'Same person' to fold them into one. Nothing merges without your say-so, and 'Different people' makes the hint stop.",
      "Let Aura open your pull request. When there's no PR yet, one tap has Aura commit, push, and write a clear title and description from what actually changed.",
      "New here? A ready-made sample project is waiting on first launch, and the Get-started tour now speaks to people who already build with agents. Less 'what is an AI coder', more what makes Aura different.",
    ],
  },
  {
    version: "0.19.30",
    date: "July 2026",
    title: "Steer a working agent, browse your Pages, and a cleaner Team view",
    highlights: [
      "Change course mid-task: while an agent is working, send a follow-up and it redirects right away instead of waiting for it to finish. Press ⌘↵ to steer, or set Queue vs Steer as your default in Settings → Behavior → Chat.",
      "Pages now work like a browser. Back and forward arrows to retrace your steps, and every page opens instantly instead of reloading from scratch. Switch projects and you stay on Pages or Tasks instead of being bounced back to Build.",
      "The Team view reads like a real conversation now: activity grouped into plain-language threads, a tidier member list, and cleaner headers.",
      "Nicer editing: code blocks are clean and colour-coded with a language picker, and Undo (⌘Z) works again in the file editor.",
      "Images you send in chat show as a neat little card under your message instead of stretching the bubble.",
    ],
  },
  {
    version: "0.19.29",
    date: "July 2026",
    title: "Start new work on your always-on cloud machine",
    highlights: [
      "When you start new work, pick where it runs: Local keeps it on this computer, Cloud hands it to your always-on machine so it keeps going after you close your laptop.",
      "Not set up for cloud yet? A one-tap 'Set up cloud' signs you in, then the same button sends your work to the cloud.",
      "Cloud shows a quick status: green means a machine is ready and your work starts right away, amber means it waits in line until one comes online.",
    ],
  },
  {
    version: "0.19.28",
    date: "July 2026",
    title: "Files open properly, and dropped screenshots land",
    highlights: [
      "Open a file and you'll actually see it. On some setups a file could open to a blank page. Now the text shows every time, whatever the file.",
      "Drag a screenshot into the terminal or a chat and it lands where you drop it, instead of quietly going nowhere.",
    ],
  },
  {
    version: "0.19.27",
    date: "July 2026",
    title: "Folders you open now stay put",
    highlights: [
      "Open a folder and it stays in your sidebar, even when your recent list is already full, so a project you just opened never quietly disappears on you.",
    ],
  },
  {
    version: "0.19.23",
    date: "July 2026",
    title: "Connect Linear, bring your own AI cloud, and watch your deploys",
    highlights: [
      "Plan in Linear? Connect it the same way you connect Jira. Your Linear issues flow straight onto Aura’s task board, so the work in front of you lines up with the tickets that describe it.",
      "Use the AI account your company already pays for. Aura now works with Claude through Amazon Bedrock and Google Vertex, and with Azure OpenAI. Point Aura at your cloud and it just works, no extra key to buy.",
      "Stacked pull requests finally read as a stack. If you use Graphite, Aura shows your PRs in the order they build on each other, marked as a Graphite stack, instead of a flat, out-of-order list.",
      "See your deploy right on the pull request. When a change is building or live on Vercel, Aura shows the status and a one-click link to open the preview. No switching tabs to find out whether it shipped.",
      "Open your project anywhere. A new “Open in…” jumps a repo or file straight into VS Code, Cursor, or whichever editor you prefer. And Settings got a cleaner, more compact makeover that’s quicker to move around.",
    ],
  },
  {
    version: "0.19.22",
    date: "July 2026",
    title: "More coding agents, and connecting Codex just got clearer",
    highlights: [
      "Aura now knows more coding agents out of the box. Google’s Antigravity (agy), Aider and Amp join Claude, Gemini, Codex, Cursor and the rest. Any of them shows up ready to launch the moment it’s installed, and you can still point Aura at any other command-line agent yourself.",
      "Pin the agents you actually use. A new pin sits next to each agent in Settings → Agents (and the quick-launch bar). Pin the two or three you reach for so they’re one tap away, and unpin the rest. Your installed agents come pinned to start with.",
      "Connecting Codex now tells you what’s actually going on. If Codex isn’t installed, or is installed but won’t run, Aura says so and hands you the exact command to fix it, instead of a Connect button that quietly does nothing. Already signed in to Codex through the ChatGPT app? Aura now sees that too.",
      "The #aura channel used to count only you. Its header said “· 1” and its member list showed just your own machine. Now it reflects everyone who has posted there, so the count, the members rail, and @-mentions all show the real community around you.",
    ],
  },
  {
    version: "0.19.19",
    date: "July 2026",
    title: "“Check for Updates” is back, plus a menu bar that keeps up",
    highlights: [
      "You can check for a new version any time again: Aura → Check for Updates in the menu bar. It tells you straight away whether there’s an update or you’re already on the latest.",
      "The menu bar now reaches everything the app can do. A new Go menu jumps to your Tasks, Pages, Pull Requests, Extensions, Project Timeline and Time Machine, and the Engine menu adds Ask Aura, Prove a Goal, Plan Builder and Orchestrate.",
      "When two of your accounts are the same person, Aura now reads them both as you, while still keeping them as two separate people on the team, so nobody gets quietly merged.",
    ],
  },
  {
    version: "0.19.18",
    date: "July 2026",
    title: "A security hardening update",
    highlights: [
      "We closed several security gaps across team chat, live sync, and sign-in, and tightened what the app will load from the web. Your messages and your team stay yours.",
      "Nothing changes in how you work day-to-day. This one’s under the hood. Updating is recommended for everyone.",
    ],
  },
  {
    version: "0.19.17",
    date: "July 2026",
    title: "Agents always start in the project you’re in",
    highlights: [
      "Fixed a case where starting an agent could reopen a conversation that belonged to a different project, or a different copy of your work you’d since put away. Each agent now always starts its own conversation in the project you’re actually working in, and never picks up someone else’s.",
    ],
  },
  {
    version: "0.19.16",
    date: "July 2026",
    title: "Turn the floating Aura on or off, plus tab and agent fixes",
    highlights: [
      "Don’t want the floating ⌘⇧A window? You can now switch it off for good in Settings → Floating HUD. Off means off. ⌘⇧A and the menu-bar icon stay quiet, and it stays that way after you restart.",
      "Closing an agent or terminal tab now actually stops what was running inside it, instead of leaving it going in the background.",
      "Fixed a spot where a permission pop-up could freeze the app while it waited on an answer that never came.",
      "“Start all” now gives each agent its own fresh session, instead of accidentally opening the same one in every tab.",
    ],
  },
  {
    version: "0.19.15",
    date: "June 2026",
    title: "A floating Aura you can call up anywhere, and clearer tab controls",
    highlights: [
      "Press ⌘⇧A from anywhere to pop up a small Aura window that floats over your other apps. Glance at what your agents are doing and send a quick message without switching back to the full app.",
      "Every tab now has a ⋯ button right before its close ×. Click it to split your screen, add the tab to a split, rename it, or close it. All the layout controls in one obvious place, instead of hidden behind a right-click that didn’t always work.",
      "The floating window also lives in your menu bar, and follows whichever project you’re working in.",
    ],
  },
  {
    version: "0.19.14",
    date: "June 2026",
    title: "Chat sessions show what changed, and check their own work",
    highlights: [
      "Open an Aura chat session and you’ll now see exactly what it changed (every file it touched, with the before-and-after) instead of an empty Changes list.",
      "When a chat session changes your code, Aura checks it against what you asked all on its own. The result shows up by itself. No “check” button to go find.",
      "Start an agent and it always opens inside your project, never your home folder, and its new workspace shows up right away in its own copy.",
      "Fixed a background crash: a helper Aura runs for you could die noisily and pile up macOS crash reports. It now exits quietly when the app no longer needs it.",
    ],
  },
  {
    version: "0.19.13",
    date: "June 2026",
    title: "Auto stays on Auto, and Retry gets straight back to work",
    highlights: [
      "Auto mode no longer leaves you stuck in planning. When it plans something first, it stays on Auto, so your next message just runs, instead of quietly switching you to Plan and never switching back.",
      "Hit “Retry” on a crew task and it gets back to work right away, instead of just sliding back into the queue and waiting.",
    ],
  },
  {
    version: "0.19.12",
    date: "June 2026",
    title: "Crew that recovers on its own, and one-click retry",
    highlights: [
      "When a crew hits a snag, it now gets itself unstuck. It’ll use whichever AI you have installed if the assigned one isn’t set up, save the files an agent forgot to commit, and still merge finished work back even when your project has unsaved changes.",
      "Something didn’t finish? Put it back to work with a single “Retry” on the card, or “Retry all” to re-queue everything that failed at once.",
    ],
  },
  {
    version: "0.19.11",
    date: "June 2026",
    title: "Tabs that stay put, projects in their own window, clearer proof",
    highlights: [
      "Your tabs stay exactly as you left them (same order, same one open) every time you reopen Aura, instead of rearranging on you.",
      "Open any project in its own separate window, so you can keep two side by side.",
      "Reopen a past Aura chat and pick up right where you left off, with a new “Continue chat” button.",
      "When Aura checks its own work, it now tells you up front how many checks passed, like “Done · 3 of 3 checks”.",
    ],
  },
  {
    version: "0.19.10",
    date: "June 2026",
    title: "Your chat name is now your GitHub username. Everywhere",
    highlights: [
      "Team chat now shows you under your GitHub username on every project, instead of a piece of your email address.",
      "Your name stays the same across all your machines and projects, even when you commit under different email addresses.",
      "Still no sign-in needed. Team chat keeps working for free, the moment you open a project.",
      "Your older messages still show as you, so nothing in your history looks like it came from a stranger.",
    ],
  },
  {
    version: "0.19.9",
    date: "June 2026",
    title: "Redesigned Pages, “this is me” per project, and instant assignment DMs",
    highlights: [
      "Pages got a cleaner redesign. Your notes and docs are easier to read, write, and find.",
      "Tell Aura which teammate is you on each project, so your work is always credited to the right person.",
      "Get a direct message the moment someone assigns you a task or mentions you. No more missed handoffs.",
      "Importing a long coding-agent session no longer freezes the app or jams the scroll.",
      "Link your Jira teammates to their Aura profiles. Matched by email with a one-click confirm, never silently merged.",
    ],
  },
  {
    version: "0.19.6",
    date: "June 2026",
    title: "Snappier history, one-click workspaces, tidier tabs",
    highlights: [
      "Opening your sessions and activity history is now near-instant. It no longer re-reads everything from scratch each time you switch back to it.",
      "Click a workspace and you land straight in a working view. Its main copy is always right there, never hidden behind “other parallel copies”.",
      "Right-click any tab (file, chat, terminal, or agent) for the same menu: split it beside or below, rename, or close.",
      "Opening a folder to work in now lets you create a new folder right from the picker.",
      "Coding agents running inside Aura no longer trip an error on every command.",
    ],
  },
  {
    version: "0.19.5",
    date: "June 2026",
    title: "Switch AIs mid-chat without the thread breaking",
    highlights: [
      "Switching from one AI to another mid-conversation stays seamless. Aura keeps each one's words straight and never claims to be a model it isn't.",
      "If an AI hits its limit or stumbles, Aura quietly continues on another and keeps going, so your conversation doesn't stall.",
      "Long chats stay sharp: the important context carries forward even when Aura hands off between models.",
      "Your direct messages stay between the two of you. A stray message from someone else can no longer show up inside a one-to-one chat.",
    ],
  },
  {
    version: "0.19.4",
    date: "June 2026",
    title: "Fixes for files, agents, and switching models",
    highlights: [
      "Switching the model, say from Claude to Gemini, now actually takes effect for the rest of the chat.",
      "New files and folders land in the folder you're working in, and you can drag a file onto a folder to move it.",
      "Starting a new agent reliably shows up in your sidebar.",
      "Re-opening a past conversation tells you at a glance whether it's an Aura chat or a Claude Code session.",
      "Everyone's on the beta channel now. Look for the badge by the Aura name; it means you get fixes the moment they're ready.",
    ],
  },
  {
    version: "0.19.3",
    date: "June 2026",
    title: "Understands your code, and a crew you can watch",
    highlights: [
      "Aura now grasps your code without reading whole files, and each reply shows roughly how much it saved by doing so (turn it off in Settings → Experimental).",
      "When a job needs several agents at once, Aura runs them as one coordinated crew. A tidy strip in chat shows who's on what, with proof when each piece lands.",
      "Re-opening past conversations now finds your Claude Code sessions too, not just Aura's own.",
      "The model picker stays up to date on its own, with clear names for each one.",
    ],
  },
  {
    version: "0.19.1",
    date: "June 2026",
    title: "Snappier chat and friendlier copies",
    highlights: [
      "Chat no longer gets stuck on “Loading…”, even very long conversations open right up.",
      "Long-running work stays quick and light instead of slowly bogging down in the background.",
      "The copies an agent works in now show a friendly name like “New Git · copy” instead of a machine code.",
    ],
  },
  {
    version: "0.19.0",
    date: "June 2026",
    title: "Faster, calmer, and it remembers",
    highlights: [
      "Aura now remembers what it learned across sessions, so it picks up where you left off instead of starting cold.",
      "Plans you can accept and questions Aura asks now stand out clearly in chat. No more hunting for them.",
      "The mode you pick (Auto, Plan, or Ask) sticks for the whole conversation instead of repeating on every message.",
      "Hand Crew a stack of tasks and it works through them on its own, showing you proof each one really did what it set out to.",
      "A fresh look (new blossom mark, calmer onboarding) and you choose up front what anonymous usage data, if any, Aura may collect.",
    ],
  },
];

const SEEN_KEY = "aura.whatsNew.lastSeenVersion";

export type WhatsNewPending = {
  note: ReleaseNote;
};

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

/** Record a version as seen so the card doesn't show for it again. */
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
  return { note };
}
