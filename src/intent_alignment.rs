//! Does the reason on record belong to the change being committed?
//!
//! The commit hook has always asked this, and has always answered it by
//! looking for the function's name inside the message. That rule has the
//! wrong shape. It passes `git commit -m "monthly_total"`, which says
//! nothing, and blocks "round the total to cents so invoices stop
//! disagreeing with the bank", which says everything — the exact sentence
//! Aura's own guidance asks people to write instead of naming mechanics.
//! Then it tells them, in green, to go and paste the identifier in.
//!
//! Naming the symbol is still good evidence. It is just not the only
//! evidence, and it was never the strongest. The strongest is a scope the
//! author declared on purpose: `aura log-intent --writes src/billing.py`
//! says *this reason covers this file*, and a separate check already
//! refuses the commit when the staged files stray outside it. Having
//! accepted that declaration, demanding the function name on top of it is
//! asking the same question twice and failing the honest answer.
//!
//! So: the symbol, the file, or a declared scope that covers what is
//! staged. Any one of the three connects a reason to a change. None of
//! them requires anyone to write worse prose.

/// The reason as the hook has it, from every place it looks.
#[derive(Debug, Default, Clone)]
pub struct Stated {
    /// Commit message, scraped agent transcript — whatever the hook assembled.
    pub text: String,
    /// The most recent `aura log-intent` row, when one was logged for this
    /// commit. Kept apart from `text` because the hook prefers the commit
    /// message and would otherwise never read this at all.
    pub logged: Option<String>,
    /// Files that row declared it covers (`--writes`).
    pub declared_paths: Vec<String>,
}

impl Stated {
    /// Every word of the reason, lowercased, from both places it is kept.
    /// Other gates search the reason for a name too; they should be
    /// searching all of it.
    pub fn searchable(&self) -> String {
        let mut h = self.text.to_lowercase();
        if let Some(logged) = &self.logged {
            h.push('\n');
            h.push_str(&logged.to_lowercase());
        }
        h
    }
}

/// What connects the reason to the change, if anything does.
#[derive(Debug, Clone, PartialEq)]
pub enum Alignment {
    /// The reason names something that changed.
    NamesTheSymbol(String),
    /// The reason was logged against the files that are staged.
    DeclaredTheseFiles,
    /// The reason names a file that changed.
    NamesTheFile(String),
    /// Nothing ties the two together.
    Unrelated,
}

impl Alignment {
    pub fn is_aligned(&self) -> bool {
        !matches!(self, Alignment::Unrelated)
    }

    /// One line saying what was accepted, for the trail the hook prints.
    pub fn reason(&self) -> String {
        match self {
            Alignment::NamesTheSymbol(s) => format!("the reason names {s}"),
            Alignment::DeclaredTheseFiles => {
                "the reason was logged against exactly these files".to_string()
            }
            Alignment::NamesTheFile(f) => format!("the reason names {f}"),
            Alignment::Unrelated => "nothing ties the reason to the change".to_string(),
        }
    }
}

/// Does `stated` belong to a change that touched `symbols` in `files`?
pub fn align(stated: &Stated, symbols: &[String], files: &[String]) -> Alignment {
    let haystack = stated.searchable();

    for symbol in symbols {
        if mentions(&haystack, symbol) {
            return Alignment::NamesTheSymbol(symbol.clone());
        }
    }

    if covers(&stated.declared_paths, files) {
        return Alignment::DeclaredTheseFiles;
    }

    for file in files {
        for name in file_names(file) {
            if mentions(&haystack, &name) {
                return Alignment::NamesTheFile(file.clone());
            }
        }
    }

    Alignment::Unrelated
}

/// Whole-word match, so `s` does not match every sentence and `total` does
/// not match `subtotal`.
fn mentions(haystack_lower: &str, needle: &str) -> bool {
    let needle = needle.trim().to_lowercase();
    if needle.is_empty() {
        return false;
    }
    let pattern = format!(r"\b{}\b", regex::escape(&needle));
    regex::Regex::new(&pattern)
        .map(|re| re.is_match(haystack_lower))
        .unwrap_or(false)
}

/// The ways a person might write a path: as given, without directories,
/// and without the extension.
fn file_names(path: &str) -> Vec<String> {
    let norm = normalize(path);
    let mut out = vec![norm.clone()];
    if let Some(base) = norm.rsplit('/').next() {
        if base != norm {
            out.push(base.to_string());
        }
        if let Some(stem) = base.rsplit_once('.').map(|(s, _)| s) {
            // A one-letter stem is noise, not a reference to the file.
            if stem.len() > 2 {
                out.push(stem.to_string());
            }
        }
    }
    out
}

/// Did the author declare a scope that holds every staged file?
///
/// An empty declaration is not a scope covering everything — it is the
/// absence of one, and must not pass.
fn covers(declared: &[String], files: &[String]) -> bool {
    if declared.is_empty() || files.is_empty() {
        return false;
    }
    let declared: Vec<String> = declared.iter().map(|p| normalize(p)).collect();
    files
        .iter()
        .map(|f| normalize(f))
        .all(|f| declared.contains(&f))
}

