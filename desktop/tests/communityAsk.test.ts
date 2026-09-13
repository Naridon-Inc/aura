// Aura asks for a star. These tests are the guardrail on how.
//
// An ask like this goes wrong in two directions, and both are one careless
// edit away:
//
//   1. It becomes nagware — a second surface starts asking, or a surface that
//      was supposed to fire once starts firing on a timer or a launch count.
//   2. It ships a dead link — someone adds a Discord row before there is a
//      Discord, and every new user's first click 404s.
//
// So: the URLs live in exactly one module, no surface may hardcode one, the
// earned nudge is spent by the same call that raises it, and the chat link
// falls back to something that actually exists until an invite is filled in.

import { describe, expect, test } from "bun:test";
import { readSrc } from "./support/code";
import {
  DISCORD_INVITE_URL,
  chatLink,
  starLink,
} from "../src/lib/community";

const community = await readSrc("lib/community.ts");
const screen = await readSrc("components/onboarding/SupportAuraScreen.tsx");
const flow = await readSrc("components/onboarding/OnboardingFlow.tsx");
const settings = await readSrc("components/dialogs/SettingsDialog.tsx");
const stream = await readSrc("lib/agentStreamStore.ts");

describe("no surface can ship a dead link", () => {
  test("every community link has a real URL", () => {
    for (const link of [starLink(), chatLink()]) {
      expect(link.url).toMatch(/^https:\/\/\S+$/);
      expect(link.url).not.toContain("undefined");
    }
  });

  test("the chat link falls back to Discussions until there is an invite", () => {
    if (DISCORD_INVITE_URL) {
      expect(chatLink().url).toBe(DISCORD_INVITE_URL);
      expect(chatLink().label).toContain("Discord");
    } else {
      expect(chatLink().url).toContain("/discussions");
      expect(chatLink().label).not.toContain("Discord");
    }
  });

  test("the invite is a real Discord URL, or empty — never a placeholder", () => {
    if (DISCORD_INVITE_URL) {
      expect(DISCORD_INVITE_URL).toMatch(
        /^https:\/\/discord\.(gg|com)\/[A-Za-z0-9/_-]+$/,
      );
    }
  });
});

describe("one place owns the links", () => {
  test("the first-run screen asks community for them", () => {
    expect(screen).toContain("lib/community");
    expect(screen).toContain("starLink()");
    expect(screen).toContain("chatLink()");
  });

  test("Settings reads the same two helpers", () => {
    expect(settings).toContain("starLink()");
    expect(settings).toContain("chatLink()");
  });

  test("no surface hardcodes a discord.gg link of its own", () => {
    for (const src of [screen, flow, settings, stream]) {
      expect(src).not.toContain("discord.gg");
      expect(src).not.toContain("discord.com/invite");
    }
  });
});

describe("it asks at most twice, ever", () => {
  test("first run shows the screen once and stamps it, act or skip", () => {
    expect(flow).toContain("shouldGreet(noteAppOpened())");
    expect(flow).toContain("markGreeted()");
  });

  test("the earned nudge is spent by the same call that raises it", () => {
    // markAsked() before askForSupport(), inside noteTurnFinished — so a crash
    // in the toast layer cannot leave the ask armed for the next turn.
    const body = community.slice(community.indexOf("export function noteTurnFinished"));
    expect(body.indexOf("markAsked()")).toBeGreaterThan(-1);
    expect(body.indexOf("markAsked()")).toBeLessThan(body.indexOf("askForSupport()"));
  });

  test("the nudge rides finished turns, not launches or a timer", () => {
    expect(stream).toContain("noteTurnFinished()");
    expect(community).not.toContain("setInterval");
    expect(community).not.toContain("setTimeout");
  });

  test("the ledger is durable, not an evictable cache", () => {
    expect(community).toContain("setDurable");
    expect(community).not.toContain("setCache");
  });
});

describe("the first-run screen stays skippable", () => {
  test("it offers a way out that needs no clicks on either link", () => {
    expect(screen).toContain("Maybe later");
  });

  test("it promises not to come back, and Settings keeps that promise", () => {
    expect(screen).toContain("never asks for this again");
    expect(settings).toContain("HELP_LINKS");
  });
});
