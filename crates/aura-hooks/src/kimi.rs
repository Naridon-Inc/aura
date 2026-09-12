//! Kimi's hooks.
//!
//! Kimi is the one CLI that keeps its hooks in its main config file rather
//! than a file of their own: `~/.kimi/config.toml` carries a top-level `hooks`
//! array beside the user's model, provider, theme and keybindings. So this
//! module edits a document that is overwhelmingly *not ours*, which is why it
//! goes through `toml_edit` rather than parse-and-reserialise — a round trip
//! through a plain TOML value would silently drop every comment and reorder
//! every table in the user's config.
//!
//! The entries are flat, one per hook, and the schema is `strict`: exactly
//! `event`, `command`, and optionally `matcher` and `timeout`. An extra key is
//! rejected — not ignored — which would take the user's whole hooks list down
//! with it.
//!
//! Kimi's payload is the odd one out: `toolName` / `toolInput` / `toolCallId`
//! in camelCase where everyone else uses snake_case. The shared script reads
//! both spellings, so nothing here has to care.

use toml_edit::{Array, ArrayOfTables, DocumentMut, InlineTable, Item, Value};

/// How long kimi will wait for the hook, in seconds.
///
/// The script backgrounds `aura log-intent` and returns immediately, so this
/// is a ceiling on a pathological machine rather than a budget. It exists at
/// all because the default is kimi's, not ours, and a hook that hangs holds up
/// the tool call the person is waiting on.
const TIMEOUT_SECS: i64 = 10;

/// Stamp the shared post-tool-use hook into `~/.kimi/config.toml`.
pub fn stamp_kimi_hooks() -> Option<()> {
    let mut path = crate::shared::existing_agent_dir(".kimi")?;
    let script_dir = crate::shared::stage_shared_scripts()?;
    path.push("config.toml");

    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc = text.parse::<DocumentMut>().ok()?;
    let command = crate::shared::hook_command(&script_dir, "Kimi");

    if merge_hooks(&mut doc, &command)? {
        std::fs::write(&path, doc.to_string()).ok()?;
    }
    Some(())
}

/// Put exactly one Aura entry in the document's `hooks` array.
///
/// Returns whether anything changed, so an already-correct config is not
/// rewritten — this file holds the user's own settings and rewriting it on
/// every repo-open would churn their editor and their backups for nothing.
///
/// Returns `None`, leaving the document untouched, when `hooks` exists as
/// something other than an array. That is a hand-edit we have no business
/// second-guessing.
fn merge_hooks(doc: &mut DocumentMut, command: &str) -> Option<bool> {
    if doc.get("hooks").is_none() {
        doc["hooks"] = Item::Value(Value::Array(Array::new()));
    }
    let mut list = match doc.get_mut("hooks")? {
        Item::Value(Value::Array(arr)) => HookList::Inline(arr),
        Item::ArrayOfTables(tables) => HookList::Tables(tables),
        _ => return None,
    };

    let mut kept_ours = false;
    let mut changed = false;
    let mut i = 0;
    while i < list.len() {
        match list.command_at(i) {
            // Ours, and already right: keep the first, drop any duplicate.
            Some(c) if c == command && !kept_ours => {
                kept_ours = true;
                i += 1;
            }
            // Ours, but stale — a rotated HOME, a renamed script, a second
            // copy. Left in place it points at a script that may not exist,
            // and kimi reports that on every tool call.
            Some(c) if c.contains(crate::shared::STAGED_DIR_MARKER) => {
                let _ = c;
                list.remove(i);
                changed = true;
            }
            // Somebody else's hook. Never touched.
            _ => i += 1,
        }
    }
    if !kept_ours {
        list.push_ours(command);
        changed = true;
    }
    Some(changed)
}

/// The two shapes a TOML array of hooks can have — `hooks = [{…}]`, which is
/// what kimi itself writes, and `[[hooks]]`, which a person editing by hand
/// might. Both are valid and both must survive a stamp.
enum HookList<'a> {
    Inline(&'a mut Array),
    Tables(&'a mut ArrayOfTables),
}

impl HookList<'_> {
    fn len(&self) -> usize {
        match self {
            HookList::Inline(a) => a.len(),
            HookList::Tables(t) => t.len(),
        }
    }

    fn command_at(&self, i: usize) -> Option<&str> {
        match self {
            HookList::Inline(a) => a.get(i)?.as_inline_table()?.get("command")?.as_str(),
            HookList::Tables(t) => t.get(i)?.get("command")?.as_str(),
        }
    }

    fn remove(&mut self, i: usize) {
        match self {
            HookList::Inline(a) => {
                a.remove(i);
            }
            HookList::Tables(t) => t.remove(i),
        }
    }

    fn push_ours(&mut self, command: &str) {
        match self {
            HookList::Inline(a) => a.push(Value::InlineTable(inline_entry(command))),
            HookList::Tables(t) => {
                let mut table = toml_edit::Table::new();
                table["event"] = toml_edit::value("PostToolUse");
                table["command"] = toml_edit::value(command);
                table["timeout"] = toml_edit::value(TIMEOUT_SECS);
                t.push(table);
            }
        }
    }
}

