//! `aura routine …` — runs that start without anyone present.
//!
//! The gap this closes: everything else in this CLI needs a person or an agent
//! to be holding the session. A routine is a saved prompt plus the condition
//! that starts it — a schedule, a webhook, or just you typing
//! `aura routine run`.
//!
//! ## The trigger mini-syntax lives here, not on the server
//!
//! `--trigger weekdays@09:00` is translated into the
//! `{ "kind": "schedule", "config": { "days": [1,2,3,4,5], "at": "09:00" } }`
//! the API takes, before the request goes out. Two reasons it is on this side:
//! a typo becomes a usage error (exit 2) with nothing attempted, instead of a
//! 400 after a round trip; and the server keeps one input format, so a second
//! client cannot invent a third spelling of Monday.
//!
//! Forms, all of which may be repeated — several triggers on one routine is
//! the common case, not an exotic one:
//!
//! ```text
//!   --trigger weekdays@09:00          Mon–Fri at 09:00
//!   --trigger daily@07:30             every day
//!   --trigger weekends@11:00          Sat and Sun
//!   --trigger mon,wed,fri@18:00       the days you name
//!   --trigger webhook                 any event posted to the URL
//!   --trigger "webhook:label is deploy, author is not dependabot[bot]"
//! ```
//!
//! ## The webhook URL is printed once
//!
//! `create` and `rotate-secret` are the only calls that can print it; the
//! server stores a hash and genuinely cannot produce it again. That is said in
//! the output rather than only in the docs, because the person who needs to
//! know is the one looking at the terminal.
//!
//! Exits on [`crate::cloud_contract::ExitCode`] like every other cloud noun.

use clap::Subcommand;
use serde_json::{json, Value};

use crate::cloud_contract::ExitCode;
use crate::workspace_api::client::Client;
use crate::workspace_api::output;

