import {
  useMemo,
  useRef,
  useState,
  type ReactNode,
  Fragment,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { DiffCount } from "./sidebar";
export interface FileTreeNode {
  id: string;
  name: string;
  children?: FileTreeNode[];
  status?: "added" | "modified" | "deleted" | "conflict";
  /** What the status mark means, in words — read on hover and by a screen
   *  reader in place of the bare state name. */
  statusLabel?: string;
  added?: number;
  removed?: number;
}
const STATUS_MARK: Record<NonNullable<FileTreeNode["status"]>, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  conflict: "C",
};
interface VisibleNode {
  node: FileTreeNode;
  level: number;
  parent?: string;
  position: number;
  size: number;
}
export interface FileTreeProps {
  nodes: FileTreeNode[];
  selected?: string;
  onSelect: (node: FileTreeNode) => void;
  defaultExpanded?: string[];
  label?: string;
  wrapRow?: (node: FileTreeNode, row: ReactNode) => ReactNode;
  /** The open folders, when the caller keeps them — for folders whose
   *  children are read only once opened, or a "collapse all". Omitted, the
   *  tree keeps its own, starting from `defaultExpanded`. */
  expanded?: ReadonlySet<string>;
  /** Every open or close, with the set it leaves and the folder it was. */
  onExpandedChange?: (expanded: Set<string>, node: FileTreeNode, open: boolean) => void;
  /** Replaces what a click does (open a folder, select a file). The row still
   *  takes focus; the event carries the modifier keys. */
  onRowClick?: (node: FileTreeNode, event: MouseEvent<HTMLDivElement>) => void;
  /** Extra attributes for a row — drag handlers, a title, a selection state.
   *  The row keeps its own class, indent, focus, keys and click. */
  rowProps?: (node: FileTreeNode) => HTMLAttributes<HTMLDivElement>;
  /** Draws a row's name in place of the plain text — an inline rename field. */
  renderName?: (node: FileTreeNode) => ReactNode;
}
export function FileTree({
  nodes,
  selected,
  onSelect,
  defaultExpanded = [],
  label = "Files",
  wrapRow = (_node, row) => row,
  expanded: expandedProp,
  onExpandedChange,
  onRowClick,
  rowProps,
  renderName,
}: FileTreeProps) {
  const [ownExpanded, setExpanded] = useState(() => new Set(defaultExpanded));
  const expanded = expandedProp ?? ownExpanded;
  const [focused, setFocused] = useState<string>();
  const refs = useRef(new Map<string, HTMLDivElement>());
  const search = useRef({ text: "", time: 0 });
  const visible = useMemo(() => {
    const rows: VisibleNode[] = [];
    const walk = (items: FileTreeNode[], level: number, parent?: string) =>
      items.forEach((node, index) => {
        rows.push({ node, level, parent, position: index + 1, size: items.length });
        if (node.children && expanded.has(node.id)) walk(node.children, level + 1, node.id);
      });
    walk(nodes, 1);
    return rows;
  }, [nodes, expanded]);
  const focusId = visible.some((row) => row.node.id === focused)
    ? focused
    : visible.some((row) => row.node.id === selected)
      ? selected
      : visible[0]?.node.id;
  const move = (id?: string) => {
    if (id) {
      setFocused(id);
      refs.current.get(id)?.focus();
    }
  };
  const toggle = (node: FileTreeNode, open = !expanded.has(node.id)) => {
    const { id } = node;
    if (expandedProp === undefined)
      setExpanded((previous) => {
        const next = new Set(previous);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      });
    if (onExpandedChange) {
      const next = new Set(expanded);
      if (open) next.add(id);
      else next.delete(id);
      onExpandedChange(next, node, open);
    }
  };
  const keyDown = (event: KeyboardEvent, row: VisibleNode, index: number) => {
    const { node } = row;
    if (
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(
        event.key,
      )
    )
      event.preventDefault();
    if (event.key === "ArrowUp") move(visible[Math.max(0, index - 1)]?.node.id);
    else if (event.key === "ArrowDown")
      move(visible[Math.min(visible.length - 1, index + 1)]?.node.id);
    else if (event.key === "Home") move(visible[0]?.node.id);
    else if (event.key === "End") move(visible[visible.length - 1]?.node.id);
    else if (event.key === "ArrowRight" && node.children) {
      if (!expanded.has(node.id)) toggle(node, true);
      else move(node.children[0]?.id);
    } else if (event.key === "ArrowLeft") {
      if (node.children && expanded.has(node.id)) toggle(node, false);
      else move(row.parent);
    } else if (event.key === "Enter" || event.key === " ") {
      if (node.children) toggle(node);
      else onSelect(node);
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      search.current = {
        text:
          now - search.current.time < 500
            ? search.current.text + event.key.toLowerCase()
            : event.key.toLowerCase(),
        time: now,
      };
      const ordered = [...visible.slice(index + 1), ...visible.slice(0, index + 1)];
      move(
        ordered.find((item) => item.node.name.toLowerCase().startsWith(search.current.text))?.node
          .id,
      );
    }
  };
  return (
    <div className="ui-file-tree" role="tree" aria-label={label}>
      {visible.map((row, index) => (
        <Fragment key={row.node.id}>
          {wrapRow(
            row.node,
            <div
              key={row.node.id}
              ref={(element) => {
                if (element) refs.current.set(row.node.id, element);
                else refs.current.delete(row.node.id);
              }}
              role="treeitem"
              tabIndex={row.node.id === focusId ? 0 : -1}
              aria-level={row.level}
              aria-setsize={row.size}
              aria-posinset={row.position}
              aria-expanded={row.node.children ? expanded.has(row.node.id) : undefined}
              aria-selected={selected === row.node.id}
              data-status={row.node.status}
              {...rowProps?.(row.node)}
              className="ui-file-tree-row"
              style={{ paddingLeft: 8 + (row.level - 1) * 16 }}
              onFocus={() => setFocused(row.node.id)}
              onKeyDown={(event) => keyDown(event, row, index)}
              onClick={(event) => {
                move(row.node.id);
                if (onRowClick) onRowClick(row.node, event);
                else if (row.node.children) toggle(row.node);
                else onSelect(row.node);
              }}
            >
              {row.node.children ? (
                <>
                  {expanded.has(row.node.id) ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )}
                  {expanded.has(row.node.id) ? <FolderOpen size={14} /> : <Folder size={14} />}
                </>
              ) : (
                <>
                  <span className="ui-file-tree-spacer" />
                  <File size={14} />
                </>
              )}
              <span className="ui-file-tree-name">
                {renderName ? renderName(row.node) : row.node.name}
              </span>
              {row.node.status && (
                <span
                  className="ui-file-status"
                  aria-label={row.node.statusLabel ?? row.node.status}
                  title={row.node.statusLabel}
                >
                  {STATUS_MARK[row.node.status]}
                </span>
              )}
              {row.node.added !== undefined && (
                <DiffCount added={row.node.added} removed={row.node.removed ?? 0} />
              )}
            </div>,
          )}
        </Fragment>
      ))}
    </div>
  );
}
