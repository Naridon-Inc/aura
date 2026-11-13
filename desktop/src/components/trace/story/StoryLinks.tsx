// The quiet links under a chapter or at the foot of a story: each one a way
// further in, or one thing to do with what was just read.

import { Button } from "../../ui/button";

export type StoryLink = { label: string; go: () => void; title?: string };

export function StoryLinks({ links }: { links: (StoryLink | false | null | undefined)[] }) {
  const shown = links.filter((l): l is StoryLink => !!l);
  if (shown.length === 0) return null;
  return (
    <div className="ui-trace-story-links">
      {shown.map((l, i) => (
        // By place, not label: a link whose words change ("Copied") keeps focus.
        <Button key={i} variant="link" size="xs" title={l.title} onClick={l.go}>
          {l.label}
        </Button>
      ))}
    </div>
  );
}
