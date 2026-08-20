// No surface prints a device key where a person's address goes.
//
//   bun test
//
// When someone opens the project and hasn't signed in, the presence beacon
// carries a name and a device id but no address, so the manifest merge mints
// `device:<uuid>@presence.local` to keep that person on their own row. It is a
// join key, and it was reaching the screen — under "2 members · 1 admin", in
// Settings, a row read:
//
//     aura-user
//     device:09fdeeb1-fc6b-41fd-9a17-712150498088@presence.local
//
// which reads as a system account or a bug, not as "we don't know who this is
// yet". The key stays the key; the line says the true thing in words.

import { describe, expect, test } from "bun:test";

import { isDeviceIdentity, memberIdentityLine } from "../src/lib/memberIdentity";
import { readSrc } from "./support/code";

describe("a member row with no address says so in words", () => {
  test("a minted device key is recognised, a real address is not", () => {
    expect(
      isDeviceIdentity("device:09fdeeb1-fc6b-41fd-9a17-712150498088@presence.local"),
    ).toBe(true);
    // Case and stray whitespace come from whatever wrote the manifest.
    expect(isDeviceIdentity("  DEVICE:ABC@Presence.Local  ")).toBe(true);
    expect(isDeviceIdentity("ashiq@example.com")).toBe(false);
    // A github noreply address is odd-looking but it IS the person's address —
    // it belongs on the row untouched.
    expect(isDeviceIdentity("1234+mo@users.noreply.github.com")).toBe(false);
    expect(isDeviceIdentity(null)).toBe(false);
    expect(isDeviceIdentity(undefined)).toBe(false);
    expect(isDeviceIdentity("")).toBe(false);
  });

  test("the line is prose for a device, and the address otherwise", () => {
    expect(memberIdentityLine("device:abc@presence.local")).toBe(
      "Not signed in yet — seen on a device",
    );
    expect(memberIdentityLine("ashiq@example.com")).toBe("ashiq@example.com");
    // Nothing at all is still nothing — an empty second line is honest, and
    // the row already carries the name.
    expect(memberIdentityLine(null)).toBe("");
    expect(memberIdentityLine("  ")).toBe("");
  });

  test("the roster and the channel list both go through the helper", async () => {
    const src = await readSrc("components/settings/TeamTab.tsx");
    expect(src).toContain('from "../../lib/memberIdentity"');
    // Three places a member's identity is rendered: the roster row, the merge
    // candidates under it, and the channel member list.
    expect(src.match(/memberIdentityLine\(/g)).toHaveLength(3);
    // And none of them prints the raw field any more. `key={m.email}` stays —
    // React needs a stable identity per row, and the join key is exactly that.
    // What must not survive is the field standing alone as a text node.
    const textNodes = src
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l === "{m.email}" || l === "{o.email}");
    expect(textNodes).toEqual([]);
  });

  test("the teammate picker drops the key rather than printing it", async () => {
    const src = await readSrc("components/settings/IntegrationsTab.tsx");
    expect(src).toContain("isDeviceIdentity");
    expect(src).toContain("m.email && !isDeviceIdentity(m.email)");
  });
});
