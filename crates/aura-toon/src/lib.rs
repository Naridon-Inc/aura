//! # aura-toon
//!
//! Lightweight encoder for **TOON** — Token-Oriented Object Notation.
//!
//! TOON is a JSON-compatible serialization format designed to reduce token
//! count when feeding structured data to LLMs. For typical payloads it
//! produces 30–60% fewer tokens than equivalent JSON, with a tabular form
//! for arrays of homogeneous objects.
//!
//! Spec: <https://github.com/toon-format/spec>
//!
//! ## Example
//!
//! ```
//! use serde_json::json;
//!
//! let value = json!({
//!     "snapshots": [
//!         {"file": "main.rs", "trigger": "watcher", "ts": 123},
//!         {"file": "lib.rs",  "trigger": "mcp",     "ts": 456}
//!     ]
//! });
//!
//! let toon = aura_toon::encode(&value);
//! assert!(toon.contains("snapshots[2]{file,trigger,ts}:"));
//! ```
//!
//! ## Caveman Mode
//!
//! For natural-language strings, `caveman()` strips articles, filler words,
//! hedging, and pleasantries — producing terse, fragment-style output that
//! uses 20–40% fewer tokens while preserving all technical meaning.
//!
//! ```
//! let verbose = "I would be happy to help you with that. The function is currently \
//!                failing because the variable is not properly initialized.";
//! let terse = aura_toon::caveman(verbose);
//! assert!(terse.contains("function"));
//! assert!(!terse.contains("would be happy"));
//! ```
//!
//! Originally extracted from [Aura](https://auravcs.com), the semantic
//! version control engine.

use serde_json::Value;

const INDENT: &str = "  ";

/// Encode a serde_json::Value as a TOON string.
pub fn encode(value: &Value) -> String {
    let mut out = String::new();
    encode_value(value, 0, &mut out);
    // Remove trailing newline per spec
    while out.ends_with('\n') {
        out.pop();
    }
    out
}

fn encode_value(value: &Value, depth: usize, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&canonical_number(n)),
        Value::String(s) => encode_string(s, ',', out),
        Value::Array(arr) => encode_array(arr, depth, out),
        Value::Object(obj) => encode_object_fields(obj, depth, out),
    }
}

fn canonical_number(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    if let Some(f) = n.as_f64() {
        if f.is_nan() || f.is_infinite() {
            return "null".to_string();
        }
        if f == 0.0 {
            return "0".to_string();
        }
        // Check if it's effectively an integer
        if f.fract() == 0.0 && f.abs() < (i64::MAX as f64) {
            return (f as i64).to_string();
        }
        // Remove trailing zeros
        let s = format!("{}", f);
        s
    } else {
        "null".to_string()
    }
}

/// Quote a string value if needed per TOON spec section 7.2
fn needs_quoting(s: &str, delimiter: char) -> bool {
    if s.is_empty() {
        return true;
    }
    if s.starts_with(' ') || s.ends_with(' ') {
        return true;
    }
    if s == "true" || s == "false" || s == "null" {
        return true;
    }
    if s.starts_with('-') {
        return true;
    }
    // Numeric pattern check
    if looks_numeric(s) {
        return true;
    }
    // Contains special characters
    for c in s.chars() {
        if c == ':'
            || c == '"'
            || c == '\\'
            || c == '['
            || c == ']'
            || c == '{'
            || c == '}'
            || c == '\n'
            || c == '\r'
            || c == '\t'
        {
            return true;
        }
        if c == delimiter {
            return true;
        }
    }
    false
}

fn looks_numeric(s: &str) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s);
    if s.is_empty() {
        return false;
    }
    // Leading zero followed by more digits
    if s.len() > 1 && s.starts_with('0') && s.as_bytes()[1].is_ascii_digit() {
        return true;
    }
    let mut chars = s.chars().peekable();
    // Integer part
    if !chars.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        return false;
    }
    while chars.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        chars.next();
    }
    // Optional fractional part
    if chars.peek() == Some(&'.') {
        chars.next();
        if !chars.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
            return false;
        }
        while chars.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
            chars.next();
        }
    }
    // Optional exponent
    if chars
        .peek()
        .map(|c| *c == 'e' || *c == 'E')
        .unwrap_or(false)
    {
        chars.next();
        if chars
            .peek()
            .map(|c| *c == '+' || *c == '-')
            .unwrap_or(false)
        {
            chars.next();
        }
        if !chars.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
            return false;
        }
        while chars.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
            chars.next();
        }
    }
    chars.peek().is_none()
}

