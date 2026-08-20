// Turn a raw tool call into something a person who doesn't write code can
// answer honestly.
//
// The prompt arrives as `{ tool_name: "Bash", input: { command: "rm -rf …" } }`
// — which is precise and completely useless as a question. "Bash wants
// permission" tells you nothing about what will happen to your computer.
//
// So each tool gets: a sentence saying what it is about to do, one plain
// line about what that means for you, and the exact thing it will act on,
// verbatim and unedited. The verbatim part matters most — the sentence is
// our summary and could be wrong about intent, but the command or the path
// is the ground truth, and it is what you are actually agreeing to.
//
// What this deliberately does NOT do is grade the call. We don't know
// whether a given command is dangerous, and a confident "looks safe" on
// something we never checked is worse than no label at all. `kind` says
// what category of thing the tool does — reads, writes, runs, reaches the
// network — which is a fact about the tool, not a guess about the call.

/** What category of thing this tool does. A fact about the tool itself. */
import { titleCaseName } from "../../../lib/textCase";

export type ToolKind =
  | "reads"
  | "changes"
  | "runs"
  | "network"
  | "connection"
  | "other";

export type ToolFacet = {
  /** Sentence-case headline: what the agent is about to do. */
  title: string;
  /** One plain line for a non-engineer — what it means, and what to watch. */
  body: string;
  /** The exact thing it will act on. Shown verbatim; never summarized. */
  detail?: { label: string; value: string; mono: boolean };
  kind: ToolKind;
  /**
   * Whether "always allow" is a coherent answer here.
   *
   * For a tool it is: the question is about a *kind* of call, and a
   * standing yes to `Read` is a real preference. For a capability it is
   * not — the question is about one specific act, and "yes, delete
   * `parse_token`" must never become "yes, delete anything". Aura's gate
   * refuses to remember those, so the button would be a lie.
   */
  alwaysAllowable?: boolean;
};

/** Short label for the header chip. */
export const KIND_LABEL: Record<ToolKind, string> = {
  reads: "Reads",
  changes: "Changes a file",
  runs: "Runs a command",
  network: "Goes online",
  connection: "Uses a connection",
  other: "Permission",
};

function str(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v : null;
}

function lineCount(s: string): number {
  return s ? s.split("\n").length : 0;
}

/** Pretty-print an unrecognised input so it is at least readable. Capped —
 *  a card is not a JSON viewer, and an agent can pass a lot. */
function prettyInput(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  let text: string;
  try {
    text = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  } catch {
    return null;
  }
  if (!text || text === "{}" || text === "null") return null;
  const MAX = 1200;
  return text.length > MAX ? text.slice(0, MAX) + "\n… (shortened)" : text;
}

/** Split `mcp__linear__create_issue` into its server and tool halves. */
function mcpParts(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const cut = rest.indexOf("__");
  if (cut <= 0) return { server: titleCaseName(rest), tool: "" };
  return {
    server: titleCaseName(rest.slice(0, cut)),
    tool: rest.slice(cut + 2).replace(/_/g, " "),
  };
}

/// A capability prompt from Aura's own authority layer, rather than a tool
/// call from the agent.
///
/// These arrive with `tool_name` of `<capability>:<the specific act>` —
/// specific on purpose, so a remembered "always" can never match a later,
/// different act. That makes the name unreadable, so the card is built from
/// the `input` instead, which carries the capability, a plain-language verb
/// and the detail.
///
/// Worth a case of its own because the question is a different *kind* of
/// question. A tool prompt asks "may this run"; this asks "is this act one
/// you want at all", and the honest answer depends on the detail, not the
/// tool.
const CAPABILITY_FACET: Record<string, { title: string; body: string; kind: ToolKind }> = {
  delete_exported_symbol: {
    title: "Delete something other code may be calling",
    body: "This removes a function or type that the rest of your project can use by name. If anything else calls it, that code stops working. Aura spotted it by reading what the file says now against what it would say after.",
    kind: "changes",
  },
  write_outside_claimed_zone: {
    title: "Edit a file someone else is holding",
    body: "A teammate claimed this area of the project so their work wouldn't be overwritten. Editing it anyway is allowed — but talk to them first, because one of you will lose changes.",
    kind: "changes",
  },
  dispatch_to_machine: {
    title: "Send this work to another machine",
    body: "It leaves your computer and runs on its own, unattended, spending whatever it needs to finish. You can stop it afterwards, but not un-run it.",
    kind: "network",
  },
};

