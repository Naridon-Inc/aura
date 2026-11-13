// Run with: bun test src/components/ui/tasks-board.test.tsx
//
// The desktop app's web view never delivers an HTML5 `drop`, so a card that
// was natively `draggable` lifted off the board and never landed anywhere.
// Boards now move cards with a pointer drag. These pin the markup that drag
// depends on: no card is natively draggable, and only the columns that take a
// drop are drop targets, in the same drag scope as their board.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskBoard, TaskBoardCard, TaskBoardColumn } from "./tasks-board";

const scopes = (html: string) => [...html.matchAll(/data-pointer-drop-scope="([^"]+)"/g)].map((m) => m[1]);
const targets = (html: string) => [...html.matchAll(/data-pointer-drop="([^"]+)"/g)].map((m) => m[1]);

describe("the task board", () => {
  const html = renderToStaticMarkup(
    <TaskBoard label="Dashboard">
      <TaskBoardColumn label="Todo" count={1} onDrop={() => {}}>
        <TaskBoardCard label="Write the importer" taskId="t1" draggable onOpen={() => {}}>
          Write the importer
        </TaskBoardCard>
      </TaskBoardColumn>
      <TaskBoardColumn label="Done" count={0} onDrop={() => {}} />
      <TaskBoardColumn label="Ada" count={0} />
    </TaskBoard>,
  );

  test("no card is natively draggable, so a press still opens it", () => {
    expect(html).not.toContain("draggable");
    expect(html).toContain('data-task-id="t1"');
  });

  test("columns that take a drop are targets in the board's one drag scope", () => {
    const found = scopes(html);
    expect(found).toHaveLength(2);
    expect(new Set(found).size).toBe(1);
    expect(new Set(targets(html)).size).toBe(2);
  });

  test("a column a card cannot be moved into is not a target", () => {
    const ada = html.slice(html.indexOf('aria-label="Ada tasks"'));
    expect(ada).not.toContain("data-pointer-drop");
  });
});
