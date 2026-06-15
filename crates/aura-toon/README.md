# aura-toon

[![Crates.io](https://img.shields.io/crates/v/aura-toon.svg)](https://crates.io/crates/aura-toon)
[![docs.rs](https://docs.rs/aura-toon/badge.svg)](https://docs.rs/aura-toon)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Token-Oriented Object Notation encoder for Rust.**
30–60% fewer LLM tokens than JSON. Same data, smaller bill.

```toml
[dependencies]
aura-toon = "0.1"
```

## Why

When you feed structured data to an LLM, you pay per token. JSON is verbose: every key is quoted, every value is quoted, every array element is wrapped in braces. TOON keeps the structure but drops the ceremony, with a tabular form for homogeneous arrays that can cut payload size in half.

## Example

```rust
use serde_json::json;

let value = json!({
    "snapshots": [
        {"file": "main.rs", "trigger": "watcher", "ts": 123},
        {"file": "lib.rs",  "trigger": "mcp",     "ts": 456}
    ]
});

let toon = aura_toon::encode(&value);
println!("{toon}");
```

Output:

```
snapshots[2]{file,trigger,ts}:
  main.rs,watcher,123
  lib.rs,mcp,456
```

Compare to the equivalent JSON (≈3× the tokens):

```json
{"snapshots":[{"file":"main.rs","trigger":"watcher","ts":123},{"file":"lib.rs","trigger":"mcp","ts":456}]}
```

## Comparison

| Format | Bytes | Approx tokens (cl100k) |
|--------|-------|------------------------|
| JSON   | 105   | ~38                    |
| TOON   | 50    | ~15                    |

(Real-world savings depend on your schema. Tabular arrays are where TOON wins biggest.)

## Status

- ✅ Encoding `serde_json::Value` → TOON
- ✅ Tabular arrays of homogeneous objects
- ✅ Inline primitive arrays
- ✅ Quoting per spec §7.2
- ✅ **Caveman mode** — strip prose filler for 20–40% more token savings
- ⏳ Decoder (PRs welcome)

## Caveman Mode

TOON compresses _structure_. Caveman compresses _prose_.

```rust
let verbose = "Sure! I'd be happy to help you with that. The function \
               is currently not working because the variable has not been \
               properly initialized in the constructor. In order to fix \
               this, you need to make sure that the value is correctly \
               configured before calling the method.";

let terse = aura_toon::caveman(verbose);
// → "function fails because variable wasn't initialized in constructor. \
//    to fix this, must value is configured before calling method."
```

Strips:
- Pleasantries ("Sure!", "I'd be happy to help", "Let me know if...")
- Verbose phrases ("in order to" → "to", "due to the fact that" → "because")
- Filler words (the, a, just, really, very, actually, basically, perhaps...)
- Hedging (maybe, possibly, potentially, presumably...)

Preserves:
- Code identifiers (`HashMap<String, Vec<u8>>`)
- Technical terms, function names, error messages
- Sentence structure and meaning

Stack both layers for maximum savings:
```rust
let data = serde_json::json!({"explanation": verbose});
let compact = aura_toon::encode(&data); // structure compression
// Then caveman() the string values before encoding for double savings
```

## Spec

Tracks the [TOON spec](https://github.com/toon-format/spec).

## Origin

Extracted from [Aura](https://auravcs.com) — the semantic version control engine for AI-generated code. Aura uses `aura-toon` to compact MCP tool responses fed back to Claude / GPT, saving tokens on every call.

## License

Apache-2.0
