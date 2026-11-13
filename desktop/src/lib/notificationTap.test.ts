import { describe, expect, test } from "bun:test";

import { tappedKind } from "./notificationTap";

describe("tappedKind", () => {
  test("a tap names the kind it was posted with", () => {
    const extra = { kind: "cloud-mention", workspace_id: "ws_1" };
    expect(tappedKind("com.apple.UNNotificationDefaultActionIdentifier", extra)).toBe("cloud-mention");
    expect(tappedKind(undefined, extra)).toBe("cloud-mention");
  });

  test("a dismissal, a button or an inline reply is not a tap", () => {
    const extra = { kind: "cloud-mention" };
    expect(tappedKind("com.apple.UNNotificationDismissActionIdentifier", extra)).toBeNull();
    expect(tappedKind("REPLY", extra)).toBeNull();
  });

  test("chat taps stay with the chat reply handler, and untagged ones go nowhere", () => {
    expect(tappedKind(undefined, { kind: "chat" })).toBeNull();
    expect(tappedKind(undefined, {})).toBeNull();
    expect(tappedKind(undefined, null)).toBeNull();
    expect(tappedKind(undefined, { kind: 3 })).toBeNull();
  });
});
