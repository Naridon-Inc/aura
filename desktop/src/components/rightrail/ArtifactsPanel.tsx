// The rail's Artifacts tab: what this workspace has produced that you can
// look at. A card for the code changes (which opens the Changes tab), then a
// card per changed document, page, picture or table — read from the working
// tree the Changes tab reads, previewed from the file itself, and opened in
// a file tab on click. Deleted files have nothing left to show and are left
// out.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileText } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useGitChanges, type ChangedFile } from "../../lib/useGitChanges";
import { readFile } from "../../lib/place/workApi";
import { WorkspaceArtifacts, type WorkspaceArtifact } from "../ui/workspace-artifacts";
import "../ui/file-tab.css";

type ArtifactKind = { type: string; read: "text" | "image" | "none" };

const KINDS: Record<string, ArtifactKind> = {
  md: { type: "MD", read: "text" },
  markdown: { type: "MD", read: "text" },
  mdx: { type: "MDX", read: "text" },
  html: { type: "HTML", read: "text" },
  htm: { type: "HTML", read: "text" },
  csv: { type: "CSV", read: "text" },
  svg: { type: "SVG", read: "image" },
  png: { type: "PNG", read: "image" },
  jpg: { type: "JPG", read: "image" },
  jpeg: { type: "JPG", read: "image" },
  gif: { type: "GIF", read: "image" },
  webp: { type: "WEBP", read: "image" },
  avif: { type: "AVIF", read: "image" },
  pdf: { type: "PDF", read: "none" },
};

/** The most cards the tab draws — each text card reads its file once. */
const MAX_ARTIFACTS = 24;
const PREVIEW_LINES = 12;

function kindOf(path: string): ArtifactKind | null {
  if (path.endsWith("/")) return null;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return KINDS[ext] ?? null;
}

function absPath(repoRoot: string, rel: string): string {
  return rel.startsWith("/") ? rel : `${repoRoot.replace(/\/+$/, "")}/${rel}`;
}

/** One row per path across staged, unstaged and untracked — a file both
 *  staged and edited again is still one file. */
function uniqueChanged(staged: ChangedFile[], unstaged: ChangedFile[], untracked: ChangedFile[]) {
  const byPath = new Map<string, ChangedFile>();
  for (const f of [...staged, ...unstaged, ...untracked]) {
    const prev = byPath.get(f.path);
    byPath.set(
      f.path,
      prev
        ? { ...f, additions: prev.additions + f.additions, deletions: prev.deletions + f.deletions }
        : f,
    );
  }
  return [...byPath.values()];
}

export function ArtifactsPanel({
  repoRoot,
  onOpen,
  onChanges,
}: {
  repoRoot: string;
  /** Open a file (absolute path) in a file tab. */
  onOpen: (path: string) => void;
  /** Show the Changes tab. */
  onChanges: () => void;
}) {
  const { staged, unstaged, untracked } = useGitChanges(repoRoot);
  const files = useMemo(
    () => uniqueChanged(staged, unstaged, untracked),
    [staged, unstaged, untracked],
  );
  const live = useMemo(() => files.filter((f) => f.status !== "D"), [files]);
  const artifacts = useMemo(
    () =>
      live
        .map((f) => ({ file: f, kind: kindOf(f.path) }))
        .filter((a): a is { file: ChangedFile; kind: ArtifactKind } => a.kind !== null)
        .slice(0, MAX_ARTIFACTS),
    [live],
  );

  // Text previews, re-read when a file's size of change moves (an edit),
  // never on an unchanged poll.
  const textKey = artifacts
    .filter((a) => a.kind.read === "text")
    .map((a) => `${a.file.path}:${a.file.additions}:${a.file.deletions}`)
    .join("|");
  const [texts, setTexts] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const wanted = artifacts.filter((a) => a.kind.read === "text");
    void Promise.all(
      wanted.map((a) =>
        readFile(absPath(repoRoot, a.file.path))
          .then((c) => [a.file.path, c.status === "ok" ? c.text : ""] as const)
          .catch(() => [a.file.path, ""] as const),
      ),
    ).then((rows) => {
      if (alive) setTexts(Object.fromEntries(rows));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, textKey]);

  const items: WorkspaceArtifact[] = artifacts.map(({ file, kind }) => ({
    id: file.path,
    title: file.path.split("/").pop() || file.path,
    type: kind.type,
    preview: <ArtifactPreview repoRoot={repoRoot} file={file} kind={kind} text={texts[file.path]} />,
  }));

  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const f of files) {
      added += f.additions;
      removed += f.deletions;
    }
    return { added, removed, files: files.length };
  }, [files]);

  return (
    <div className="ui-artifacts-panel">
      <WorkspaceArtifacts
        items={items}
        changes={totals.files > 0 ? totals : undefined}
        onChanges={onChanges}
        onOpen={(id) => onOpen(absPath(repoRoot, id))}
      />
    </div>
  );
}

function ArtifactPreview({
  repoRoot,
  file,
  kind,
  text,
}: {
  repoRoot: string;
  file: ChangedFile;
  kind: ArtifactKind;
  text: string | undefined;
}): ReactNode {
  const [broken, setBroken] = useState(false);
  if (kind.read === "image" && !broken) {
    return (
      <img
        src={convertFileSrc(absPath(repoRoot, file.path))}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
      />
    );
  }
  if (kind.read === "text" && text) {
    return <pre>{text.split("\n").slice(0, PREVIEW_LINES).join("\n")}</pre>;
  }
  return <FileText size={28} aria-hidden="true" />;
}
