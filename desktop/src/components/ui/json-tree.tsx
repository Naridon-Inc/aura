// A JSON value drawn as a tree: objects and arrays fold open under a ▶, their
// keys in the number colour, strings and numbers in their own and everything
// else in the keyword colour. A long list shows its first and last items with
// the middle folded into ranges ("46 ... 95") that open on click, and a link
// in a string opens in the browser.

import { useState, type MouseEvent, type ReactNode } from "react";
import { openExternal } from "../../lib/openExternal";

type Key = string | number;
type NodeType = "Object" | "Array" | "String" | "Number" | "Boolean" | "Null" | "Undefined" | string;
type Entry = { key: Key; value: unknown };
type Range = { from: number; to: number };

/** Keys deeper than this start folded. */
const EXPAND_DEPTH = 20;

function nodeTypeOf(value: unknown): NodeType {
  return Object.prototype.toString.call(value).slice(8, -1);
}

function sizeOf(type: NodeType, data: unknown): number {
  if (type === "Object") return Object.keys(data as object).length;
  if (type === "Array") return (data as unknown[]).length;
  return Infinity;
}

function entriesOf(type: NodeType, data: unknown, from = 0, to = Infinity): Entry[] {
  if (type === "Object") {
    const record = data as Record<string, unknown>;
    return Object.getOwnPropertyNames(record)
      .slice(from, to + 1)
      .map((key) => ({ key, value: record[key] }));
  }
  return (data as unknown[]).slice(from, to + 1).map((value, i) => ({ key: i + from, value }));
}

function rangesOf(from: number, to: number, limit: number): Range[] {
  let step = limit;
  while (to - from > step * step) step = step * step;
  const out: Range[] = [];
  for (let at = from; at <= to; at += step) out.push({ from: at, to: Math.min(to, at + step - 1) });
  return out;
}

/** A collection's children: all of them when they fit, otherwise its head
 *  and tail with the middle folded into ranges. */
export function jsonTreeChildren(
  type: NodeType,
  data: unknown,
  limit: number,
  from = 0,
  to = Infinity,
): (Entry | Range)[] {
  const bounded = to < Infinity;
  const count = Math.min(to - from, sizeOf(type, data));
  if (count <= limit || limit < 7) return entriesOf(type, data, from, to);
  if (bounded) return rangesOf(from, to, limit);
  return [
    ...entriesOf(type, data, 0, limit - 5),
    ...rangesOf(limit - 4, count - 5, limit),
    ...entriesOf(type, data, count - 4, count - 1),
  ];
}

const isRange = (item: Entry | Range): item is Range => "to" in item;

function Arrow({
  expanded,
  double = false,
  onClick,
}: {
  expanded: boolean;
  double?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="ui-json-arrow-box" data-double={double || undefined} onClick={onClick}>
      <div className="ui-json-arrow" data-expanded={expanded || undefined}>
        ▶{double && <div className="ui-json-arrow-inner">▶</div>}
      </div>
    </div>
  );
}

function Label({ keyPath, expanded, expandable }: { keyPath: Key[]; expanded: boolean; expandable: boolean }) {
  const [key] = keyPath;
  if (key === undefined) return null;
  return expandable ? (
    <button type="button" aria-label={`${key}:`} aria-expanded={expanded}>
      {key}:
    </button>
  ) : (
    <span>{key}:</span>
  );
}

function shownValue(type: NodeType, value: unknown): string {
  switch (type) {
    case "String":
      return `"${value as string}"`;
    case "Number":
      return String(value);
    case "Boolean":
      return value ? "true" : "false";
    case "Null":
      return "null";
    case "Undefined":
      return "undefined";
    default:
      return `<${type}>`;
  }
}

