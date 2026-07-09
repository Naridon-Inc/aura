// Sidebar top — project name, path, and branch chip. The "New session"
// affordance lives in the TopBar `+` button (and ⌘N); this header used
// to host a duplicate that was visually loud in the welcome state and
// no longer wired to anything.

type ProjectHeaderProps = {
  name: string;
  path: string;
  branch: string;
};

export function ProjectHeader({ name, path, branch }: ProjectHeaderProps) {
  return (
    <div className="flex flex-col gap-2 px-3 pt-3 pb-2 border-b border-line-soft flex-shrink-0">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-text-1 text-[13px] font-medium truncate" title={name}>
            {name}
          </div>
          <div className="text-text-3 text-[11px] truncate mt-0.5" title={path}>
            {prettyPath(path)}
          </div>
        </div>
        <BranchChip branch={branch} />
      </div>
    </div>
  );
}

function BranchChip({ branch }: { branch: string }) {
  return (
    <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded bg-bg-2 text-text-2 text-[10.5px] font-medium max-w-[120px]">
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
        <circle cx="4" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="12" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M4 5.5v3a3 3 0 003 3h3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      </svg>
      <span className="truncate">{branch}</span>
    </span>
  );
}

function prettyPath(p: string): string {
  const m = p.match(/^\/Users\/[^/]+/);
  if (m) return p.replace(m[0], "~");
  return p;
}