fn normalize(path: &str) -> String {
    path.trim()
        .trim_start_matches("./")
        .replace('\\', "/")
        .to_lowercase()
}

/// What to tell someone whose reason does not connect to their change.
///
/// Not "paste the function name into your commit message": that is how the
/// check is implemented, not what it is for, and following it makes the
/// commit log worse. Say the two things that actually connect a reason to
/// a change, and let them pick.
pub fn how_to_connect(symbols: &[String], files: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    out.push(format!(
        "What changed: {}",
        if symbols.is_empty() {
            files.join(", ")
        } else {
            symbols.join(", ")
        }
    ));
    out.push(
        "Either say which file the change is in, as part of your reason — a sentence \
         that mentions it counts."
            .to_string(),
    );
    let example = files.first().cloned().unwrap_or_else(|| "src/file.py".into());
    out.push(format!(
        "Or record the reason against the files it covers: aura log-intent --writes {example} \"<why>\""
    ));
    out.push(
        "You do not have to name the function. A reason that says why is worth more \
         than one that repeats what the diff already shows."
            .to_string(),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stated(text: &str) -> Stated {
        Stated {
            text: text.to_string(),
            ..Default::default()
        }
    }

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn naming_what_changed_still_counts() {
        let a = align(
            &stated("Refactored monthly_total"),
            &v(&["monthly_total"]),
            &v(&["src/billing.py"]),
        );
        assert_eq!(a, Alignment::NamesTheSymbol("monthly_total".into()));
    }

    #[test]
    fn a_reason_that_says_why_is_no_longer_refused_for_saying_it_well() {
        // The sentence Aura's own guidance asks for. The old rule blocked
        // it and told the author to write "Refactored monthly_total".
        let s = Stated {
            text: "round totals to cents".into(),
            logged: Some(
                "round the total to cents so invoices stop disagreeing with the bank".into(),
            ),
            declared_paths: v(&["src/billing.py"]),
        };
        let a = align(&s, &v(&["monthly_total"]), &v(&["src/billing.py"]));
        assert_eq!(a, Alignment::DeclaredTheseFiles);
        assert!(a.is_aligned());
    }

    #[test]
    fn the_logged_reason_is_read_even_when_a_commit_message_exists() {
        // The hook prefers the commit message and used to judge that alone,
        // so a carefully logged intent went unread.
        let s = Stated {
            text: "wip".into(),
            logged: Some("stop monthly_total rounding down".into()),
            ..Default::default()
        };
        let a = align(&s, &v(&["monthly_total"]), &v(&["src/billing.py"]));
        assert_eq!(a, Alignment::NamesTheSymbol("monthly_total".into()));
    }

    #[test]
    fn naming_the_file_connects_the_reason_to_the_change() {
        let a = align(
            &stated("billing was rounding down and the bank noticed"),
            &v(&["monthly_total"]),
            &v(&["src/billing.py"]),
        );
        assert_eq!(a, Alignment::NamesTheFile("src/billing.py".into()));
    }

    #[test]
    fn a_declared_scope_must_hold_every_staged_file() {
        // Declaring one file does not vouch for a second one that slipped in.
        let s = Stated {
            text: "cleanup".into(),
            declared_paths: v(&["src/billing.py"]),
            ..Default::default()
        };
        let a = align(&s, &v(&["helper"]), &v(&["src/billing.py", "src/auth.py"]));
        assert_eq!(a, Alignment::Unrelated);
    }

    #[test]
    fn declaring_nothing_is_not_declaring_everything() {
        let a = align(&stated("cleanup"), &v(&["helper"]), &v(&["src/billing.py"]));
        assert_eq!(a, Alignment::Unrelated);
    }

    #[test]
    fn paths_that_differ_only_in_shape_are_the_same_file() {
        let s = Stated {
            text: "cleanup".into(),
            declared_paths: v(&["./src/Billing.py"]),
            ..Default::default()
        };
        let a = align(&s, &v(&["helper"]), &v(&["src/billing.py"]));
        assert_eq!(a, Alignment::DeclaredTheseFiles);
    }

    #[test]
    fn a_word_that_merely_contains_the_name_is_not_a_mention() {
        let a = align(
            &stated("subtotal handling reworked"),
            &v(&["total"]),
            &v(&["src/x.py"]),
        );
        assert_eq!(a, Alignment::Unrelated);
    }

    #[test]
    fn the_advice_stops_asking_for_worse_commit_messages() {
        let lines = how_to_connect(&v(&["monthly_total"]), &v(&["src/billing.py"])).join(" ");
        assert!(lines.contains("aura log-intent --writes src/billing.py"));
        assert!(lines.contains("do not have to name the function"));
        assert!(
            !lines.to_lowercase().contains("exact names"),
            "the old instruction was to paste identifiers into the message"
        );
    }
}
