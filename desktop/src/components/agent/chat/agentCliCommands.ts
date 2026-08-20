//! What each coding-agent CLI calls its own controls, in one table.
//!
//! The native Aura brain changes model by putting a field on the next request.
//! A CLI agent cannot be driven that way: it is a long-lived REPL that we hold
//! open in a PTY, and the ONLY thing it accepts mid-conversation is the text a
//! person would have typed. So the chat composer's model chip does not route
//! through any of the brain's model plumbing — it writes that CLI's own slash
//! line into the child, exactly as if the user had typed it into the terminal.
//! Same for every other control here.
//!
//! Which means the table below is load-bearing in a way a normal config isn't:
//! a wrong line here is a control that silently does nothing, or worse, types
//! garbage into someone's session. So every entry is VERIFIED against the
//! installed CLI rather than remembered — read out of the shipped JS bundle
//! (`gemini`), out of the compiled binary's own string table (`codex`, `kimi`),
//! or already proven by the shipped `SLASH_COMMANDS` catalog (`claude`). When a
//! CLI could not be verified, it gets NO entry and the composer renders no
//! model chip for it. An absent control is honest; a decorative one is not.
//!
//! The two shapes a model switch comes in are a real difference between these
//! products, not an implementation detail we can paper over:
//!
//!   - `inline` — the CLI accepts the model id on the same line, so picking a
//!     row applies it in one shot and we can show the provider's real model
//!     list and mean it.
//!   - `picker` — the CLI's slash command opens its OWN interactive chooser and
//!     ignores anything after it. Listing models next to that would be a lie
//!     (clicking "Sonnet" would open a menu, not select Sonnet), so for these
//!     the chip is a single action that opens the CLI's chooser and sends the
//!     user to the terminal where the chooser actually is.

import type { ModelFamily } from "../../../lib/modelCatalog";
import { AGENT_CLI_CATALOG } from "./agentCliCatalog";

/** How a given CLI takes a model change. See the file header for why this
 *  distinction is surfaced rather than smoothed over. */
export type ModelSwitch =
  | {
      kind: "inline";
      /** Build the literal line to type. Receives the wire model id from the
       *  catalog (`CatalogModel.id`), never a display label. */
      line: (modelId: string) => string;
    }
  | {
      kind: "picker";
      /** The line that opens the CLI's own model chooser. */
      line: string;
      /** What the chip says, since there is no model list to show. */
      label: string;
    };

/** One CLI's controls, as the composer needs them. */
export type AgentCliCommands = {
  /** Registry id — matches `AgentTab.agentId` and the `aura-agents` provider. */
  agentId: string;
  /** Whose models this agent runs. Drives the provider-scoped filter: a Gemini
   *  session must never be offered an Anthropic model, because typing one into
   *  it would just be rejected. Maps onto `modelCatalog`'s families so the chip
   *  reuses the same catalog rows the native picker shows.
   *
   *  Absent for an agent that is not tied to one vendor — Cursor fronts several
   *  — which is only allowed alongside a `picker` switch, since there is no list
   *  to scope in that case: the CLI draws its own. */
  family?: ModelFamily;
  /** Absent when we could not verify how this CLI switches model — the chip is
   *  then not rendered at all. */
  model?: ModelSwitch;
  /** Drop the conversation's context. Verified per CLI; absent where unknown. */
  clear?: string;
  /** Summarise the conversation so far to reclaim context. */
  compact?: string;
  /** Show what the session has cost / consumed so far. */
  usage?: string;
  /** The CLI's own help, which is the honest escape hatch when a control we
   *  don't model is needed. */
  help?: string;
};

