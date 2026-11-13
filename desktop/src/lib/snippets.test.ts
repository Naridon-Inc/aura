// Saved snippets: what an empty or damaged store reads as, saving one, the
// keyword the field keeps, where ";" goes, the composer's ";" list and the
// keyword that inserts a snippet outright, and the chat composer's wiring.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { matchSnippets, snippetForKeyword, type ComposerSuggestion } from "../components/ui/composerSuggestions";
import { searchSnippets } from "../components/ui/snippet-picker-dialog";

const SRC = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const store = new Map<string, string>();
let failWrites = false;
const storageListeners: ((event: { key: string; newValue: string | null }) => void)[] = [];
type SnippetsModule = typeof import("./snippets");
let snippets: SnippetsModule;

beforeAll(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrites) throw new Error("denied");
      store.set(k, String(v));
    },
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  // Another suite may already have put a window here; catch the store's
  // "storage" listener on whichever window the module will see.
  const g = globalThis as { window?: { addEventListener?: (...args: unknown[]) => void } };
  const win = g.window ?? (g.window = {});
  const passOn = win.addEventListener?.bind(win);
  win.addEventListener = (...args: unknown[]) => {
    const [type, fn] = args as [string, (event: { key: string; newValue: string | null }) => void];
    if (type === "storage") storageListeners.push(fn);
    else passOn?.(...args);
  };
  (win as { removeEventListener?: (...args: unknown[]) => void }).removeEventListener ??= () => {};
  snippets = await import("./snippets");
});

const row = (name: string, keyword: string | null, body = `${name} text`): ComposerSuggestion => ({
  id: `snippet-${name}`,
  label: name,
  detail: body,
  insertText: body,
  kind: "snippet",
  keyword,
});

describe("the snippet store", () => {
  test("nothing stored, or something unreadable, reads as no snippets", () => {
    expect(snippets.parseSnippets(null)).toEqual([]);
    expect(snippets.parseSnippets("not json")).toEqual([]);
    expect(snippets.parseSnippets('{"id":"x"}')).toEqual([]);
    expect(snippets.parseSnippets('[{"id":"a","name":"A","body":"b","keyword":null,"createdAt":1},{"id":2}]')).toEqual([
      { id: "a", name: "A", body: "b", keyword: null, createdAt: 1 },
    ]);
    expect(snippets.listSnippets()).toEqual([]);
  });

  test("a saved snippet is trimmed, keeps a clean keyword and survives in storage", () => {
    let heard = 0;
    const stop = snippets.subscribeSnippets(() => heard++);
    const saved = snippets.createSnippet({ name: "  Review  ", body: " Check the diff \n", keyword: "re view;" }, 1000);
    stop();
    expect(saved).not.toBeNull();
    expect(saved).toMatchObject({ name: "Review", body: "Check the diff", keyword: "review", createdAt: 1000 });
    expect(heard).toBe(1);
    expect(snippets.listSnippets().map((s) => s.name)).toEqual(["Review"]);
    expect(JSON.parse(store.get("aura.snippets.v1")!)).toHaveLength(1);
    // No keyword is stored as none.
    expect(snippets.createSnippet({ name: "Plain", body: "x", keyword: "  " }, 2000)?.keyword).toBeNull();
  });

  test("an incomplete draft or a refused write saves nothing", () => {
    const before = snippets.listSnippets();
    expect(snippets.createSnippet({ name: "", body: "x", keyword: "" })).toBeNull();
    expect(snippets.createSnippet({ name: "x", body: "   ", keyword: "" })).toBeNull();
    failWrites = true;
    expect(snippets.createSnippet({ name: "x", body: "y", keyword: "" })).toBeNull();
    failWrites = false;
    expect(snippets.listSnippets()).toBe(before);
  });

  test("another window's write reaches this one", () => {
    const value = '[{"id":"w","name":"From elsewhere","body":"b","keyword":"w","createdAt":3}]';
    const stop = snippets.subscribeSnippets(() => {});
    for (const listener of storageListeners) listener({ key: "aura.snippets.v1", newValue: value });
    expect(snippets.listSnippets().map((s) => s.name)).toEqual(["From elsewhere"]);
    stop();
  });

  test("the keyword field drops spaces and ';' and stops at 32 letters", () => {
    expect(snippets.cleanKeyword(" a b;c ")).toBe("abc");
    expect(snippets.cleanKeyword("x".repeat(40))).toHaveLength(32);
  });

  test("';' goes at the caret, after a space unless one is already there", () => {
    expect(snippets.insertSnippetChar("", 0)).toEqual({ value: ";", caret: 1 });
    expect(snippets.insertSnippetChar("fix this", 8)).toEqual({ value: "fix this ;", caret: 10 });
    expect(snippets.insertSnippetChar("fix ", 4)).toEqual({ value: "fix ;", caret: 5 });
    expect(snippets.insertSnippetChar("a\n", 2)).toEqual({ value: "a\n;", caret: 3 });
    expect(snippets.insertSnippetChar("ab", 1)).toEqual({ value: "a ;b", caret: 3 });
  });
});

