# aura-merge

[![Crates.io](https://img.shields.io/crates/v/aura-merge.svg)](https://crates.io/crates/aura-merge)
[![docs.rs](https://docs.rs/aura-merge/badge.svg)](https://docs.rs/aura-merge)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Structured 3-way merge for the files Git pretends are all the same.**
JSON, YAML, TOML, code scaffolds, plain text — each gets the right strategy.
Pure stdlib, zero dependencies.

```toml
[dependencies]
aura-merge = "0.1"
```

## Why

`git merge-file` treats every file as a wall of lines. That's fine for prose, terrible for `package.json`, hostile to `Cargo.toml`, and actively dangerous for `.env`. `aura-merge` detects the file type and runs a strategy that respects its structure:

| File type | Strategy |
|-----------|----------|
| `.json` | Key-level deep merge |
| `.yaml`, `.yml` | Key-level deep merge |
| `.toml` | Key-level deep merge |
| `.env`, `.env.*` | Key-level merge |
| `.md`, `.txt`, `.csv`, `.html`, `.css` | Line-level 3-way |
| `.rs`, `.py`, `.ts`, `.js`, `.go`, `.java`, … | Scaffold extraction (non-function regions) |
| Binary, lockfiles, `node_modules/` | Skipped — never sync |

## Comparison

| | `git merge-file` | `aura-merge` |
|---|---|---|
| Treats `package.json` as text | ✅ | ❌ |
| Conflict on reordered keys | ✅ | ❌ |
| Skips lockfiles automatically | ❌ | ✅ |
| Pure Rust, no shell-out | ❌ | ✅ |
| Zero deps | ❌ | ✅ |

## Status

- ✅ File type detection
- ✅ JSON deep merge
- ✅ Text 3-way merge
- ✅ Scaffold extraction
- ⏳ YAML / TOML parsers (currently use generic key-level path; PRs welcome)
- ⏳ Builder API for custom strategies

## Origin

Extracted from [Aura](https://auravcs.com) — the semantic version control engine for AI-generated code. Aura uses `aura-merge` to reconcile concurrent edits from multiple AI agents and human developers without manufacturing fake conflicts.

## License

Apache-2.0