fn escape_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out
}

fn encode_string(s: &str, delimiter: char, out: &mut String) {
    if needs_quoting(s, delimiter) {
        out.push('"');
        out.push_str(&escape_string(s));
        out.push('"');
    } else {
        out.push_str(s);
    }
}

/// Check if a key can be unquoted: ^[A-Za-z_][A-Za-z0-9_.]*$
fn key_needs_quoting(k: &str) -> bool {
    if k.is_empty() {
        return true;
    }
    let mut chars = k.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphabetic() && first != '_' {
        return true;
    }
    for c in chars {
        if !c.is_ascii_alphanumeric() && c != '_' && c != '.' {
            return true;
        }
    }
    false
}

fn encode_key(k: &str, out: &mut String) {
    if key_needs_quoting(k) {
        out.push('"');
        out.push_str(&escape_string(k));
        out.push('"');
    } else {
        out.push_str(k);
    }
}

fn indent(depth: usize, out: &mut String) {
    for _ in 0..depth {
        out.push_str(INDENT);
    }
}

fn encode_object_fields(obj: &serde_json::Map<String, Value>, depth: usize, out: &mut String) {
    for (key, val) in obj {
        indent(depth, out);
        encode_key(key, out);

        match val {
            Value::Object(inner) if !inner.is_empty() => {
                out.push_str(":\n");
                encode_object_fields(inner, depth + 1, out);
            }
            Value::Array(arr) => {
                encode_array_header(key, arr, out);
                encode_array_body(arr, depth, out);
            }
            _ => {
                out.push_str(": ");
                encode_value(val, depth + 1, out);
                out.push('\n');
            }
        }
    }
}

/// Try tabular form: all elements are objects with identical keys and all primitive values
fn try_tabular(arr: &[Value]) -> Option<Vec<String>> {
    if arr.is_empty() {
        return None;
    }
    let mut fields: Option<Vec<String>> = None;
    for item in arr {
        let obj = item.as_object()?;
        let keys: Vec<String> = obj.keys().cloned().collect();
        // All values must be primitives
        for val in obj.values() {
            if val.is_object() || val.is_array() {
                return None;
            }
        }
        match &fields {
            None => fields = Some(keys),
            Some(f) => {
                if keys.len() != f.len() || keys.iter().zip(f.iter()).any(|(a, b)| a != b) {
                    return None;
                }
            }
        }
    }
    fields
}

fn encode_array_header(_key: &str, arr: &[Value], out: &mut String) {
    // Don't re-emit key, it was already emitted by caller
    // Actually this is called from encode_object_fields which already emitted the key
    // We need to emit [N] or [N]{fields}:
    let len = arr.len();

    if let Some(fields) = try_tabular(arr) {
        out.push_str(&format!("[{}]{{", len));
        for (i, f) in fields.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            encode_key(f, out);
        }
        out.push_str("}:\n");
    } else if all_primitives(arr) {
        // Inline primitive array
        out.push_str(&format!("[{}]: ", len));
        for (i, val) in arr.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            encode_primitive_value(val, ',', out);
        }
        out.push('\n');
    } else {
        out.push_str(&format!("[{}]:\n", len));
    }
}

fn all_primitives(arr: &[Value]) -> bool {
    arr.iter().all(|v| !v.is_object() && !v.is_array())
}

fn encode_primitive_value(val: &Value, delimiter: char, out: &mut String) {
    match val {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&canonical_number(n)),
        Value::String(s) => encode_string(s, delimiter, out),
        _ => {}
    }
}

