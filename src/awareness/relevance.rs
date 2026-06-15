//! Relevance filtering — turns the awareness firehose into "only what touches
//! me". First pass: case-insensitive substring match on file path or symbol.
//! AURA-14 deepens this to callgraph-dependency intersection (an event on a
//! function you transitively call is relevant even if you never named it).

use super::model::AwarenessEvent;

/// Does `ev` intersect the given `focus` (a path fragment or symbol name)?
pub fn matches(ev: &AwarenessEvent, focus: &str) -> bool {
    let needle = focus.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return true;
    }
    let in_file = ev
        .file
        .as_deref()
        .is_some_and(|p| p.to_ascii_lowercase().contains(&needle));
    let in_symbol = ev
        .symbol
        .as_deref()
        .is_some_and(|s| s.to_ascii_lowercase().contains(&needle));
    in_file || in_symbol
}

/// Filter to events intersecting `focus`. With no focus, everything is relevant.
pub fn filter<'a>(events: &'a [AwarenessEvent], focus: Option<&str>) -> Vec<&'a AwarenessEvent> {
    match focus {
        None => events.iter().collect(),
        Some(f) => events.iter().filter(|e| matches(e, f)).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::awareness::model::AwarenessKind;

    fn ev(file: Option<&str>, symbol: Option<&str>) -> AwarenessEvent {
        AwarenessEvent {
            id: "i".into(),
            actor: "a".into(),
            is_agent: true,
            kind: AwarenessKind::Editing,
            repo: "r".into(),
            branch: "b".into(),
            file: file.map(String::from),
            symbol: symbol.map(String::from),
            intent: None,
            impact: None,
            ts: 0,
            key_id: None,
            sig: None,
        }
    }

    #[test]
    fn focus_matches_file_or_symbol_case_insensitively() {
        let e = ev(Some("src/Auth.rs"), Some("login"));
        assert!(matches(&e, "auth"));
        assert!(matches(&e, "LOGIN"));
        assert!(!matches(&e, "payments"));
    }

    #[test]
    fn no_focus_keeps_everything() {
        let events = vec![ev(Some("a.rs"), None), ev(None, Some("x"))];
        assert_eq!(filter(&events, None).len(), 2);
        assert_eq!(filter(&events, Some("a.rs")).len(), 1);
    }
}