/** The verified table. Keyed by the registry agent id.
 *
 *  Verification notes, so the next person changing this knows what to re-check
 *  rather than trusting the comment:
 *
 *  - **claude** — `/model <id>` and the rest are the entries already shipped in
 *    `lib/slashCommands.ts` as `kind: "agent-pty"`, which have been driving the
 *    ⌘K palette against a live Claude Code REPL since that catalog landed.
 *  - **gemini** — read out of the installed CLI's own bundle. `/model` is a
 *    parent command whose `setModelCommand` is documented in the source as
 *    `Usage: /model set <model-name> [--persist]`, so the inline form is `/model
 *    set <id>`. We deliberately omit `--persist`: a model picked for one chat
 *    should not silently rewrite the user's global default. `/clear`,
 *    `/compress`, `/stats` and `/help` are built-ins in the same command table.
 *  - **kimi** — the binary's string table carries `/model` together with a
 *    worked example (`/model k3`), which is the inline form.
 *  - **codex** — the binary's slash table has `model`, `compact`, `status`,
 *    `diff`, `init`, `review`, and its own copy says "Try /model to pick a
 *    different model" / "Choose a specific model and reasoning level", i.e. a
 *    chooser. Hence `picker`. Codex has no `/clear`; a fresh conversation is a
 *    new thread, so the field is left off rather than pointed at something that
 *    would not do it.
 *
 *  - **cursor** — its command registry (`R.push({id, title, description})` in the
 *    shipped chunks) carries `model`, described as "Select model (Tab to edit)",
 *    i.e. a chooser. Hence `picker`, and hence no `family`: cursor-agent fronts
 *    several vendors at once, so scoping a list to one of them would be a lie in
 *    the other direction.
 *  - **opencode** — its TUI registers commands with the slash trigger written
 *    on them, so this is read rather than inferred: `{id:"model.choose", …,
 *    keybind:"mod+'", slash:"model"}`, whose handler shows `DialogSelectModel`.
 *    A chooser, so `picker`. `/new` is `session.new` and `/compact` is
 *    `session.compact`, both from the same scan. It declares no trigger for
 *    help or usage — `opencode stats` is a CLI command, not a slash line — so
 *    those fields stay off rather than pointing at something that isn't there.
 *
 *    And it gets NO `family`, which for OpenCode is the whole point rather than
 *    an omission. OpenCode resolves its own providers, from Models.dev plus the
 *    user's `auth.json` and `opencode.json`. Someone runs it precisely BECAUSE
 *    their plan is a custom or non-Anthropic one — a z.ai GLM subscription, a
 *    local model, a gateway of their own. Filtering our catalog to a vendor and
 *    typing an id out of it would override exactly the choice that made them
 *    pick OpenCode, and would fail on the id besides: OpenCode names models
 *    `provider/model`, not `claude-opus-5`. So the chip opens OpenCode's own
 *    dialog, which lists what THEIR install is configured for and nothing else.
 *
 *  - **pi** — its `BUILTIN_SLASH_COMMANDS` array ships readable in the package,
 *    so `/model`, `/new`, `/compact` and `/session` are read rather than
 *    inferred, with Pi's own descriptions ("Select model (opens selector UI)",
 *    "Start a new session", "Manually compact the session context", "Show
 *    session info and stats"). It declares no help command at all — `/hotkeys`
 *    lists keyboard shortcuts, which is not the same thing — so `help` is left
 *    off rather than pointed at the nearest-looking row.
 *
 *    Pi is the one CLI here that is `picker` despite genuinely accepting an
 *    inline id, and the reason is worth stating so nobody "fixes" it.
 *    `handleModelCommand` opens the selector on a bare `/model`, and on
 *    `/model <ref>` sets the model directly when the reference resolves to
 *    exactly one of the models THAT INSTALL has available. Which is precisely
 *    why we can't type at it: Pi resolves its own providers, its default
 *    provider is google, and a bare id that exists under two configured
 *    providers is ambiguous and resolves to nothing. Our catalog cannot know
 *    which providers a given Pi is authenticated against, so scoping it to one
 *    `family` would be a guess, and typing an id out of that guess would
 *    override the exact choice that made someone pick Pi. The chip opens Pi's
 *    selector, which lists what their install actually has.
 *
 *  `antigravity` is deliberately absent: its CLI asks its own server for the
 *  command set (`GetSlashCommands`), so nothing about it is knowable from the
 *  binary. It gets the chat view with no model chip rather than a control that
 *  might type nonsense. */