fn encode_array_body(arr: &[Value], depth: usize, out: &mut String) {
    if let Some(fields) = try_tabular(arr) {
        // Tabular rows
        for item in arr {
            let obj = item.as_object().unwrap();
            indent(depth + 1, out);
            for (i, f) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                let val = obj.get(f).unwrap_or(&Value::Null);
                encode_primitive_value(val, ',', out);
            }
            out.push('\n');
        }
    } else if all_primitives(arr) {
        // Already handled inline in header
    } else {
        // Mixed/expansion form
        for item in arr {
            indent(depth + 1, out);
            out.push_str("- ");
            match item {
                Value::Object(obj) if !obj.is_empty() => {
                    // First field on hyphen line
                    let mut iter = obj.iter();
                    if let Some((k, v)) = iter.next() {
                        encode_key(k, out);
                        match v {
                            Value::Object(inner) if !inner.is_empty() => {
                                out.push_str(":\n");
                                encode_object_fields(inner, depth + 2, out);
                            }
                            _ => {
                                out.push_str(": ");
                                encode_value(v, depth + 2, out);
                                out.push('\n');
                            }
                        }
                        // Remaining fields at depth+1
                        for (k, v) in iter {
                            indent(depth + 2, out);
                            encode_key(k, out);
                            match v {
                                Value::Object(inner) if !inner.is_empty() => {
                                    out.push_str(":\n");
                                    encode_object_fields(inner, depth + 3, out);
                                }
                                _ => {
                                    out.push_str(": ");
                                    encode_value(v, depth + 3, out);
                                    out.push('\n');
                                }
                            }
                        }
                    }
                }
                _ => {
                    encode_value(item, depth + 2, out);
                    out.push('\n');
                }
            }
        }
    }
}

fn encode_array(arr: &[Value], depth: usize, out: &mut String) {
    // Root-level array (no key)
    let len = arr.len();

    if let Some(fields) = try_tabular(arr) {
        out.push_str(&format!("[{}]{{", len));
        for (i, f) in fields.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            encode_key(f, out);
        }
        out.push_str("}:\n");
        for item in arr {
            let obj = item.as_object().unwrap();
            indent(depth + 1, out);
            for (i, f) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                let val = obj.get(f).unwrap_or(&Value::Null);
                encode_primitive_value(val, ',', out);
            }
            out.push('\n');
        }
    } else if all_primitives(arr) {
        out.push_str(&format!("[{}]: ", len));
        for (i, val) in arr.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            encode_primitive_value(val, ',', out);
        }
        out.push('\n');
    } else {
        out.push_str(&format!("[{}]:\n", len));
        encode_array_body(arr, depth, out);
    }
}

// ─── Caveman Mode ─────────────────────────────────────────────────────────
// Strips low-information tokens from natural language to reduce LLM token
// usage while preserving technical meaning. Drop articles, filler, hedging,
// pleasantries. Collapse verbose phrases to short synonyms.

/// Strip filler words, articles, hedging, and pleasantries from prose.
///
/// Designed for LLM-to-LLM communication where politeness wastes tokens.
/// Preserves code identifiers, technical terms, and sentence structure.
/// Produces terse, fragment-style output (20–40% fewer tokens on typical
/// LLM prose).
///
/// # Example
///
/// ```
/// let input = "Sure! I'd be happy to help you with that. The function \
///              is currently not working because the variable has not been \
///              properly initialized in the constructor.";
/// let output = aura_toon::caveman(input);
/// assert!(!output.contains("Sure!"));
/// assert!(!output.contains("I'd be happy to help"));
/// assert!(output.contains("function"));
/// assert!(output.contains("variable"));
/// ```
pub fn caveman(text: &str) -> String {
    let mut result = text.to_string();

    // Phase 1: Strip full pleasantry phrases (re-derive lowercase each pass)
    for phrase in STRIP_PHRASES {
        let phrase_lower = phrase.to_lowercase();
        if let Some(pos) = result.to_lowercase().find(&phrase_lower) {
            let end = pos + phrase.len();
            result = format!("{}{}", &result[..pos], &result[end..]);
        }
    }

    // Phase 2: Replace verbose phrases with short synonyms
    for (verbose, short) in REPLACE_PHRASES {
        let lower = result.to_lowercase();
        if let Some(pos) = lower.find(&verbose.to_lowercase()) {
            let end = pos + verbose.len();
            result = format!("{}{}{}", &result[..pos], short, &result[end..]);
        }
    }

    // Phase 3: Strip filler words (word-boundary aware)
    let words: Vec<&str> = result.split_whitespace().collect();
    let filtered: Vec<&str> = words
        .into_iter()
        .filter(|w| {
            let lower = w
                .trim_matches(|c: char| c.is_ascii_punctuation())
                .to_lowercase();
            !FILLER_WORDS.contains(&lower.as_str())
        })
        .collect();
    result = filtered.join(" ");

    // Phase 4: Clean up whitespace artifacts
    while result.contains("  ") {
        result = result.replace("  ", " ");
    }
    // Clean dangling punctuation
    result = result.replace(" .", ".").replace(" ,", ",");
    result = result.replace(". .", ".").replace(",,", ",");
    result = result.trim().to_string();

    // Strip leading/trailing punctuation-only fragments
    while result.starts_with('.') || result.starts_with(',') || result.starts_with('!') {
        result = result[1..].trim_start().to_string();
    }

    result
}

