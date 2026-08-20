// What the permission card is allowed to say, and what it must never offer.
//
// Two different questions arrive through the same pipe. A tool call asks
// "may this run" — the answer is about a kind of call, so a standing yes is
// a real preference. A capability asks "is this act one you want at all" —
// the answer is about one specific symbol, one teammate's file, one piece of
// work, and a standing yes to that would be a lie about what the gate does.
//
// The Rust side refuses to remember a capability answer. These tests pin the
// UI to the same promise, because the expensive failure here is silent: a
// button that reads "always" and quietly means "once" teaches people the gate
// is noise, and then the prompt that matters gets clicked through too.

import { describe, expect, test } from "bun:test";

import { describeToolCall } from "./toolCall";

describe("a capability prompt", () => {
  test("never offers to remember the answer", () => {
    for (const capability of [
      "delete_exported_symbol",
      "write_outside_claimed_zone",
      "dispatch_to_machine",
    ]) {
      const facet = describeToolCall(`${capability}:something`, {
        capability,
        act: "do the thing",
        detail: "src/auth.rs removes parse_token",
      });
      expect(facet.alwaysAllowable).toBe(false);
    }
  });

  test("is built from the input, not the unreadable tool name", () => {
    // `tool_name` is deliberately act-specific so a remembered "always"
    // could never match a later, different act — which makes it useless as
    // a headline. The card must not fall through to "Use <tool_name>".
    const facet = describeToolCall(
      "delete_exported_symbol:src/auth.rs removes parse_token",
      {
        capability: "delete_exported_symbol",
        act: "delete an exported symbol",
        detail: "src/auth.rs removes parse_token",
      },
    );
    expect(facet.title).not.toContain("delete_exported_symbol");
    expect(facet.kind).toBe("changes");
    expect(facet.detail?.value).toBe("src/auth.rs removes parse_token");
    // Not monospaced: this is a sentence about a symbol, not a command.
    expect(facet.detail?.mono).toBe(false);
  });

  test("says what it means in words a non-engineer can answer", () => {
    const facet = describeToolCall("dispatch_to_machine:ship the release", {
      capability: "dispatch_to_machine",
      act: "send work to another machine",
      detail: "ship the release",
    });
    // The fear this question has to answer is "what does it cost me if I
    // say yes and walk away", so the body has to reach unattended running.
    expect(facet.body.toLowerCase()).toContain("unattended");
    expect(facet.kind).toBe("network");
  });

  test("a capability we don't recognise is not silently dressed up as one", () => {
    // A capability added in Rust without a line here must fall through to
    // the honest unknown-tool card rather than borrow another one's words.
    const facet = describeToolCall("spend_money:12 dollars", {
      capability: "spend_money",
      detail: "12 dollars",
    });
    expect(facet.alwaysAllowable).toBeUndefined();
    expect(facet.title).toContain("spend_money");
  });
});

describe("an ordinary tool call", () => {
  test("still offers to remember the answer", () => {
    // The absence matters: `alwaysAllowable` is opt-out, so a tool that
    // never mentions it keeps the button. Pin that, or a stray default
    // would strip the button from every card at once.
    expect(describeToolCall("Read", { file_path: "/tmp/a" }).alwaysAllowable).toBeUndefined();
    expect(describeToolCall("Bash", { command: "ls" }).alwaysAllowable).toBeUndefined();
  });

  test("shows the command verbatim, because that is what is being agreed to", () => {
    const facet = describeToolCall("Bash", { command: "rm -rf build/" });
    expect(facet.detail?.value).toBe("rm -rf build/");
    expect(facet.detail?.mono).toBe(true);
    expect(facet.kind).toBe("runs");
  });
});
