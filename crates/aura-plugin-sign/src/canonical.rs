//! Canonical JSON serialization for the manifest leg of the digest.
//!
//! We cannot rely on `serde_json::to_string` ordering: Tauri enables
//! serde_json's `preserve_order` feature workspace-wide, which swaps
//! `Map` to insertion-ordered — so the same logical manifest would
//! serialize differently depending on the order keys appear in the
//! file. This walker is deterministic regardless of features: object
//! keys sorted bytewise, compact separators, strings/numbers emitted
//! through serde_json's own escaping/formatting.

use serde_json::Value;

/// Deterministic, compact JSON: object keys sorted bytewise at every
/// depth. Arrays keep their order (order is semantic in JSON arrays).
pub fn canonical_json(v: &Value) -> String {
    let mut out = String::new();
    write_canonical(v, &mut out);
    out
}

fn write_canonical(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        // serde_json::Number's Display is deterministic for a given
        // parsed value (integers verbatim, floats via ryu shortest).
        Value::Number(n) => out.push_str(&n.to_string()),
        // serde_json escaping is deterministic and locale-free.
        Value::String(s) => {
            out.push_str(&serde_json::to_string(s).expect("string serialization is infallible"))
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(
                    &serde_json::to_string(key).expect("string serialization is infallible"),
                );
                out.push(':');
                write_canonical(&map[key.as_str()], out);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_object_keys_at_every_depth() {
        let a: Value = serde_json::from_str(r#"{"b": {"z": 1, "a": 2}, "a": 3}"#).unwrap();
        assert_eq!(canonical_json(&a), r#"{"a":3,"b":{"a":2,"z":1}}"#);
    }

    #[test]
    fn key_order_in_source_is_irrelevant() {
        let a: Value = serde_json::from_str(r#"{"x": 1, "y": [true, null]}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"y": [true, null], "x": 1}"#).unwrap();
        assert_eq!(canonical_json(&a), canonical_json(&b));
    }

    #[test]
    fn arrays_keep_order() {
        let v = json!(["b", "a"]);
        assert_eq!(canonical_json(&v), r#"["b","a"]"#);
    }

    #[test]
    fn strings_are_json_escaped() {
        let v = json!({"k": "line\nbreak \"quote\""});
        assert_eq!(canonical_json(&v), r#"{"k":"line\nbreak \"quote\""}"#);
    }

    #[test]
    fn numbers_roundtrip() {
        let v: Value = serde_json::from_str(r#"{"i": 42, "f": 1.5, "neg": -7}"#).unwrap();
        assert_eq!(canonical_json(&v), r#"{"f":1.5,"i":42,"neg":-7}"#);
    }
}
