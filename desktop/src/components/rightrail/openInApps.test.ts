import { describe, expect, test } from "bun:test";

import { openInApps } from "./openInApps";

const editors = [
  { id: "cursor", name: "Cursor", available: true },
  { id: "zed", name: "Zed", available: false },
  { id: "default", name: "System default", available: true },
];

describe("Open in on a changed file", () => {
  test("lists the editors that are installed, in order", () => {
    const apps = openInApps(editors, "/r/src/a.ts", async () => {});
    expect(apps.map((a) => [a.id, a.label])).toEqual([
      ["cursor", "Cursor"],
      ["default", "System default"],
    ]);
  });

  test("an app opens the file's full path", async () => {
    const opened: string[] = [];
    const [cursor] = openInApps(editors, "/r/src/a.ts", async (path, id) => {
      opened.push(`${id} ${path}`);
    });
    cursor.onOpen();
    await Promise.resolve();
    expect(opened).toEqual(["cursor /r/src/a.ts"]);
  });

  test("no editors leaves the submenu out", () => {
    expect(openInApps([], "/r/a.ts", async () => {})).toEqual([]);
  });
});
