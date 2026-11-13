// The repositories the member's own GitHub opens, read each time the create
// dialog opens (the server keeps the answer briefly). A failed read is null:
// the dialog then offers every repository and the server decides.

import { useEffect, useState } from "react";

import { readMyGithubRepos, type MyGithubRepos } from "../../lib/cloudMyGithub";

/** `version`: bumped to read again, as when the member just connected. */
export function useMyGithubRepos(open: boolean, version = 0): MyGithubRepos | null {
  const [mine, setMine] = useState<MyGithubRepos | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    readMyGithubRepos()
      .then((m) => live && setMine(m))
      .catch(() => live && setMine(null));
    return () => {
      live = false;
    };
  }, [open, version]);
  return mine;
}