/// Pleasantry phrases stripped entirely (matched case-insensitively).
const STRIP_PHRASES: &[&str] = &[
    "I would be happy to help you with that.",
    "I'd be happy to help you with that.",
    "I'd be happy to help with that.",
    "I would be happy to help with that.",
    "I'd be happy to help!",
    "I'd be happy to help.",
    "Sure! I'd be happy to",
    "Sure, I'd be happy to",
    "Sure! I can help with that.",
    "Sure, I can help with that.",
    "Sure thing!",
    "Sure!",
    "Sure,",
    "Of course!",
    "Of course,",
    "Absolutely!",
    "Absolutely,",
    "Let me help you with that.",
    "I'll help you with that.",
    "Great question!",
    "That's a great question.",
    "Good question!",
    "Here's what I found:",
    "Here is what I found:",
    "Let me explain.",
    "Let me break this down.",
    "I hope this helps!",
    "I hope that helps!",
    "Hope this helps!",
    "Let me know if you have any questions.",
    "Let me know if you need anything else.",
    "Feel free to ask if you have any questions.",
    "Don't hesitate to ask.",
    "Happy to help further!",
    "Is there anything else I can help with?",
    "Is there anything else you need?",
];

/// Verbose → short phrase replacements.
const REPLACE_PHRASES: &[(&str, &str)] = &[
    ("in order to", "to"),
    ("due to the fact that", "because"),
    ("for the purpose of", "for"),
    ("in the event that", "if"),
    ("at this point in time", "now"),
    ("at the present time", "now"),
    ("on the other hand", "but"),
    ("in addition to", "plus"),
    ("as a result of", "from"),
    ("with regard to", "re"),
    ("with respect to", "re"),
    ("in terms of", "for"),
    ("a large number of", "many"),
    ("a significant amount of", "much"),
    ("it is important to note that", "note:"),
    ("it should be noted that", "note:"),
    ("it is worth mentioning that", "note:"),
    ("please note that", "note:"),
    ("as you can see", ""),
    ("as mentioned above", ""),
    ("as previously mentioned", ""),
    ("is currently not working", "fails"),
    ("is not working", "fails"),
    ("is currently failing", "fails"),
    ("does not work", "fails"),
    ("has not been", "wasn't"),
    ("have not been", "weren't"),
    ("is not able to", "can't"),
    ("are not able to", "can't"),
    ("was not able to", "couldn't"),
    ("it appears that", ""),
    ("it seems that", ""),
    ("it looks like", ""),
    ("I believe that", ""),
    ("I think that", ""),
    ("in my opinion", ""),
    ("basically what happens is", ""),
    ("what's happening here is", ""),
    ("the reason for this is", "reason:"),
    ("the issue here is that", "issue:"),
    ("the problem is that", "problem:"),
    ("make sure to", "must"),
    ("you need to make sure", "must"),
    ("you'll want to", ""),
    ("you might want to", ""),
    ("you should consider", "consider"),
    ("it would be a good idea to", "should"),
    ("properly initialized", "initialized"),
    ("correctly configured", "configured"),
    ("successfully completed", "completed"),
];

