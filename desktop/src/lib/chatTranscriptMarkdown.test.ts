import { describe, expect, test } from "bun:test";
import type { ChatTurn } from "./api";
import {
  chatTranscriptMarkdown,
  chatTranscriptText,
  copiedTranscriptMessage,
  transcriptFileName,
} from "./chatTranscriptMarkdown";

describe("chat transcript as Markdown", () => {
  test("names the file after the chat, without path characters", () => {
    expect(transcriptFileName("Fix the login")).toBe("Transcript of Fix the login.md");
    expect(transcriptFileName("a/b: c?")).toBe("Transcript of a b c.md");
    expect(transcriptFileName("  ")).toBe("Transcript of chat.md");
  });

  test("writes each turn under who said it and skips empty turns", () => {
    const md = chatTranscriptMarkdown("Fix the login", [
      { role: "user", text: "Why does sign-in fail?", at: 1 },
      { role: "manager", text: "  ", at: 2 },
      { role: "manager", text: "The token expires early.", at: 3 },
    ]);
    expect(md).toBe(
      "# Fix the login\n\n## User\n\nWhy does sign-in fail?\n\n## Assistant\n\nThe token expires early.\n",
    );
  });

  test("a chat with no messages has no transcript", () => {
    expect(chatTranscriptMarkdown("Empty", [])).toBeNull();
  });
});

describe("chat transcript a tab copies", () => {
  const turns: ChatTurn[] = [
    { role: "user", text: "Why does sign-in fail?", at: 1 },
    {
      role: "manager",
      text: "The token expires early.",
      at: 2,
      tool_calls: [
        {
          tool_use_id: "a",
          name: "Read",
          input: { file_path: "src/auth.ts" },
          result: { is_error: false, content: "export const TTL = 5;" },
        },
        { tool_use_id: "b", name: "Bash", input: { command: "bun test" }, result: null },
      ],
    },
    { role: "system", text: "Loop paused", at: 3 },
    { role: "user", text: "Fix it", at: 4 },
  ];

  test("concise keeps what was said and counts the calls", () => {
    expect(chatTranscriptText(turns, "concise")).toBe(
      "## User\n\nWhy does sign-in fail?\n\n" +
        "## Assistant\n\n[2 tool calls elided]\n\nThe token expires early.\n\n[System: Loop paused]\n\n" +
        "## User\n\nFix it",
    );
  });

  test("complete writes each call with its input and result", () => {
    expect(chatTranscriptText(turns, "complete")).toBe(
      "## User\n\nWhy does sign-in fail?\n\n" +
        "## Assistant\n\n    Read: src/auth.ts\n    ↳ export const TTL = 5;\n\n    Bash: bun test\n\n" +
        "The token expires early.\n\n[System: Loop paused]\n\n" +
        "## User\n\nFix it",
    );
  });

  test("a long input or result is shortened and says by how much", () => {
    const long = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n");
    const text = chatTranscriptText(
      [
        {
          role: "manager",
          text: "",
          at: 1,
          tool_calls: [
            {
              tool_use_id: "a",
              name: "Write",
              input: { content: "x".repeat(90) },
              result: { is_error: false, content: long },
            },
          ],
        },
      ],
      "complete",
    );
    const lines = (text ?? "").split("\n");
    expect(lines[2]).toBe("    Write:");
    expect(lines[3]).toBe(`        {"content":"${"x".repeat(90)}"}`);
    expect(lines[4]).toBe("    ↳ line 1");
    expect(lines[13]).toBe("      line 10");
    expect(lines.slice(14)).toEqual(["      …", "      (4 more lines)"]);
  });

  test("a conversation that said nothing has nothing to copy", () => {
    expect(chatTranscriptText([{ role: "manager", text: " ", at: 1 }], "concise")).toBeNull();
  });

  test("the toast names the chat, cut to twenty characters", () => {
    expect(copiedTranscriptMessage("concise", "Fix the login")).toBe(
      'Copied concise transcript of "Fix the login"',
    );
    expect(copiedTranscriptMessage("complete", "Investigate the bug in checkout")).toBe(
      'Copied complete transcript of "Investigate the bug..."',
    );
    expect(copiedTranscriptMessage("concise", " ")).toBe('Copied concise transcript of "chat"');
  });
});
