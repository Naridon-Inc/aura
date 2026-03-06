import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, File, Folder } from 'lucide-react';
import type { ReviewFile } from '../lib/types';

interface FileTreeProps {
  files: ReviewFile[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  file?: ReviewFile;
}

function buildTree(files: ReviewFile[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');

      let existing = current.find(n => n.name === name);
      if (!existing) {
        existing = {
          name,
          path,
          isDir: !isLast,
          children: [],
          file: isLast ? file : undefined,
        };
        current.push(existing);
      }
      current = existing.children;
    }
  }

  return root;
}

const statusColors: Record<string, string> = {
  added: 'text-green-500',
  modified: 'text-yellow-500',
  deleted: 'text-red-500',
  renamed: 'text-blue-500',
};

function TreeItem({ node, depth, selectedFile, onSelectFile }: {
  node: TreeNode; depth: number; selectedFile: string | null;
  onSelectFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  if (node.isDir) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 w-full text-left py-1 px-2 hover:bg-gray-100 rounded text-sm"
          style={{ paddingLeft: depth * 12 + 4 }}
        >
          {expanded ? <ChevronDown size={12} className="text-gray-400 shrink-0" /> : <ChevronRight size={12} className="text-gray-400 shrink-0" />}
          <Folder size={14} className="text-gray-400 shrink-0" />
          <span className="text-gray-600 truncate">{node.name}</span>
        </button>
        {expanded && node.children.map(child => (
          <TreeItem key={child.path} node={child} depth={depth + 1} selectedFile={selectedFile} onSelectFile={onSelectFile} />
        ))}
      </div>
    );
  }

  const file = node.file!;
  const isSelected = selectedFile === file.path;

  return (
    <button
      onClick={() => onSelectFile(file.path)}
      className={`flex items-center gap-1.5 w-full text-left py-1 px-2 rounded text-sm ${isSelected ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-100 text-gray-700'}`}
      style={{ paddingLeft: depth * 12 + 4 }}
    >
      <File size={14} className={`shrink-0 ${statusColors[file.status] || 'text-gray-400'}`} />
      <span className="truncate flex-1">{node.name}</span>
      <span className="text-[10px] text-gray-400 shrink-0 font-mono">
        {file.additions > 0 && <span className="text-green-500">+{file.additions}</span>}
        {file.deletions > 0 && <span className="text-red-500 ml-1">-{file.deletions}</span>}
      </span>
    </button>
  );
}

export default function FileTree({ files, selectedFile, onSelectFile }: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Files</span>
        <span className="text-xs text-gray-400">{files.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {tree.map(node => (
          <TreeItem key={node.path} node={node} depth={0} selectedFile={selectedFile} onSelectFile={onSelectFile} />
        ))}
      </div>
    </div>
  );
}
