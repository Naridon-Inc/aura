// The words a change note is written in, shared by the diff header and the
// commit's change note.
//
//   bun test tests/changeWords.test.ts

import { describe, expect, test } from "bun:test";
import type { ChangedSymbol, FileChangeNote } from "../src/lib/api";
import {
  baseName,
  blastSummary,
  changeMark,
  changeWord,
  commitBody,
  commitReason,
  onSide,
  pieceLine,
  pieceMeaning,
  pieceTitle,
  plainKind,
  plainSummary,
  prettyKind,
  siblingFiles,
  whereParts,
} from "../src/components/workpanes/changeNote/changeWords";

const sym = (identifier: string, kind: string, change: string): ChangedSymbol => ({
  identifier,
  kind,
  change,
});

const note = (over: Partial<FileChangeNote> = {}): FileChangeNote => ({
  file: "src/a.ts",
  note: "engine note",
  symbols: [],
  direct_callers: [],
  dependent_count: 0,
  features: [],
  leaf: false,
  truncated: false,
  ...over,
});

describe("kinds", () => {
  test("tree-sitter kinds read as short words, unknown ones pass through", () => {
    expect(prettyKind("function_item")).toBe("fn");
    expect(prettyKind("class_declaration")).toBe("class");
    expect(prettyKind("macro_rules")).toBe("macro_rules");
  });

  test("the plain noun carries its own plural", () => {
    expect(plainKind("enum_item")).toEqual({ one: "set of options", many: "sets of options" });
    expect(plainKind("weird")).toEqual({ one: "piece", many: "pieces" });
  });
});

describe("one piece", () => {
  test("each change has a word and a mark", () => {
    expect(changeWord("added")).toBe("added");
    expect(changeWord("deleted")).toBe("removed");
    expect(changeWord("modified")).toBe("changed");
    expect(changeMark("added")).toBe("+");
    expect(changeMark("deleted")).toBe("−");
    expect(changeMark("modified")).toBe("~");
  });

  test("a modified piece is on both sides, the others on one", () => {
    const m = sym("a", "function_item", "modified");
    expect(onSide(m, "previous") && onSide(m, "next")).toBe(true);
    expect(onSide(sym("b", "function_item", "added"), "previous")).toBe(false);
    expect(onSide(sym("c", "function_item", "deleted"), "next")).toBe(false);
  });

  test("the atlas title wins, else the identifier in plain words", () => {
    const s = sym("senderFor", "function_item", "modified");
    expect(pieceTitle(s, { title: "Email sender" } as never)).toBe("Email sender");
    expect(pieceTitle(s, undefined)).toBe("Sender for");
  });

  test("meaning precedence: the piece's own line, the lone-file line, the atlas, the fallback", () => {
    const s = sym("deliver", "function_item", "added");
    const entry = { summary: "Atlas words." } as never;
    expect(pieceLine(s, "Own line.", "File line.", entry)).toBe("Own line.");
    expect(pieceLine(s, "  ", "File line.", entry)).toBe("File line.");
    expect(pieceLine(s, undefined, undefined, entry)).toBe("Atlas words.");
    expect(pieceLine(s, undefined, undefined, undefined)).toBe("A new function.");
    expect(pieceMeaning(sym("x", "class_declaration", "deleted"))).toBe("This class was removed.");
  });
});

describe("plainSummary", () => {
  test("groups by kind and names the pieces", () => {
    expect(
      plainSummary(
        [
          sym("senderFor", "function_item", "modified"),
          sym("deliver", "function_item", "added"),
          sym("EmailDispatcher", "class_declaration", "modified"),
        ],
        "x",
      ),
    ).toBe("Reworked 2 functions (sender for, deliver) and 1 class (email dispatcher).");
  });

  test("all-added and all-removed say so", () => {
    expect(plainSummary([sym("a", "struct_item", "added")], "x")).toBe("Added 1 structure (a).");
    expect(plainSummary([sym("Mode", "enum_item", "deleted"), sym("Kind", "enum_item", "deleted")], "x")).toBe(
      "Removed 2 sets of options (mode, kind).",
    );
  });

  test("no tracked pieces falls back to the engine's note", () => {
    expect(plainSummary([], "Mode change only.")).toBe("Mode change only.");
  });
});

describe("where", () => {
  test("a path splits into a quiet folder and its file name", () => {
    expect(whereParts("src\\lib\\a.ts")).toEqual({ folder: "src/lib/", base: "a.ts" });
    expect(whereParts("README.md")).toEqual({ folder: "", base: "README.md" });
    expect(baseName("src/lib/a.ts")).toBe("a.ts");
  });
});

describe("the commit's words", () => {
  test("the subject is the reason and the rest is the body", () => {
    const msg = "\n  fix(chat): keep the draft\n\nThe draft was dropped on reload.\nNow it isn't.\n";
    expect(commitReason(msg)).toBe("fix(chat): keep the draft");
    expect(commitBody(msg)).toBe("The draft was dropped on reload.\nNow it isn't.");
    expect(commitBody("one-liner")).toBeNull();
    expect(commitReason("")).toBeNull();
  });

  test("how far it ripples, in one phrase", () => {
    const feature = { name: "Login", kind: "http_route", entrySymbol: "login", file: "a" } as never;
    expect(blastSummary(note({ features: [feature], truncated: true }))).toBe("powers 1 feature+");
    expect(blastSummary(note({ dependent_count: 3 }))).toBe("3 other places to re-check");
    expect(blastSummary(note({ leaf: true }))).toBe("safe in isolation");
    expect(blastSummary(note())).toBeNull();
  });

  test("files changed alongside are each listed once, without this one", () => {
    expect(siblingFiles([{ file: "a" }, { file: "b" }], ["b", "c", "a"], "a")).toEqual(["b", "c"]);
  });
});