describe("the composer's ';' list", () => {
  const rows = [row("Write tests", "tests"), row("Review the diff", "review"), row("Rewrite", "rev")];

  test("keyword matches lead, then names holding the letters; a leading space shows nothing", () => {
    expect(matchSnippets(rows, "").map((r) => r.label)).toEqual(["Write tests", "Review the diff", "Rewrite"]);
    expect(matchSnippets(rows, "rev").map((r) => r.label)).toEqual(["Review the diff", "Rewrite"]);
    expect(matchSnippets(rows, "write").map((r) => r.label)).toEqual(["Write tests", "Rewrite"]);
    expect(matchSnippets(rows, "review the").map((r) => r.label)).toEqual(["Review the diff"]);
    expect(matchSnippets(rows, " rev")).toEqual([]);
    expect(matchSnippets([...rows, { ...row("x", null), kind: "command" }], "x")).toEqual([]);
  });

  test("a keyword inserts outright only when it names one snippet and no longer keyword starts with it", () => {
    expect(snippetForKeyword(rows, "tests")?.label).toBe("Write tests");
    expect(snippetForKeyword(rows, "TESTS")?.label).toBe("Write tests");
    expect(snippetForKeyword(rows, "rev")).toBeUndefined();
    expect(snippetForKeyword(rows, "review")?.label).toBe("Review the diff");
    expect(snippetForKeyword(rows, "te")).toBeUndefined();
  });

  test("the picker's search keeps names and texts holding what was typed", () => {
    const list = [
      { id: "a", name: "Review", body: "Check the diff", keyword: null, createdAt: 1 },
      { id: "b", name: "Tests", body: "Write unit tests", keyword: "t", createdAt: 2 },
    ];
    expect(searchSnippets(list, "").map((s) => s.id)).toEqual(["a", "b"]);
    expect(searchSnippets(list, "diff").map((s) => s.id)).toEqual(["a"]);
    expect(searchSnippets(list, "rvw").map((s) => s.id)).toEqual(["a"]);
    expect(searchSnippets(list, "zzz")).toEqual([]);
  });
});

describe("the chat composer's wiring", () => {
  test("⌘; and Add snippet insert ';' or open the picker; ';' rows reach the box", () => {
    const host = read("components/manager/ManagerComposer.tsx");
    expect(host).toContain("const snippet = useSnippetInsert({ field: textareaRef, setText });");
    expect(host).toMatch(/if \(isInsertSnippetKey\(e\)\) \{\s*e\.preventDefault\(\);\s*snippet\.trigger\(\);/);
    expect(host).toContain("suggestions={[...teammates, ...suggestions, ...snippet.rows]}");
    expect(host).toContain("onSnippet={snippet.trigger}");
    expect(host).toContain("<SnippetPickerDialog {...snippet.picker} />");
    expect(host).toContain("<SnippetFormDialog {...snippet.form} />");
    const hook = read("components/manager/useSnippetInsert.ts");
    expect(hook).toMatch(/if \(snippets\.length === 0\) \{\s*setPickerOpen\(true\);/);
    expect(hook).toContain("insertSnippetChar(value, end)");
  });

  test("the menu row is 'Add snippet' with a bookmark and ⌘ ;", () => {
    const menu = read("components/ui/composer-tools.tsx");
    expect(menu).toMatch(/<Bookmark \/>\s*<span className="ui-menu-text">Add snippet<\/span>\s*<DropdownMenuShortcut>⌘ ;<\/DropdownMenuShortcut>/);
  });

  test("the box opens ';' with spaces allowed and puts a snippet in without a trailing space", () => {
    const box = read("components/ui/composer.tsx");
    expect(box).toContain("before.match(/(?:^|\\s)(;)((?:(?!\\s;)[^\\n])*)$/)");
    expect(box).toContain('suggestion.kind === "snippet" ? suggestion.insertText : `${suggestion.insertText} `');
    expect(box).toContain("snippetForKeyword(suggestions, keyword[2])");
  });

  test("the dialogs keep their designed layout", () => {
    const picker = read("components/ui/snippet-picker-dialog.tsx");
    for (const text of ['"Search snippets..."', '"No matching snippets"', '"No snippets"', "Create snippet", "Insert"])
      expect(picker).toContain(text);
    const form = read("components/ui/snippet-form-dialog.tsx");
    for (const text of ["New snippet", ">Name<", ">Keyword<", ">Prompt snippet<", "Discard changes?", "This snippet won't be saved.", "Keep editing"])
      expect(form).toContain(text);
    const css = read("components/ui/snippet-dialogs.css");
    expect(css).toMatch(/\.ui-snippet-picker \{\s*--ui-search-dialog-width: 768px;/);
    expect(css).toMatch(/\.ui-snippet-picker-body \{[^}]*height: 360px/);
    expect(css).toMatch(/\.ui-snippet-picker-list \{[^}]*width: 288px[^}]*border-right/);
    expect(css).toMatch(/\.ui-snippet-picker-row \{[^}]*padding: 5px 8px/);
    expect(css).toMatch(/\.ui-snippet-form \{\s*width: min\(672px/);
    expect(css).toMatch(/\.ui-snippet-form-keyword \{\s*width: 144px/);
    expect(css).toMatch(/\.ui-snippet-form textarea \{\s*height: 320px/);
  });
});