export const AGENT_CLI_COMMANDS: Record<string, AgentCliCommands> = {
  claude: {
    agentId: "claude",
    family: "anthropic",
    model: { kind: "inline", line: (id) => `/model ${id}` },
    clear: "/clear",
    compact: "/compact",
    usage: "/cost",
    help: "/help",
  },
  gemini: {
    agentId: "gemini",
    family: "gemini",
    model: { kind: "inline", line: (id) => `/model set ${id}` },
    clear: "/clear",
    compact: "/compress",
    usage: "/stats",
    help: "/help",
  },
  kimi: {
    agentId: "kimi",
    family: "kimi",
    model: { kind: "inline", line: (id) => `/model ${id}` },
    // Kimi calls a fresh session `/new`; `/clear` is its alias for the same
    // thing, so the chip points at the name its own menu leads with.
    clear: "/new",
    compact: "/compact",
    usage: "/usage",
    help: "/help",
  },
  codex: {
    agentId: "codex",
    family: "openai",
    model: {
      kind: "picker",
      line: "/model",
      label: "Model",
    },
    clear: "/clear",
    compact: "/compact",
    usage: "/status",
  },
  opencode: {
    agentId: "opencode",
    // No family, deliberately — see the note above. OpenCode owns provider and
    // model resolution, and our catalog must not reach into it.
    model: {
      kind: "picker",
      line: "/model",
      label: "Model",
    },
    clear: "/new",
    compact: "/compact",
  },
  pi: {
    agentId: "pi",
    // No family, and for OpenCode's reason: Pi resolves its own providers and
    // its default is google, not Anthropic. See the note above.
    model: {
      kind: "picker",
      line: "/model",
      label: "Model",
    },
    clear: "/new",
    compact: "/compact",
    usage: "/session",
  },
  cursor: {
    agentId: "cursor",
    // No family on purpose: cursor-agent fronts Anthropic, OpenAI and Google
    // models at once, so there is no single vendor list to scope to — and it
    // doesn't need one, because its `/model` draws its own picker.
    model: {
      kind: "picker",
      line: "/model",
      label: "Model",
    },
    clear: "/clear",
    compact: "/compress",
    usage: "/usage",
    help: "/help",
  },
};

/** The controls we know for this agent, or `null` when we know none. Callers
 *  render nothing rather than a disabled chip — a control that is present but
 *  dead reads as a bug, whereas its absence reads as "this CLI doesn't do
 *  that", which is the truth. */
export function commandsForAgent(agentId: string): AgentCliCommands | null {
  return AGENT_CLI_COMMANDS[agentId] ?? null;
}

/** The vendor family whose models this agent can actually run. `null` for an
 *  agent we have no entry for, which is the signal to show no model chip.
 *
 *  This is the whole of "model switching is scoped to that agent's provider":
 *  the composer asks this, then filters the shared catalog to that one family,
 *  so a Gemini session lists Gemini models and nothing else. */
export function modelFamilyForAgent(agentId: string): ModelFamily | null {
  return AGENT_CLI_COMMANDS[agentId]?.family ?? null;
}

/** The exact line to type into this agent's PTY to move it onto `modelId`, or
 *  `null` when this CLI takes a chooser instead of an id (or is unknown).
 *
 *  Returning null for the picker case is deliberate: the caller must not
 *  silently fall back to some other syntax, it must switch to the "open their
 *  chooser" affordance, because there is no line that would work. */
export function modelSwitchLine(agentId: string, modelId: string): string | null {
  const cmd = AGENT_CLI_COMMANDS[agentId]?.model;
  if (!cmd || cmd.kind !== "inline") return null;
  return cmd.line(modelId);
}

/** One row of a CLI's own `/` menu. `name` is the bare verb (no slash) because
 *  that is what the composer's command chip carries; `args` is the rest of the
 *  usage line, shown as a hint so the user knows what to type after picking. */
export type AgentSlashRow = {
  name: string;
  summary: string;
  args?: string;
};

/** The `/` menu for a CLI agent's composer.
 *
 *  The brain's composer fills this menu with Aura's own verbs — `/prove`,
 *  `/impacts`, `/rewind` — and that is right there, because the app intercepts
 *  them after you hit send. The agent chat does no such interception: what you
 *  type goes into a live REPL byte for byte. So the menu has to be that CLI's
 *  vocabulary, or every row is an "unknown command" waiting to happen.
 *
 *  Rows are that CLI's WHOLE published command set, read out of the installed
 *  product and kept in `agentCliCatalog` — not a curated few. A menu that shows
 *  five of a hundred commands is its own kind of wrong: it teaches the user that
 *  the chat can't do what the terminal can, and sends them back to the terminal
 *  for the other ninety-five. The five controls the chips expose are shortcuts
 *  to rows that are all in here anyway.
 *
 *  An agent whose set we could not read gets no menu — the popup simply never
 *  opens and `/` stays ordinary text, which is correct for a CLI whose commands
 *  we have not confirmed. */
export function agentSlashRows(agentId: string, query: string): AgentSlashRow[] {
  const catalog = AGENT_CLI_CATALOG[agentId];
  if (!catalog) return [];
  const q = query.toLowerCase();
  return q
    ? catalog.filter((r) => r.name.toLowerCase().startsWith(q))
    : [...catalog];
}
