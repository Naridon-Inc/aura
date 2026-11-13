// The claim under test: a cloud view opened again paints what it showed
// last on its very first render — before any read has been sent — and an
// account change leaves nothing of the last account to paint. Rendered to
// static markup, so no effect and no read ever runs: whatever shows came
// from the kept view.

import { beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { forgetAccountScoped, writeCache } from "../../lib/resourceCache";
import type { CloudMessageRow } from "../../lib/cloudWorkspacesApi";
import { viewKey } from "./cloudPlaceKeep";
import { useKeptView } from "./useKeptView";
import { useWorkspaceLive } from "./useWorkspaceLive";

function Shown({ id }: { id: string }) {
  const [value] = useKeptView<string | null>(viewKey("test", id), null);
  return <p>{value ?? "nothing yet"}</p>;
}

function Conversation({ id, enabled = true }: { id: string; enabled?: boolean }) {
  const { messages } = useWorkspaceLive(id, { enabled, running: false });
  return <p>{messages === null ? "reading…" : `${messages.length} turns`}</p>;
}

const turn = (id: string) => ({ id, created_at: "2026-11-11T10:00:00Z" }) as CloudMessageRow;

beforeEach(() => forgetAccountScoped());

describe("useKeptView", () => {
  it("opens on nothing the first time", () => {
    expect(renderToStaticMarkup(<Shown id="a" />)).toBe("<p>nothing yet</p>");
  });

  it("opens on what the view showed last", () => {
    writeCache(viewKey("test", "a"), "kept");
    expect(renderToStaticMarkup(<Shown id="a" />)).toBe("<p>kept</p>");
    expect(renderToStaticMarkup(<Shown id="b" />)).toBe("<p>nothing yet</p>");
  });

  it("keeps nothing across an account change", () => {
    writeCache(viewKey("test", "a"), "kept");
    forgetAccountScoped();
    expect(renderToStaticMarkup(<Shown id="a" />)).toBe("<p>nothing yet</p>");
  });
});

describe("a workspace's conversation", () => {
  it("shows the turns it had at once when opened again", () => {
    writeCache(viewKey("messages", "ws-1"), [turn("m1"), turn("m2")]);
    expect(renderToStaticMarkup(<Conversation id="ws-1" />)).toBe("<p>2 turns</p>");
  });

  it("reads from nothing the first time", () => {
    expect(renderToStaticMarkup(<Conversation id="ws-2" />)).toBe("<p>reading…</p>");
  });

  it("shows none for a chat driven from this laptop", () => {
    writeCache(viewKey("messages", "ws-1"), [turn("m1")]);
    expect(renderToStaticMarkup(<Conversation id="ws-1" enabled={false} />)).toBe("<p>reading…</p>");
  });
});