/// Scheduled and webhook-triggered agent runs. Auth: `AURA_API_KEY`, else the
/// signed-in token.
#[derive(Subcommand, Debug, Clone)]
pub enum RoutineCmd {
    /// Create a routine.
    Create {
        /// What to call it. Unique per org, so a name is enough to find it
        /// again.
        name: String,
        /// The repo its workspaces open on — `owner/name` or the repo id.
        #[arg(long)]
        repo: Option<String>,
        /// Which agent runs it. Defaults to the same agent a hand-made
        /// workspace gets.
        #[arg(long)]
        agent: Option<String>,
        #[arg(long)]
        model: Option<String>,
        /// Reasoning effort, when the model takes one.
        #[arg(long)]
        effort: Option<String>,
        /// The first message every run sends.
        #[arg(long)]
        prompt: Option<String>,
        /// Read the prompt from a file, or from stdin with `-`. For the
        /// paragraph-long prompts that do not survive a shell quote.
        #[arg(long, conflicts_with = "prompt")]
        prompt_file: Option<String>,
        /// What starts it. Repeatable; see the module docs for the forms.
        #[arg(long = "trigger")]
        triggers: Vec<String>,
        /// The offset every `--trigger` schedule is read in: `UTC`, or a fixed
        /// offset like `+05:30`. Named zones are refused — there is no
        /// timezone database on the server, so honouring one would mean
        /// guessing at daylight saving.
        #[arg(long)]
        tz: Option<String>,
        /// Create it switched off: a draft that no schedule and no webhook
        /// will start, but `aura routine run` still will.
        #[arg(long)]
        disabled: bool,
        #[arg(long)]
        json: bool,
    },
    /// List your routines.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Show one routine in full, triggers included.
    Get {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Fire a routine now. Works on a disabled one — switching a routine off
    /// stops its triggers, not you.
    Run {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Mint a new webhook URL. The old one stops working immediately.
    RotateSecret {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Delete a routine. The workspaces its runs opened are untouched.
    Delete {
        id: String,
        #[arg(long)]
        json: bool,
    },
}

/// Translate one `--trigger` into the `{ kind, config }` the API takes.
///
/// `tz` is applied to schedules only, and only when the caller gave one, so a
/// routine created without `--tz` stores the server's default (`UTC`) rather
/// than this process's idea of local time — which would make the same command
/// mean different things on two laptops.
pub fn parse_trigger(spec: &str, tz: Option<&str>) -> Result<Value, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("a --trigger needs a value".to_string());
    }

    // `webhook`, bare or with filters after the colon.
    let lowered = spec.to_lowercase();
    if lowered == "webhook" {
        return Ok(json!({ "kind": "webhook", "config": {} }));
    }
    if let Some(rest) = lowered
        .strip_prefix("webhook:")
        .map(|_| &spec[spec.find(':').unwrap() + 1..])
    {
        return Ok(json!({ "kind": "webhook", "config": { "filters": parse_filters(rest)? } }));
    }

    // `schedule:` is accepted but never required: a trigger with an `@` in it
    // is a time of day and nothing else, so demanding the prefix would be
    // ceremony.
    let body = match spec.find(':') {
        Some(i) if lowered.starts_with("schedule:") => &spec[i + 1..],
        _ => spec,
    };
    let (days, at) = body
        .trim()
        .split_once('@')
        .ok_or_else(|| format!("`{spec}` is not a trigger — try weekdays@09:00, or webhook"))?;

    let at = at.trim();
    check_time_of_day(at)?;
    let mut config = json!({ "days": parse_days(days)?, "at": at });
    if let Some(tz) = tz.map(str::trim).filter(|t| !t.is_empty()) {
        check_offset(tz)?;
        config["tz"] = json!(tz);
    }
    Ok(json!({ "kind": "schedule", "config": config }))
}

/// The same `HH:MM` rule the server enforces, checked here as well.
///
/// Deliberate duplication. The server stays the authority — it has to, since
/// it takes requests from clients this binary knows nothing about — but a
/// caller who typed `9:00` should not have to make a network round trip, hand
/// over a credential and read a 400 to find out. Caught here it is a usage
/// error with nothing attempted, which is what exit 2 means.
fn check_time_of_day(at: &str) -> Result<(), String> {
    let bad = || format!("`{at}` is not a time of day — use HH:MM, like 09:00");
    let (h, m) = at.split_once(':').ok_or_else(bad)?;
    if h.len() != 2 || m.len() != 2 {
        return Err(bad());
    }
    let hour: u32 = h.parse().map_err(|_| bad())?;
    let minute: u32 = m.parse().map_err(|_| bad())?;
    if hour > 23 || minute > 59 {
        return Err(format!("there is no time of day at {at}"));
    }
    Ok(())
}

/// `UTC` or `±HH:MM`, checked locally for the same reason.
fn check_offset(tz: &str) -> Result<(), String> {
    if tz.eq_ignore_ascii_case("utc") || tz.eq_ignore_ascii_case("z") {
        return Ok(());
    }
    let rest = tz
        .strip_prefix('+')
        .or_else(|| tz.strip_prefix('-'))
        .ok_or_else(|| {
            format!(
                "`{tz}` is not a timezone this server can read — use UTC or a fixed offset like \
                 +05:30. Named zones are not supported: there is no timezone database on the \
                 server, so honouring one would mean guessing at daylight saving."
            )
        })?;
    let (h, m) = rest
        .split_once(':')
        .ok_or_else(|| format!("`{tz}` is not an offset — use ±HH:MM, like +05:30"))?;
    let hours: u32 = h
        .parse()
        .map_err(|_| format!("`{tz}` is not an offset — use ±HH:MM, like +05:30"))?;
    let minutes: u32 = m
        .parse()
        .map_err(|_| format!("`{tz}` is not an offset — use ±HH:MM, like +05:30"))?;
    if hours > 14 || minutes > 59 {
        return Err(format!("`{tz}` is not a real offset"));
    }
    Ok(())
}

/// `weekdays`, `mon,wed,fri`, `daily` → ISO weekday numbers.
fn parse_days(spec: &str) -> Result<Vec<u32>, String> {
    const NAMES: [(&str, u32); 7] = [
        ("mon", 1),
        ("tue", 2),
        ("wed", 3),
        ("thu", 4),
        ("fri", 5),
        ("sat", 6),
        ("sun", 7),
    ];
    let spec = spec.trim().to_lowercase();
    match spec.as_str() {
        "weekdays" | "weekday" => return Ok(vec![1, 2, 3, 4, 5]),
        "weekends" | "weekend" => return Ok(vec![6, 7]),
        "daily" | "everyday" | "every-day" | "all" => return Ok(vec![1, 2, 3, 4, 5, 6, 7]),
        "" => return Err("a schedule needs days — try weekdays@09:00".to_string()),
        _ => {}
    }
    let mut days = Vec::new();
    for token in spec.split(',') {
        let token = token.trim();
        // Three letters is the match, so `monday` and `mon` are the same day
        // and nobody has to remember which spelling this CLI wanted.
        let found = NAMES
            .iter()
            .find(|(name, _)| token.starts_with(name))
            .map(|(_, n)| *n)
            .ok_or_else(|| {
                format!("`{token}` is not a day — use mon…sun, or weekdays, weekends, daily")
            })?;
        if !days.contains(&found) {
            days.push(found);
        }
    }
    days.sort_unstable();
    Ok(days)
}

/// `label is deploy, author is not dependabot[bot]` → the filter object the
/// API validates.
fn parse_filters(spec: &str) -> Result<Value, String> {
    let mut out = serde_json::Map::new();
    for clause in spec.split(',') {
        let clause = clause.trim();
        if clause.is_empty() {
            continue;
        }
        // "is not" is checked first: "author is not x" also contains " is ",
        // and matching that one would read the value as "not x".
        let (field, negated, value) = if let Some((f, v)) = clause.split_once(" is not ") {
            (f, true, v)
        } else if let Some((f, v)) = clause.split_once(" is ") {
            (f, false, v)
        } else if let Some(f) = clause.strip_suffix(" is not") {
            // The operator is there and the value is not. Trailing whitespace
            // is already gone by now, so this is the only shape "label is  "
            // can still arrive in — and it is a missing value, not a clause
            // nobody can parse.
            (f, true, "")
        } else if let Some(f) = clause.strip_suffix(" is") {
            (f, false, "")
        } else {
            return Err(format!(
                "`{clause}` is not a filter — write it as `label is deploy` or `base is not main`"
            ));
        };
        let field = field.trim().to_lowercase();
        let value = value.trim();
        if value.is_empty() {
            return Err(format!("the `{field}` filter needs a value"));
        }
        out.insert(
            field,
            json!({ "op": if negated { "is not" } else { "is" }, "value": value }),
        );
    }
    if out.is_empty() {
        return Err("`webhook:` with nothing after it — drop the colon for any event".to_string());
    }
    Ok(Value::Object(out))
}

/// The prompt, from `--prompt`, a file, or stdin.
fn read_prompt(prompt: &Option<String>, prompt_file: &Option<String>) -> Result<String, String> {
    if let Some(p) = prompt.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        return Ok(p.to_string());
    }
    let Some(path) = prompt_file.as_deref().map(str::trim).filter(|p| !p.is_empty()) else {
        return Err("a routine needs a --prompt (or --prompt-file)".to_string());
    };
    let body = if path == "-" {
        use std::io::Read;
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| format!("could not read the prompt from stdin: {e}"))?;
        buf
    } else {
        std::fs::read_to_string(path).map_err(|e| format!("could not read {path}: {e}"))?
    };
    let body = body.trim();
    if body.is_empty() {
        return Err(format!("{path} is empty — there is no prompt in it"));
    }
    Ok(body.to_string())
}

