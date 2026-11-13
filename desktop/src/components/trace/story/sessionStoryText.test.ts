import { describe, expect, test } from "bun:test";
import { clipText, fileStory, whatItSaid, whatWasAsked, workSentence } from "./sessionStoryText";

describe("a session's story", () => {
  test("what was asked is the person's first message, never the logged reason", () => {
    expect(whatWasAsked("Add Google sign-in", "stated", "Wired OAuth")).toBe("Add Google sign-in");
    expect(whatWasAsked(null, "asked", "Add Google sign-in")).toBe("Add Google sign-in");
    expect(whatWasAsked(null, "stated", "Wired OAuth")).toBeNull();
  });

  test("what the agent said is left out when it only repeats the ask", () => {
    expect(whatItSaid("stated", "Wired OAuth", "Add Google sign-in")?.text).toBe("Wired OAuth");
    expect(whatItSaid("stated", "Add Google sign-in", "Add Google sign-in")).toBeNull();
    expect(whatItSaid("asked", "Add Google sign-in", null)).toBeNull();
    expect(whatItSaid("uncaptured", "git status", null)).toBeNull();
    expect(whatItSaid("inferred", "Reworked retry", null)?.source).toContain("Aura read the change");
    expect(whatItSaid("stated", "Wired OAuth", null, "Wired OAuth")).toBeNull();
    expect(whatItSaid("stated", "Wired OAuth\n\nKept the token across restarts.", null, "Wired OAuth")?.text).toBe(
      "Kept the token across restarts.",
    );
  });

  test("work reads as one sentence with thousands separated", () => {
    expect(workSentence(1240, 3, 0)).toBe("The agent took 1,240 steps over 3 of your messages.");
    expect(workSentence(1, 1, 0)).toBe("The agent took 1 step.");
    expect(workSentence(0, 0, 2)).toBe("It handed parts of the work to 2 workers.");
    expect(workSentence(0, 1, 0)).toBeNull();
  });

  test("a file is told by the code it changed, or by its name", () => {
    const sym = { identifier: "signIn", kind: "function_declaration", change: "modified" };
    expect(fileStory({ path: "src/auth/google.ts" }, [sym])).toEqual({
      title: "Reworked 1 function (sign in).",
      where: "src/auth/google.ts",
    });
    expect(fileStory({ path: "README.md" }, [])).toEqual({
      title: "Edited README.md",
      where: "the repository's top folder",
    });
  });

  test("long text is cut where a word ends", () => {
    const long = "word ".repeat(200);
    const { text, clipped } = clipText(long, 50);
    expect(clipped).toBe(true);
    expect(text.endsWith("word…")).toBe(true);
    expect(clipText("short").clipped).toBe(false);
  });
});