fn inline_entry(command: &str) -> InlineTable {
    // Only the three keys kimi's schema allows for an unmatched hook. It is
    // declared `strict`, so an extra key is a parse error for the whole array
    // rather than a field it ignores — every hook the user has would go with it.
    let mut t = InlineTable::new();
    t.insert("event", "PostToolUse".into());
    t.insert("command", command.into());
    t.insert("timeout", TIMEOUT_SECS.into());
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    const OURS: &str =
        "AURA_HOOK_AGENT=Kimi '/Users/real/.aura/plugins/aura-agent/scripts/on-post-tool-use.sh'";
    const STALE: &str =
        "AURA_HOOK_AGENT=Kimi '/tmp/gone/.aura/plugins/aura-agent/scripts/on-post-tool-use.sh'";

    fn parse(text: &str) -> DocumentMut {
        text.parse::<DocumentMut>().expect("valid toml")
    }

    #[test]
    fn the_rest_of_the_config_survives_untouched_comments_and_all() {
        // The reason this module uses toml_edit at all. `~/.kimi/config.toml`
        // is the user's config file — their model, their provider, their
        // theme — and Aura is a guest in it.
        let mut doc = parse(
            r#"# my settings
default_model = "kimi-code/kimi-for-coding"
hooks = []
theme = "dark"

[providers."managed:kimi-code"]
type = "kimi"
"#,
        );
        assert!(merge_hooks(&mut doc, OURS).unwrap());
        let out = doc.to_string();
        assert!(out.starts_with("# my settings\n"), "{out}");
        assert!(out.contains(r#"theme = "dark""#), "{out}");
        assert!(out.contains(r#"[providers."managed:kimi-code"]"#), "{out}");
        assert!(out.contains(OURS), "{out}");
    }

    #[test]
    fn an_already_correct_config_is_not_rewritten() {
        // Wiring runs on every repo-open. Reporting "changed" each time would
        // rewrite the user's config file several times a day for no change.
        let mut doc = parse("hooks = []\n");
        assert!(merge_hooks(&mut doc, OURS).unwrap());
        let once = doc.to_string();
        assert!(!merge_hooks(&mut doc, OURS).unwrap());
        assert_eq!(once, doc.to_string());
    }

    #[test]
    fn a_stale_stamp_is_replaced_not_joined() {
        let mut doc = parse(&format!(
            "hooks = [{{ event = \"PostToolUse\", command = \"{STALE}\", timeout = 10 }}]\n"
        ));
        assert!(merge_hooks(&mut doc, OURS).unwrap());
        let out = doc.to_string();
        assert!(!out.contains(STALE), "{out}");
        assert_eq!(out.matches("AURA_HOOK_AGENT=Kimi").count(), 1, "{out}");
    }

    #[test]
    fn somebody_elses_hook_is_left_exactly_where_it_is() {
        let mut doc = parse(
            r#"hooks = [{ event = "Stop", command = "/Users/real/bin/their-notify.sh" }]
"#,
        );
        assert!(merge_hooks(&mut doc, OURS).unwrap());
        let out = doc.to_string();
        assert!(out.contains("/Users/real/bin/their-notify.sh"), "{out}");
        assert!(out.contains(OURS), "{out}");
    }

    #[test]
    fn a_hand_written_array_of_tables_works_the_same_way() {
        let mut doc = parse("[[hooks]]\nevent = \"Stop\"\ncommand = \"/bin/theirs.sh\"\n");
        assert!(merge_hooks(&mut doc, OURS).unwrap());
        let out = doc.to_string();
        assert!(out.contains("/bin/theirs.sh"), "{out}");
        assert!(out.contains(OURS), "{out}");
        assert!(!merge_hooks(&mut doc, OURS).unwrap(), "{out}");
    }

    #[test]
    fn a_hooks_key_that_is_not_a_list_is_refused() {
        let mut doc = parse("hooks = \"please don't\"\n");
        let before = doc.to_string();
        assert!(merge_hooks(&mut doc, OURS).is_none());
        assert_eq!(before, doc.to_string());
    }

    #[test]
    fn a_config_with_no_hooks_key_gains_one() {
        let mut doc = parse("theme = \"dark\"\n");
        assert!(merge_hooks(&mut doc, OURS).unwrap());
        assert!(doc.to_string().contains(OURS));
    }

    #[test]
    fn the_entry_carries_only_the_keys_the_strict_schema_allows() {
        // Kimi validates hook entries with a `strict` object schema: an extra
        // key fails the whole array, taking the user's other hooks with it.
        let mut doc = parse("hooks = []\n");
        merge_hooks(&mut doc, OURS).unwrap();
        let entry = doc["hooks"].as_array().unwrap().get(0).unwrap();
        let keys: Vec<&str> = entry
            .as_inline_table()
            .unwrap()
            .iter()
            .map(|(k, _)| k)
            .collect();
        assert_eq!(keys, vec!["event", "command", "timeout"]);
    }
}
