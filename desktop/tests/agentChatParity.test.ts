// Every terminal agent gets the chat view, not just Claude.
//
// The Chat toggle used to be gated on `canNormalize(tab.agentId)` — on the
// agent having a wired protocol adapter under `lib/agentProtocol/adapters/`,
// which is Claude and nobody else. So the answer to "how good is the chat view
// for a Gemini or Codex session" was: there isn't one. No toggle, no
// transcript, terminal or nothing, while the brain one tab over had a rich
// composer with mentions, slash chips, a model picker, drafts and recall.
//
// The gate was reasoning about the wrong thing. An adapter decides how RICH the
// transcript is — tool cards and result footers versus plain exchanges — not
// whether there is anything to render: the PTY layer frames EVERY session into
// (prompt, output) block pairs with the ANSI already stripped, whatever
// protocol the child speaks. These tests pin the three things that make the
// difference real, because each of them silently degrades to the old behaviour
// if someone "tidies" it:
//
//   1. the surface offers Chat for any live agent, and the transcript falls
//      back to blocks instead of rendering an empty pane;
//   2. the composer is the SAME editor the brain mounts, wired to the PTY —
//      not a second, poorer one that drifts;
//   3. the controls type that CLI's own commands. This is the one that can go
//      wrong quietly: a slash chip serializes back to literal `/name` text, so
//      the brain's verb menu inside an agent chat would send `/prove` to a
//      binary that has never heard of it, and a model row from the wrong
//      vendor is just an error message with extra steps.

import { describe, expect, it } from "bun:test";

import type { BlockEnvelope } from "../src/lib/api";
import { foldExchanges, tidyOutput } from "../src/components/agent/chat/AgentBlockTranscript";
import {
  agentSlashRows,
  modelSwitchLine,
  modelFamilyForAgent,
} from "../src/components/agent/chat/agentCliCommands";
import { readSrc } from "./support/code";

const surface = await readSrc("components/agent/AgentSurface.tsx");
const transcript = await readSrc("components/agent/normalized/NormalizedTranscript.tsx");
const composer = await readSrc("components/agent/chat/AgentChatComposer.tsx");
const blocks = await readSrc("components/agent/chat/AgentBlockTranscript.tsx");
const tiptap = await readSrc("components/manager/TiptapComposer.tsx");
const manager = await readSrc("components/manager/ManagerComposer.tsx");

function block(kind: BlockEnvelope["kind"], id: string, text: string, exit?: number): BlockEnvelope {
  return {
    id,
    kind,
    session_id: "s",
    agent_id: "gemini",
    started_at: 0,
    finished_at: null,
    text,
    exit_code: exit ?? null,
  };
}

