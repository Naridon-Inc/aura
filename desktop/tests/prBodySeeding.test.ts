// The template must be seeded once, when a compose request arrives — and never
// from an effect watching the body.
//
// That is the shape this gets written in by accident: `useEffect(() => { if
// (!body) setBody(PR_BODY_TEMPLATE); }, [body])` looks right, passes a glance,
// and makes the description box impossible to empty. Select-all, delete, and
// the skeleton is back before you have let go of the key. There is no way to
// write a PR with no description, and nothing on screen says why.
//
// It is invisible in review because the seeding itself works. So the scan is
// structural: the seed call lives in the request handler, and `body` is not a
// dependency of any effect in the file.

import { describe, expect, it } from "bun:test";

import { readSrc } from "./support/code";

const src = await readSrc("components/dialogs/PrAuthoringDialog.tsx");

describe("seeding the PR description", () => {
  it("happens in the request handler", () => {
    const handler = src.slice(
      src.indexOf("function onRequest"),
      src.indexOf("window.addEventListener(PR_AUTHOR_EVENT"),
    );
    expect(handler).toContain("seedPrBody(");
  });

  it("is the only place that seeds, so nothing can re-seed on a keystroke", () => {
    expect([...src.matchAll(/seedPrBody\(/g)]).toHaveLength(1);
  });

  it("never watches the body, which is what would undo a deliberate clear", () => {
    const deps = [...src.matchAll(/\}, \[([^\]]*)\]\);/g)].map((m) => m[1]);
    const watchingBody = deps.filter((dep) =>
      dep.split(",").some((name) => name.trim() === "body"),
    );
    expect(watchingBody).toEqual([]);
  });
});
