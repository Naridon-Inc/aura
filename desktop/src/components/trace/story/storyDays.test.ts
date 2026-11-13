import { describe, expect, test } from "bun:test";
import { dayLabel } from "../sessionsFeed";
import { formatCount } from "./storyFormat";

describe("a story's day captions", () => {
  const now = new Date(2026, 10, 9, 15, 0);

  test("today and yesterday read as words", () => {
    expect(dayLabel(new Date(2026, 10, 9, 1, 0), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 8, 23, 59), now)).toBe("Yesterday");
  });

  test("older days carry their weekday and date", () => {
    expect(dayLabel(new Date(2026, 10, 5, 9, 0), now)).toBe("Thursday 5 Nov");
  });

  test("yesterday across a month boundary", () => {
    expect(dayLabel(new Date(2026, 9, 31, 12, 0), new Date(2026, 10, 1, 8, 0))).toBe("Yesterday");
  });
});

describe("counts on a moment's line", () => {
  test("large counts get thousands separators", () => {
    expect(formatCount(1240)).toBe((1240).toLocaleString());
    expect(formatCount(12)).toBe("12");
  });
});
