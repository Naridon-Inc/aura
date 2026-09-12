# Contributing to Aura

Aura is a small project with a large surface: one CLI, twenty-five engine
crates, a desktop app and an editor extension, all in this repository. That
makes it easy to get lost on the way in. This page is the short road.

If you only have ten minutes, start at an issue labelled
[`up-for-grabs`](https://github.com/Naridon-Inc/aura/labels/up-for-grabs).
Each one is scoped to a single file or a single command, says where the code
lives, and says what "done" looks like.

## Build it

You need a stable Rust toolchain. The crates use edition 2024, so 1.85 or
newer:

```bash
git clone https://github.com/Naridon-Inc/aura
cd aura
cargo build --release
```

That produces `target/release/aura`. Nothing else is required — no database,
no service, no account. The engine is local.

## Test it

These are the exact three commands CI runs on Linux and macOS for every push
and every pull request:

```bash
cargo build --release
cargo test --test e2e -- --test-threads=4
cargo test --bin aura -- --test-threads=4
```

The end-to-end suite builds throwaway git repositories in a temp directory and
drives the real binary against them, so it is slower than the unit tests and it
is the one that catches actual breakage. Run both before you open a pull
request. If a test fails on your machine and you believe it is unrelated to
your change, say so in the pull request rather than deleting it.

Set `AURA_E2E_KEEP_REPOS=1` to keep the temporary repositories a failing test
built, so you can go and look at them.

## Where the code is

```
src/            the `aura` CLI — every subcommand and the commit-time gates
crates/         the engine: AST diff and merge, attestation, plugin signing,
                the Crew work-loop, redaction, the terminal, the daemon
desktop/        the desktop app (Tauri + React)
extensions/     the VS Code extension
integrations/   recipes for other editors and agents
docs/guide.md   the full guide
tests/          the end-to-end suites
```

Two starting points cover most first contributions. A new language goes through
the Tree-sitter parsers and the node extraction in `src/`. A change to what a
commit is allowed to do goes through the gates that run inside
`capture-context`, also in `src/`.

## Aura checks its own commits

This repository is the engine's first user. If you run `aura init` in your
clone, the git hooks install and your commits are parsed, diffed at the symbol
level, and checked the same way anyone else's are. That is the point, and it is
also the fastest way to understand what the tool does.

It means one extra step before you commit:

```bash
aura log-intent --type BugFix "Narrowed the edge gate to the files the commit writes"
```

`--type` is one of `FeatureAdd`, `BugFix`, `Refactor`, `Revert`, `Performance`,
`Docs`, `Deps`. If a gate stops your commit, read what it printed: it names the
symbol it is unhappy about and hands you the command that resolves it. A gate
that stops you without telling you what to do next is a bug in Aura, and we
want that reported.

You are not required to run the hooks. CI does not check for them, and a pull
request from a clone without them is just as welcome.

## Pull requests

One change per pull request. A bug fix and the refactor you noticed on the way
are two pull requests.

Say what changed and why in the description, in sentences. The commit titles in
this repository describe behaviour rather than mechanics — "a commit that stages
itself is checked like any other", not "fix index handling" — and it is worth
matching that, because a year from now the title is what someone reads.

Bug fixes need a test that fails before the fix and passes after it. If the bug
is only reachable through the real binary, that test belongs in `tests/e2e.rs`.

Code is formatted with `cargo fmt` and should be clean under `cargo clippy`.

## Reporting a bug

Open an [issue](https://github.com/Naridon-Inc/aura/issues/new). What helps
most: your `aura --version`, your OS, and the smallest sequence of commands
that reproduces it. If Aura blocked a commit that should have landed, or landed
one it should have blocked, paste what it printed.

Security issues do not go in the issue tracker. [`SECURITY.md`](SECURITY.md)
explains the private channel.

Questions, ideas and "is this supposed to work this way" go in
[Discussions](https://github.com/Naridon-Inc/aura/discussions).

## Licence

Aura is Apache 2.0. Contributions are accepted under the same licence — what
comes in is what goes out. There is no contributor licence agreement to sign.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