/// Run a verb; returns the process exit code.
pub fn run(cmd: &RoutineCmd) -> i32 {
    let client = match Client::from_env() {
        Ok(c) => c,
        Err(e) => {
            output::print_error(&e);
            return e.exit_code();
        }
    };

    let (result, render): (_, fn(&Value) -> String) = match cmd {
        RoutineCmd::Create {
            name,
            repo,
            agent,
            model,
            effort,
            prompt,
            prompt_file,
            triggers,
            tz,
            disabled,
            ..
        } => {
            let name = name.trim();
            if name.is_empty() {
                eprintln!("  ✗ a routine needs a name");
                return ExitCode::Usage.code();
            }
            let body = match read_prompt(prompt, prompt_file) {
                Ok(b) => b,
                Err(why) => {
                    eprintln!("  ✗ {why}");
                    return ExitCode::Usage.code();
                }
            };
            let mut parsed = Vec::new();
            for spec in triggers {
                match parse_trigger(spec, tz.as_deref()) {
                    Ok(t) => parsed.push(t),
                    Err(why) => {
                        eprintln!("  ✗ {why}");
                        return ExitCode::Usage.code();
                    }
                }
            }
            // No trigger is allowed, and said out loud rather than refused: a
            // routine you fire by hand is a real thing to want, and the
            // alternative is making somebody invent a schedule they will then
            // have to remember to ignore.
            if parsed.is_empty() {
                eprintln!("  note: no --trigger, so this routine runs only when you run it");
            }
            (
                client.create_routine(
                    name,
                    repo.as_deref(),
                    agent.as_deref(),
                    model.as_deref(),
                    effort.as_deref(),
                    &body,
                    !*disabled,
                    &parsed,
                ),
                output::render_routine as fn(&Value) -> String,
            )
        }
        RoutineCmd::List { .. } => (client.routines(), output::render_routines),
        RoutineCmd::Get { id, .. } => (client.routine(id), output::render_routine),
        RoutineCmd::Run { id, .. } => (client.run_routine(id), output::render_fired_routine),
        RoutineCmd::RotateSecret { id, .. } => (
            client.rotate_routine_secret(id),
            output::render_rotated_secret,
        ),
        RoutineCmd::Delete { id, .. } => {
            (client.delete_routine(id), output::render_deleted_routine)
        }
    };

    let json = match cmd {
        RoutineCmd::Create { json, .. }
        | RoutineCmd::List { json, .. }
        | RoutineCmd::Get { json, .. }
        | RoutineCmd::Run { json, .. }
        | RoutineCmd::RotateSecret { json, .. }
        | RoutineCmd::Delete { json, .. } => *json,
    };

    match result {
        Ok(v) => {
            output::emit(json, &v, render);
            ExitCode::Success.code()
        }
        Err(e) => {
            output::print_error(&e);
            e.exit_code()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weekdays_is_monday_to_friday() {
        let t = parse_trigger("weekdays@09:00", None).unwrap();
        assert_eq!(t["kind"], "schedule");
        assert_eq!(t["config"]["days"], json!([1, 2, 3, 4, 5]));
        assert_eq!(t["config"]["at"], "09:00");
    }

    #[test]
    fn the_presets_cover_what_people_actually_schedule() {
        assert_eq!(
            parse_trigger("weekends@11:00", None).unwrap()["config"]["days"],
            json!([6, 7])
        );
        assert_eq!(
            parse_trigger("daily@07:30", None).unwrap()["config"]["days"],
            json!([1, 2, 3, 4, 5, 6, 7])
        );
    }

    #[test]
    fn named_days_are_sorted_and_deduplicated_so_the_order_typed_does_not_matter() {
        let t = parse_trigger("fri,mon,mon,wed@18:00", None).unwrap();
        assert_eq!(t["config"]["days"], json!([1, 3, 5]));
    }

    #[test]
    fn a_long_day_name_is_the_same_day_as_its_abbreviation() {
        assert_eq!(
            parse_trigger("monday,wednesday@08:00", None).unwrap()["config"]["days"],
            json!([1, 3])
        );
    }

    #[test]
    fn the_schedule_prefix_is_accepted_but_never_required() {
        let bare = parse_trigger("weekdays@09:00", None).unwrap();
        let prefixed = parse_trigger("schedule:weekdays@09:00", None).unwrap();
        assert_eq!(bare, prefixed);
    }

    #[test]
    fn a_timezone_is_attached_only_when_one_was_given() {
        let without = parse_trigger("weekdays@09:00", None).unwrap();
        assert!(without["config"].get("tz").is_none(), "{without}");
        let with = parse_trigger("weekdays@09:00", Some("+05:30")).unwrap();
        assert_eq!(with["config"]["tz"], "+05:30");
        // An empty --tz is the same as not passing one, not a tz of "".
        let empty = parse_trigger("weekdays@09:00", Some("  ")).unwrap();
        assert!(empty["config"].get("tz").is_none(), "{empty}");
    }

    #[test]
    fn a_time_that_is_not_hh_mm_is_caught_here_rather_than_by_a_round_trip() {
        for bad in ["9:00", "09:0", "0900", "nine"] {
            let err = parse_trigger(&format!("weekdays@{bad}"), None).unwrap_err();
            assert!(err.contains("use HH:MM"), "`{bad}` → {err}");
        }
        let err = parse_trigger("weekdays@25:00", None).unwrap_err();
        assert!(err.contains("no time of day"), "{err}");
        assert!(parse_trigger("weekdays@00:00", None).is_ok());
        assert!(parse_trigger("weekdays@23:59", None).is_ok());
    }

    #[test]
    fn a_named_timezone_is_caught_here_too_with_the_reason() {
        let err = parse_trigger("weekdays@09:00", Some("Europe/Berlin")).unwrap_err();
        assert!(err.contains("Named zones are not supported"), "{err}");
        let err = parse_trigger("weekdays@09:00", Some("+0530")).unwrap_err();
        assert!(err.contains("±HH:MM"), "{err}");
        assert!(parse_trigger("weekdays@09:00", Some("UTC")).is_ok());
        assert!(parse_trigger("weekdays@09:00", Some("-04:00")).is_ok());
    }

    #[test]
    fn a_day_nobody_recognises_is_refused_with_the_vocabulary() {
        let err = parse_trigger("funday@09:00", None).unwrap_err();
        assert!(err.contains("`funday` is not a day"), "{err}");
        assert!(err.contains("weekdays"), "{err}");
    }

    #[test]
    fn something_that_is_not_a_trigger_at_all_says_what_one_looks_like() {
        let err = parse_trigger("every morning", None).unwrap_err();
        assert!(err.contains("weekdays@09:00"), "{err}");
        assert!(parse_trigger("   ", None).is_err());
    }

    #[test]
    fn a_bare_webhook_filters_nothing() {
        let t = parse_trigger("webhook", None).unwrap();
        assert_eq!(t["kind"], "webhook");
        assert_eq!(t["config"], json!({}));
        // And the kind is read case-insensitively, since it comes off a shell.
        assert_eq!(parse_trigger("WEBHOOK", None).unwrap()["kind"], "webhook");
    }

    #[test]
    fn webhook_filters_become_the_object_the_api_validates() {
        let t = parse_trigger("webhook:label is deploy", None).unwrap();
        assert_eq!(
            t["config"]["filters"]["label"],
            json!({ "op": "is", "value": "deploy" })
        );
    }

    #[test]
    fn is_not_is_matched_before_is_so_the_value_is_not_read_as_not_x() {
        let t = parse_trigger("webhook:author is not dependabot[bot]", None).unwrap();
        assert_eq!(
            t["config"]["filters"]["author"],
            json!({ "op": "is not", "value": "dependabot[bot]" })
        );
    }

    #[test]
    fn several_filters_on_one_webhook_are_comma_separated() {
        let t = parse_trigger(
            "webhook:base is main, author is not dependabot[bot], label is deploy",
            None,
        )
        .unwrap();
        let f = &t["config"]["filters"];
        assert_eq!(f["base"]["value"], "main");
        assert_eq!(f["author"]["op"], "is not");
        assert_eq!(f["label"]["value"], "deploy");
    }

    #[test]
    fn a_filter_value_keeps_the_case_it_was_typed_in_even_though_the_field_does_not() {
        // The field is a fixed vocabulary, so it is lowercased; the value is a
        // label or a username somebody else chose, so it is left alone.
        let t = parse_trigger("webhook:LABEL is Needs-Review", None).unwrap();
        assert_eq!(t["config"]["filters"]["label"]["value"], "Needs-Review");
    }

    #[test]
    fn a_filter_that_is_not_a_filter_says_how_one_is_written() {
        let err = parse_trigger("webhook:label=deploy", None).unwrap_err();
        assert!(err.contains("`label is deploy`"), "{err}");
    }

    #[test]
    fn a_filter_with_no_value_is_refused_rather_than_sent_empty() {
        let err = parse_trigger("webhook:label is   ", None).unwrap_err();
        assert!(err.contains("needs a value"), "{err}");
    }

    #[test]
    fn a_webhook_colon_with_nothing_after_it_points_at_the_bare_form() {
        let err = parse_trigger("webhook:", None).unwrap_err();
        assert!(err.contains("drop the colon"), "{err}");
    }

    #[test]
    fn a_prompt_can_come_from_the_flag_or_a_file_and_neither_is_not_allowed() {
        assert_eq!(
            read_prompt(&Some("  triage the failures  ".into()), &None).unwrap(),
            "triage the failures"
        );
        assert!(read_prompt(&None, &None).unwrap_err().contains("--prompt"));
        assert!(read_prompt(&Some("   ".into()), &None)
            .unwrap_err()
            .contains("--prompt"));

        let dir = std::env::temp_dir().join(format!("aura-routine-{}", uuid_like()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("prompt.txt");
        std::fs::write(&path, "  read the release notes\n").unwrap();
        assert_eq!(
            read_prompt(&None, &Some(path.to_string_lossy().to_string())).unwrap(),
            "read the release notes"
        );

        let empty = dir.join("empty.txt");
        std::fs::write(&empty, "   \n").unwrap();
        let err = read_prompt(&None, &Some(empty.to_string_lossy().to_string())).unwrap_err();
        assert!(err.contains("is empty"), "{err}");

        let missing = dir.join("nope.txt");
        let err = read_prompt(&None, &Some(missing.to_string_lossy().to_string())).unwrap_err();
        assert!(err.contains("could not read"), "{err}");
    }

    /// A unique-enough suffix for a temp directory without pulling `uuid` into
    /// this binary for one test.
    fn uuid_like() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }
}
