/** remark plugin — GitHub-style callouts/alerts.
 *
 *  Rewrites a blockquote whose first line is a `[!TYPE]` marker into a tagged
 *  blockquote the renderer can pick up (className `aura-callout` +
 *  `aura-callout-<type>`), stripping the marker text so only the body prose
 *  remains. Works on the shared mdast, so a single plugin covers every
 *  react-markdown surface (agent chat, team chat, PR, file preview).
 *
 *    > [!NOTE]
 *    > Body text.        →  a note callout containing "Body text."
 *
 *  Supported: NOTE, TIP, IMPORTANT, WARNING, CAUTION (GitHub's five). Pure mdast
 *  transform — no dependency on unist-util-visit, so nothing new to install. */

const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown>; [k: string]: unknown };
};

function tagBlockquote(node: MdNode): void {
  const firstPara = node.children?.[0];
  if (!firstPara || firstPara.type !== "paragraph") return;
  const firstText = firstPara.children?.[0];
  if (!firstText || firstText.type !== "text" || typeof firstText.value !== "string") return;
  const m = firstText.value.match(MARKER);
  if (!m) return;

  const type = m[1].toLowerCase();
  // Strip the marker (and a single following newline, for the common
  // `> [!NOTE]\n> body` shape) so only the body prose is rendered.
  firstText.value = firstText.value.slice(m[0].length).replace(/^\n/, "");
  // A marker-only line leaves an empty paragraph — drop it so the callout
  // doesn't open with a blank row.
  if (!firstText.value && firstPara.children!.length === 1) {
    node.children!.shift();
  }

  node.data = node.data ?? {};
  const props = (node.data.hProperties = node.data.hProperties ?? {});
  const prev = props.className;
  const base = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  props.className = [...base, "aura-callout", `aura-callout-${type}`];
}

function walk(node: MdNode): void {
  if (node.type === "blockquote") tagBlockquote(node);
  if (node.children) for (const child of node.children) walk(child);
}

export function remarkCallouts() {
  return (tree: MdNode): void => walk(tree);
}
