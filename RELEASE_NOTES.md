# v0.19.33 — A clone that builds, and every copy of your project in one place

## `git clone && cargo build` now works

This is the headline, and it is a fix rather than a feature.

Three crates — `aura-toon`, `aura-merge` and `aura-redact` — started life as
separate repositories, and the CLI still reached them through paths that only
resolved on a machine which already had them checked out next to the source
tree. Everyone working on Aura had those directories, so from the inside
nothing ever looked wrong. From the outside, `cargo metadata` could not resolve
the manifest at all — the build did not fail late, it failed before it started.

They are now vendored under `crates/` as ordinary tracked files. Cloning this
repository and running `cargo build` needs no second step, no submodule init,
and no directories placed beside it by hand. `crates/README.md` records where
each one came from and the commit it was taken at.

A check that reproduces an outsider's view — clone into a scratch directory,
where none of the developers' local checkouts exist, and resolve there — now
runs as part of preparing a release, so this cannot quietly come back.

## Workspaces

When a project has several working copies — worktrees, branches, agents each
given their own sandbox — it gets hard to answer simple questions about them.
Workspaces puts every copy in one place and answers three: what is unfinished
in each, how far each has drifted from the main line, and who or what is
currently working in it.

## Agents in different copies stop colliding

The sentinel and the awareness feed now share one control plane across every
worktree of a project instead of one per directory. Two agents working in
separate copies can see each other's claims, so they stop editing the same
symbol at the same time without either of them knowing.

## A commit has to match what you said you would do

Intent verification moved from advisory to staged. Before a commit lands, what
was actually changed is checked against the intent that was logged for it. If a
symbol you asked to keep was rewritten anyway, it is named rather than passed
over quietly.

## Rewind reaches deleted symbols

`aura rewind` previously restored symbols that had been *changed*. It now also
restores ones that were *removed* — the case people actually reach for it in.

## Smaller things

- `~` in a workspace path expands against the home directory of whoever is
  looking, instead of a hard-coded one. Every machine but one used to render a
  path that did not exist there.
- Strict mode reads as a setting rather than an alarm.
- A sealed stamp shows its real date instead of a question mark.
- The team surface stops redrawing itself on checks that found nothing new.

## Upgrading

No breaking changes to the command surface. `aura --version` should report
0.19.33 after upgrading; if it reports an older version, an older binary is
still earlier on your `PATH`.