function isLink(value: unknown): value is string {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function ValueText({ shown, value }: { shown: string; value: unknown }) {
  if (!isLink(value)) return <>{shown}</>;
  const open = (e: MouseEvent) => {
    e.preventDefault();
    void openExternal(value);
  };
  return (
    <>
      "
      <a href={value} className="ui-json-link" onClick={open}>
        {value}
      </a>
      "
    </>
  );
}

type NodeProps = { keyPath: Key[]; value: unknown; limit: number; hideRoot: boolean; level: number };

function ItemRange({
  from,
  to,
  render,
}: {
  from: number;
  to: number;
  render: (from: number, to: number) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <div className="ui-json-range" data-expanded>
        {render(from, to)}
      </div>
    );
  }
  const toggle = () => setOpen(true);
  return (
    <div className="ui-json-range" onClick={toggle}>
      <Arrow expanded={false} double onClick={toggle} />
      {`${from} ... ${to}`}
    </div>
  );
}

function CollectionNode({ keyPath, value, limit, hideRoot, level, type }: NodeProps & { type: "Object" | "Array" }) {
  const size = sizeOf(type, value);
  const expandable = size > 0;
  const [expanded, setExpanded] = useState(() => keyPath.length <= EXPAND_DEPTH);
  const toggle = () => {
    if (expandable) setExpanded(!expanded);
  };
  const renderChildren = (from?: number, to?: number): ReactNode =>
    jsonTreeChildren(type, value, limit, from, to).map((item) =>
      isRange(item) ? (
        <ItemRange
          key={`ItemRange--${item.from}-${item.to}`}
          from={item.from}
          to={item.to}
          render={renderChildren}
        />
      ) : (
        <JsonNode
          key={`Node--${item.key}`}
          keyPath={[item.key, ...keyPath]}
          value={item.value}
          limit={limit}
          hideRoot={false}
          level={level + 1}
        />
      ),
    );
  const showRootOnly = hideRoot && level === 0;
  const children = expanded || showRootOnly ? renderChildren() : null;
  if (showRootOnly) {
    return (
      <li className="ui-json-root">
        <ul>{children}</ul>
      </li>
    );
  }
  const noun = type === "Object" ? (size !== 1 ? "keys" : "key") : size !== 1 ? "items" : "item";
  return (
    <li
      className="ui-json-node"
      data-nested={keyPath.length > 1 || undefined}
      data-expandable={expandable || undefined}
    >
      {expandable && <Arrow expanded={expanded} onClick={toggle} />}
      <label className="ui-json-label" onClick={toggle}>
        <Label keyPath={keyPath} expanded={expanded} expandable={expandable} />
      </label>
      <span className="ui-json-item-string" onClick={toggle}>
        <span>
          <span className="ui-json-item-type">{type === "Object" ? "{}" : "[]"}</span> {size} {noun}
        </span>
      </span>
      <ul className="ui-json-children" data-expanded={expanded || undefined}>
        {children}
      </ul>
    </li>
  );
}

function JsonNode(props: NodeProps) {
  const type = nodeTypeOf(props.value);
  if (type === "Object" || type === "Array") return <CollectionNode {...props} type={type} />;
  return (
    <li className="ui-json-value" data-nested={props.keyPath.length > 1 || undefined}>
      <label className="ui-json-label ui-json-value-label">
        <Label keyPath={props.keyPath} expanded={false} expandable={false} />
      </label>
      <span className="ui-json-value-text" data-type={type}>
        <ValueText shown={shownValue(type, props.value)} value={props.value} />
      </span>
    </li>
  );
}

/** The tree for one parsed JSON value. A non-empty object drops its root row
 *  and lists its keys at the top level. */
export function JsonTree({ data, collectionLimit = 50 }: { data: unknown; collectionLimit?: number }) {
  const hideRoot = data !== null && typeof data === "object" && Object.keys(data).length > 0;
  return (
    <ul className="ui-json-tree">
      <JsonNode keyPath={[]} value={data} limit={collectionLimit} hideRoot={hideRoot} level={0} />
    </ul>
  );
}