/// Single filler words stripped when they appear as standalone tokens.
const FILLER_WORDS: &[&str] = &[
    "the",
    "a",
    "an", // articles
    "just",
    "really",
    "very", // intensifiers
    "quite",
    "rather",
    "fairly",
    "somewhat",
    "actually",
    "basically",
    "essentially",
    "literally",
    "obviously",
    "clearly",
    "simply",
    "merely",
    "certainly",
    "definitely",
    "perhaps",
    "maybe",
    "possibly",
    "potentially",
    "presumably",
    "however",
    "furthermore",
    "moreover",
    "additionally",
    "consequently",
    "therefore",
    "thus",
    "hence",
    "accordingly",
    "please",
    "kindly",
    "respective",
    "corresponding",
];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_simple_object() {
        let val = json!({"name": "aura", "version": "0.4.0", "active": true});
        let toon = encode(&val);
        assert!(toon.contains("name: aura"));
        assert!(toon.contains("version: 0.4.0"));
        assert!(toon.contains("active: true"));
    }

    #[test]
    fn test_nested_object() {
        let val = json!({"server": {"name": "aura-vcs", "version": "1.0"}});
        let toon = encode(&val);
        assert!(toon.contains("server:\n"));
        assert!(toon.contains("  name: aura-vcs"));
    }

    #[test]
    fn test_tabular_array() {
        let val = json!({
            "snapshots": [
                {"file": "main.rs", "trigger": "watcher", "ts": 123},
                {"file": "lib.rs", "trigger": "mcp", "ts": 456}
            ]
        });
        let toon = encode(&val);
        assert!(toon.contains("snapshots[2]{file,trigger,ts}:"));
        assert!(toon.contains("main.rs,watcher,123"));
    }

    #[test]
    fn test_quoting() {
        let val = json!({"msg": "hello world: test"});
        let toon = encode(&val);
        assert!(toon.contains("\"hello world: test\""));
    }

    #[test]
    fn test_empty_object() {
        let val = json!({});
        let toon = encode(&val);
        assert_eq!(toon, "");
    }

    #[test]
    fn test_primitive_array() {
        let val = json!({"tags": ["rust", "git", "ai"]});
        let toon = encode(&val);
        assert!(toon.contains("tags[3]: rust,git,ai"));
    }

    // ── Caveman tests ──

    #[test]
    fn test_caveman_strips_pleasantries() {
        let input = "Sure! I'd be happy to help you with that. The function fails.";
        let output = caveman(input);
        assert!(!output.contains("Sure"));
        assert!(!output.contains("happy"));
        assert!(output.contains("function fails"));
    }

    #[test]
    fn test_caveman_replaces_verbose_phrases() {
        let input = "In order to fix the bug, due to the fact that the config is wrong.";
        let output = caveman(input);
        assert!(output.contains("to fix"));
        assert!(output.contains("because"));
        assert!(!output.contains("in order to"));
        assert!(!output.contains("due to the fact that"));
    }

    #[test]
    fn test_caveman_strips_filler_words() {
        let input = "The variable is actually just really not initialized.";
        let output = caveman(input);
        assert!(!output.contains("actually"));
        assert!(!output.contains("just"));
        assert!(!output.contains("really"));
        assert!(output.contains("variable"));
        assert!(output.contains("not initialized"));
    }

    #[test]
    fn test_caveman_preserves_technical_content() {
        let input = "HashMap<String, Vec<u8>> implements Clone and Send.";
        let output = caveman(input);
        assert!(output.contains("HashMap<String,"));
        assert!(output.contains("Clone"));
        assert!(output.contains("Send"));
    }

    #[test]
    fn test_caveman_empty_input() {
        assert_eq!(caveman(""), "");
    }

    #[test]
    fn test_caveman_token_reduction() {
        let verbose = "Sure! I'd be happy to help you with that. The function is currently \
                       not working because the variable has not been properly initialized \
                       in the constructor. In order to fix this, you need to make sure that \
                       the value is correctly configured before calling the method.";
        let terse = caveman(verbose);
        // Terse should be meaningfully shorter
        assert!(
            terse.len() < verbose.len() * 3 / 4,
            "Expected >25% reduction. Original: {} chars, caveman: {} chars",
            verbose.len(),
            terse.len()
        );
        // But must keep the technical content
        assert!(terse.contains("function"));
        assert!(terse.contains("variable"));
        assert!(terse.contains("constructor"));
    }
}