describe("the chat view a non-Claude agent gets", () => {
  it("is offered for every live agent, with no adapter gate left", () => {
    expect(surface).not.toContain("canNormalize");
    // The one remaining condition is the paused pane, whose Start button the
    // toggle used to paint over.
    expect(surface).toContain("{!paused && (");
  });

  it("falls back to the PTY blocks when there is nothing structured to draw", () => {
    // `normalizeStream` returns null — not [] — for an unparsed engine, which
    // is the difference between "structured, nothing yet" and "we don't parse
    // this". Collapsing the two is what would re-hide the view.
    //
    // Codex and Kimi add a second way to have nothing yet: they don't stream
    // their structure over the PTY, they write a file that lands a beat after
    // the session starts. An empty chat in that gap reads as broken, so the
    // blocks hold the screen until the first record arrives. The condition is
    // asked of the RECORD, not of a hardcoded agent id — that list only ever
    // grows, and the next engine to keep a record would silently render an
    // empty pane if it had to be added here too.
    expect(transcript).toContain(
      "normalized != null && (!record.supported || record.records.length > 0)",
    );
    expect(transcript).not.toContain('agentId === "codex"');
    expect(transcript).toMatch(/: !structured \? \(\s*<AgentBlockTranscript/);
    expect(transcript).toContain("const hasContent = structured ? groups.length > 0 : blocks.length > 0;");
  });

  it("mounts the composer for both kinds of transcript, not just the rich one", () => {
    // The composer sits outside the structured/fallback branch entirely.
    expect(transcript).toMatch(/<\/div>\s*<AgentChatComposer/);
  });
});

describe("folding PTY blocks into a conversation", () => {
  it("pairs each prompt with the output it opened", () => {
    const rows = foldExchanges([
      block("prompt", "p1", "list the files"),
      block("output", "o1", "src/ tests/"),
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].prompt?.text).toBe("list the files");
    expect(rows[0].output?.text).toBe("src/ tests/");
  });

  it("keeps an output with no prompt before it", () => {
    // That is the agent's own welcome banner. Dropping it would silently lose
    // the first thing the user ever sees in the pane.
    const rows = foldExchanges([block("output", "o1", "Gemini CLI v1")]);
    expect(rows.length).toBe(1);
    expect(rows[0].prompt).toBeNull();
    expect(rows[0].output?.text).toBe("Gemini CLI v1");
  });

  it("merges an exit onto the output it terminated", () => {
    const rows = foldExchanges([
      block("prompt", "p1", "run the build"),
      block("output", "o1", "error: no such target"),
      block("exit", "e1", "", 1),
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].exit?.exit_code).toBe(1);
  });

  it("starts a new row rather than concatenating two outputs under one prompt", () => {
    const rows = foldExchanges([
      block("prompt", "p1", "one"),
      block("output", "o1", "first"),
      block("output", "o2", "second"),
    ]);
    expect(rows.length).toBe(2);
    expect(rows[1].output?.text).toBe("second");
  });
});

describe("tidying a TUI's output", () => {
  it("drops repaint padding without dropping content", () => {
    const out = tidyOutput("done   \n\n\n\n  next  \n");
    expect(out).toBe("done\n\n  next");
  });

  it("never deletes a line that has words on it", () => {
    // A tidier clever enough to strip box drawing is a tidier that eventually
    // eats an answer. Anything with content survives verbatim.
    const src = "│ result │\n└────────┘";
    expect(tidyOutput(src)).toBe(src);
  });
});

describe("the commands the composer can type", () => {
  it("offers a CLI its own verbs and none of Aura's", () => {
    const names = agentSlashRows("gemini", "").map((r) => r.name);
    expect(names).toContain("model");
    expect(names).toContain("compress");
    expect(names).toContain("stats");
    // The brain's verbs are dispatched by the app; typed into a REPL they are
    // unknown commands.
    expect(names).not.toContain("prove");
    expect(names).not.toContain("impacts");
  });

  it("offers the WHOLE published set, not the handful the chips use", () => {
    // A menu of five, next to a terminal that answers a hundred, teaches the
    // user that the chat is the lesser surface. Each of these is a real command
    // that the chip row does not expose.
    for (const [agent, name] of [
      ["claude", "rewind"],
      ["claude", "permissions"],
      ["gemini", "restore"],
      ["gemini", "extensions"],
      ["codex", "diff"],
      ["cursor", "shell"],
      ["kimi", "swarm"],
    ] as const) {
      expect(agentSlashRows(agent, "").map((r) => r.name)).toContain(name);
    }
    // And the sets are genuinely large, not five rows with long names.
    for (const agent of ["claude", "gemini", "codex", "cursor", "kimi"]) {
      expect(agentSlashRows(agent, "").length).toBeGreaterThan(25);
    }
  });

  it("carries the sub-verb as a hint instead of dropping it", () => {
    // Gemini's usage is `/model set <model-name>`, and a command chip only ever
    // holds the leading verb.
    const row = agentSlashRows("gemini", "model")[0];
    expect(row.name).toBe("model");
    expect(row.args).toBe("set <model>");
  });

  it("gives a CLI we could not read no menu at all", () => {
    // Antigravity fetches its commands from its own server (`GetSlashCommands`
    // in the binary), so its set is only knowable at runtime. Better `/` stays
    // ordinary text than a menu of guesses.
    expect(agentSlashRows("antigravity", "")).toEqual([]);
  });

  it("gives one we CAN read its own set, not a guess and not silence", () => {
    // OpenCode was on the line above until we could read it. It registers each
    // command as an object carrying its own trigger inline
    // (`{id:"model.choose", …, slash:"model"}`), so its rows are scanned out of
    // the bundle exhaustively — thirteen triggers, with OpenCode's own English
    // summaries from its i18n table. Nothing here is inferred, which is why it
    // moved off the no-menu list and why the count is asserted: a fourteenth
    // row would mean someone added one we didn't read.
    const rows = agentSlashRows("opencode", "");
    expect(rows.length).toBe(13);
    for (const name of ["model", "new", "compact", "share", "undo"]) {
      expect(rows.map((r) => r.name)).toContain(name);
    }
  });

  it("filters by what has been typed", () => {
    const names = agentSlashRows("claude", "co").map((r) => r.name);
    expect(names).toContain("compact");
    expect(names).toContain("cost");
    expect(names).not.toContain("model");
  });

  it("never carries a leading slash on a row name", () => {
    // The command chip renders `/${name}`, so a stored "/model" would insert
    // `//model` and fail on every CLI.
    for (const agent of ["claude", "gemini", "codex", "cursor", "kimi"]) {
      for (const row of agentSlashRows(agent, "")) {
        expect(row.name.startsWith("/")).toBe(false);
        expect(row.summary.length).toBeGreaterThan(3);
      }
    }
  });
});

describe("switching model inside the agent's own provider", () => {
  it("writes that CLI's line, with its own syntax", () => {
    expect(modelSwitchLine("gemini", "gemini-2.5-pro")).toBe("/model set gemini-2.5-pro");
    expect(modelSwitchLine("claude", "opus")).toBe("/model opus");
  });

  it("refuses to invent a line for a CLI that only opens a chooser", () => {
    // Codex's and Cursor's `/model` ignore anything after them. A caller must
    // fall through to the open-their-chooser affordance, so null is the
    // contract, not a guess.
    expect(modelSwitchLine("codex", "gpt-5")).toBeNull();
    expect(modelSwitchLine("cursor", "anything")).toBeNull();
  });

  it("scopes the list to the vendor the agent actually runs", () => {
    expect(modelFamilyForAgent("gemini")).toBe("gemini");
    expect(modelFamilyForAgent("codex")).toBe("openai");
    expect(modelFamilyForAgent("claude")).toBe("anthropic");
    // Cursor fronts several vendors, so there is no single family to scope to —
    // and it needs none, because its switch opens the CLI's own picker.
    expect(modelFamilyForAgent("cursor")).toBeNull();
  });

  it("asks the shared catalog rather than keeping a second model list", () => {
    expect(composer).toContain("catalogFor(brain, live)");
    expect(composer).toContain('id: `cli_wrapper:${agentId}`');
  });
});

describe("one composer, not two", () => {
  it("mounts the brain's editor instead of a second implementation", () => {
    expect(composer).toContain("<TiptapComposer");
    expect(composer).not.toContain("<textarea");
  });

  it("lets a host own the slash menu, and defaults to the brain's", () => {
    expect(tiptap).toContain("if (slashRows) return slashRows(q);");
    expect(composer).toContain("slashRows={slashRows}");
  });

  it("shares the draft and recall rules with the brain rather than re-deriving them", () => {
    // Both import the one module; only the depth of the relative path differs.
    for (const src of [composer, manager]) {
      expect(src).toMatch(/from "\.\.\/(\.\.\/)?composer\/composerDrafts"/);
      expect(src).toContain("readHistory");
      expect(src).toContain("pushHistory");
    }
  });

  it("stops a turn with Escape, which the REPL survives", () => {
    // Ctrl-C (0x03) quits the whole CLI and takes the conversation with it.
    expect(composer).toContain("const ESC_BYTE = 0x1b;");
    expect(composer).not.toContain("0x03");
  });

  it("stays typable mid-turn, because the CLI's own input queue is the queue", () => {
    expect(composer).toContain("busy={false}");
  });
});

describe("nothing in the chat pushes the pane sideways", () => {
  it("lets a long unbroken token break inside the user bubble", () => {
    // `whitespace-pre-wrap` preserves the newlines a prompt was typed with, but
    // it gives an absolute path, a URL or a sha no break opportunity at all —
    // one of those stretches the bubble past the column and the pane grows a
    // horizontal scrollbar. Both transcripts draw that bubble.
    for (const src of [transcript, blocks]) {
      expect(src).toContain("whitespace-pre-wrap break-words");
      expect(src).not.toMatch(/whitespace-pre-wrap"/);
    }
  });

  it("wraps terminal output instead of letting it scroll the pane", () => {
    expect(blocks).toContain("whitespace-pre-wrap break-words font-mono");
  });

  it("scrolls a long command menu inside its own box", () => {
    // The menu is one row per command and some CLIs ship a hundred; it has to
    // scroll itself, and its summaries have to truncate rather than widen it.
    expect(composer).toContain("max-h-[340px] overflow-y-auto");
    expect(composer).toContain("flex-1 min-w-0 truncate");
  });
});