export function describeToolCall(toolName: string, input: unknown): ToolFacet {
  const capability = str(input, "capability");
  if (capability && CAPABILITY_FACET[capability]) {
    const facet = CAPABILITY_FACET[capability];
    const detail = str(input, "detail");
    return {
      ...facet,
      detail: detail ? { label: "What exactly", value: detail, mono: false } : undefined,
      alwaysAllowable: false,
    };
  }

  switch (toolName) {
    case "Bash":
    case "BashOutput": {
      const command = str(input, "command");
      return {
        title: "Run a command on your computer",
        body: "A command runs with the same access you have. It isn't limited to this project. Read it before you allow it.",
        detail: command
          ? { label: "Command", value: command, mono: true }
          : undefined,
        kind: "runs",
      };
    }

    case "Read": {
      const path = str(input, "file_path");
      return {
        title: "Read a file",
        body: "Nothing is changed. It only looks at what's inside so it can work with it.",
        detail: path ? { label: "File", value: path, mono: true } : undefined,
        kind: "reads",
      };
    }

    case "Write": {
      const path = str(input, "file_path");
      const content = str(input, "content");
      const lines = content ? lineCount(content) : 0;
      return {
        title: "Write a whole file",
        body: lines
          ? `It will put ${lines} ${lines === 1 ? "line" : "lines"} into this file. Anything already in there is replaced.`
          : "Anything already in this file is replaced by what the agent writes.",
        detail: path ? { label: "File", value: path, mono: true } : undefined,
        kind: "changes",
      };
    }

    case "Edit":
    case "MultiEdit": {
      const path = str(input, "file_path");
      return {
        title: "Change part of a file",
        body: "It replaces a specific piece of this file and leaves the rest alone. You can undo it afterwards from the History panel.",
        detail: path ? { label: "File", value: path, mono: true } : undefined,
        kind: "changes",
      };
    }

    case "NotebookEdit": {
      const path = str(input, "notebook_path") ?? str(input, "file_path");
      return {
        title: "Change a notebook",
        body: "It edits one cell of this notebook and leaves the rest alone.",
        detail: path ? { label: "Notebook", value: path, mono: true } : undefined,
        kind: "changes",
      };
    }

    case "Glob": {
      const pattern = str(input, "pattern");
      return {
        title: "Look for files by name",
        body: "Nothing is opened or changed. It's finding which files exist.",
        detail: pattern
          ? { label: "Looking for", value: pattern, mono: true }
          : undefined,
        kind: "reads",
      };
    }

    case "Grep": {
      const pattern = str(input, "pattern");
      return {
        title: "Search inside your files",
        body: "Nothing is changed. It's searching the text of your project for something.",
        detail: pattern
          ? { label: "Searching for", value: pattern, mono: true }
          : undefined,
        kind: "reads",
      };
    }

    case "WebFetch": {
      const url = str(input, "url");
      return {
        title: "Open a page on the internet",
        body: "This leaves your computer. The address is sent out and whatever comes back is read into the conversation.",
        detail: url ? { label: "Address", value: url, mono: true } : undefined,
        kind: "network",
      };
    }

    case "WebSearch": {
      const query = str(input, "query");
      return {
        title: "Search the web",
        body: "This leaves your computer. The search words are sent to a search engine.",
        detail: query
          ? { label: "Searching for", value: query, mono: false }
          : undefined,
        kind: "network",
      };
    }

    case "Task":
    case "Agent": {
      const desc = str(input, "description") ?? str(input, "prompt");
      return {
        title: "Start a second agent to help",
        body: "It hands part of the job to another agent, which works on its own and reports back. That agent will ask you for permission too.",
        detail: desc ? { label: "To do", value: desc, mono: false } : undefined,
        kind: "other",
      };
    }

    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return {
        title: "Update its own to-do list",
        body: "This only affects the checklist the agent keeps for itself. Nothing in your project changes.",
        kind: "other",
      };

    case "KillShell":
      return {
        title: "Stop a command it started",
        body: "It ends something it was already running. Nothing else is touched.",
        kind: "other",
      };

    default: {
      const mcp = mcpParts(toolName);
      if (mcp) {
        const pretty = prettyInput(input);
        return {
          title: mcp.server
            ? `Use your ${mcp.server} connection`
            : "Use one of your connections",
          // The action name comes straight off the tool, so it can be any
          // shape of phrase — quote it rather than trying to bend it into a
          // sentence, which is how you end up with "It wants to create issue".
          body: `${mcp.tool ? `The action is “${mcp.tool}”. ` : ""}This happens inside a tool you connected to Aura, not on your computer, so it can change things there.`,
          detail: pretty
            ? { label: "Details", value: pretty, mono: true }
            : undefined,
          kind: "connection",
        };
      }
      const pretty = prettyInput(input);
      return {
        title: `Use ${toolName}`,
        body: "Aura doesn't recognise this one, so it can't say in plain words what it does. What it was given is below, exactly as sent.",
        detail: pretty
          ? { label: "Details", value: pretty, mono: true }
          : undefined,
        kind: "other",
      };
    }
  }
}
