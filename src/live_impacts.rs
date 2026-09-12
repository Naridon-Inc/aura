//! `aura live impacts` and `aura live resolve` — a dependency change you can
//! do something about.
//!
//! # What was broken
//!
//! Aura noticed that somebody changed a function under you and told you so,
//! in three places, and not one of them let you finish the thought:
//!
//! * `aura live impacts` printed the change, the author and the branch, and
//!   never printed the alert's id — the one field you need to clear it
//! * there was no command to clear it. `POST /live/impacts/resolve` has
//!   existed all along, reachable only from the MCP tool `aura_live_resolve`,
//!   so the answer to "I have handled this" was *install the MCP server*
//! * the console's "Impacts on me" rail says the same thing with no action
//!   at all (`aura-console-next/src/surfaces/Home.tsx`)
//!
//! So the alert stayed unresolved after the work was done, and every later
//! run of the command counted it again. A warning you cannot dismiss is a
//! warning people learn to scroll past, which costs you the one it mattered
//! for.
//!
//! # What this does
//!
//! Prints a short id on every row and the exact command that clears it, and
//! adds that command. Short ids because a uuid is not something anybody
//! retypes: eight characters is unambiguous among the fifty alerts the
//! endpoint returns, and where it somehow is not, [`match_alert`] says so
//! rather than picking one.
//!
//! Resolving is per alert on purpose. `--all` exists for the case where a
//! merge cleared the lot, and says how many it is about to clear, because
//! "handled" is a claim about work somebody did.

use colored::Colorize;

/// How many characters of an alert's uuid a person is asked to type.
const SHORT_ID_LEN: usize = 8;

/// The abbreviated id shown in the listing.
pub fn short_id(alert_id: &str) -> String {
    alert_id.chars().take(SHORT_ID_LEN).collect()
}

/// What a typed id matched.
#[derive(Debug, PartialEq, Eq)]
pub enum Match {
    /// Exactly one alert. Carries its full id, which is what the server wants.
    One(String),
    /// Nothing by that name.
    None,
    /// More than one, so the caller must be told which rather than guessed at.
    Several(Vec<String>),
}

/// Resolve what somebody typed against the ids currently outstanding.
///
/// Case-insensitive, and a full uuid matches itself — someone pasting the id
/// out of `--json` should not be told it is not a prefix of anything.
pub fn match_alert(typed: &str, ids: &[String]) -> Match {
    let typed = typed.trim().to_lowercase();
    if typed.is_empty() {
        return Match::None;
    }
    let hits: Vec<String> = ids
        .iter()
        .filter(|id| id.to_lowercase().starts_with(&typed))
        .cloned()
        .collect();
    match hits.len() {
        0 => Match::None,
        1 => Match::One(hits.into_iter().next().expect("one hit")),
        _ => Match::Several(hits),
    }
}

/// The ids in an `/live/impacts` response, in the order the server sent them.
pub fn ids_of(body: &serde_json::Value) -> Vec<String> {
    body["alerts"]
        .as_array()
        .map(|alerts| {
            alerts
                .iter()
                .filter_map(|a| a["id"].as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// What of yours an alert lands on: the name, and the thing it depends on
/// where the row says.
///
/// `affected_functions` holds two shapes in the same column. The detector
/// that walks the call graph writes objects — `{"name": …, "depends_on": …}`
/// — and the one that only knows which symbols are yours writes bare
/// strings, `["FleetSurface::rows", "useFleet"]`. Each reader had learned
/// one of them: this command printed "your ? depends on ?" for a whole
/// alert, and the console (`asStrings`) keeps only the strings, so it shows
/// nothing at all for the objects. Both shapes name a function of yours,
/// which is the only thing the row is for.
pub fn affected(alert: &serde_json::Value) -> Vec<(String, Option<String>)> {
    alert["affected_functions"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|f| {
                    if let Some(name) = f.as_str() {
                        let name = name.trim();
                        return (!name.is_empty()).then(|| (name.to_string(), None));
                    }
                    let name = f["name"].as_str().map(str::trim).filter(|n| !n.is_empty())?;
                    let on = f["depends_on"]
                        .as_str()
                        .map(str::trim)
                        .filter(|d| !d.is_empty())
                        .map(str::to_string);
                    Some((name.to_string(), on))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// One line describing what moved, in the alert's own vocabulary.
///
/// Deliberately not the server's `suggestion` field: that is a sentence
/// assembled server-side which restates the function, the branch and the
/// author — all three already on the row — and interpolates the affected list
/// with a debug formatter, so an alert the server could not attribute renders
/// the words "Your function(s) [] depend on it". The console made the same
/// call for the same reason (`adapt.impactRow`).
fn headline(alert: &serde_json::Value) -> String {
    let kind = alert["impact_type"].as_str().unwrap_or("modified");
    let label = match kind {
        "deleted" => "DELETED".red().bold().to_string(),
        "modified" => "MODIFIED".yellow().bold().to_string(),
        other => other.to_uppercase(),
    };
    format!(
        "{} {} {} on {}",
        label,
        alert["source_function"].as_str().unwrap_or("?").cyan().bold(),
        format!("by {}", alert["source_user"].as_str().unwrap_or("?")).dimmed(),
        alert["source_branch"].as_str().unwrap_or("?").green(),
    )
}

/// Print the alerts in a fetched response.
pub fn render(body: &serde_json::Value, branch: &str) {
    println!("{}", "⚠️  Aura Live — Cross-Branch Impacts".bold());
    println!();

    let alerts = body["alerts"].as_array().cloned().unwrap_or_default();
    let total = body["total"].as_u64().unwrap_or(alerts.len() as u64);

    if total == 0 {
        println!("  {} No impacts detected on your branch.", "✓".green().bold());
        println!(
            "  {} Your dependencies are safe across all active branches.",
            "↳".dimmed()
        );
        return;
    }

    println!(
        "  {} {} impact{} on {}",
        "⚠️".yellow().bold(),
        total.to_string().red().bold(),
        if total == 1 { "" } else { "s" },
        branch.cyan(),
    );
    println!();

    for alert in &alerts {
        let id = alert["id"].as_str().unwrap_or("");
        println!(
            "  {} {}  {}",
            "│".dimmed(),
            short_id(id).bold(),
            headline(alert)
        );
        for (name, on) in affected(alert) {
            match on {
                Some(dep) => println!(
                    "  {}   {} your {} depends on {}",
                    "│".dimmed(),
                    "→".yellow(),
                    name.cyan(),
                    dep.yellow(),
                ),
                None => println!(
                    "  {}   {} your {} uses it",
                    "│".dimmed(),
                    "→".yellow(),
                    name.cyan(),
                ),
            }
        }
        println!("  {}", "│".dimmed());
    }

    // The point of the id above. Without this the reader has a warning and no
    // verb, which is how these came to sit unresolved for weeks.
    let first = alerts
        .first()
        .and_then(|a| a["id"].as_str())
        .map(short_id)
        .unwrap_or_else(|| "<id>".to_string());
    println!(
        "  {} Handled one? {}",
        "💡".blue(),
        format!("aura live resolve {}", first).cyan()
    );
    println!(
        "  {} A merge cleared them all? {}",
        "↳".dimmed(),
        "aura live resolve --all".cyan()
    );
}

/// `aura live resolve` — mark one impact handled, or all of them.
///
/// Resolving reads the outstanding list first, both to turn a short id into
/// the full one the server wants and so that a typo is answered with the ids
/// that do exist rather than a bare 404.
pub fn resolve(alert_id: Option<&str>, all: bool, json: bool) {
    let say = |value: serde_json::Value, line: String| {
        if json {
            println!("{}", serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string()));
        } else {
            println!("{line}");
        }
    };

    if alert_id.is_some() && all {
        say(
            serde_json::json!({"error": "pass an id or --all, not both"}),
            format!("  {} Pass an id or {}, not both.", "✗".red(), "--all".cyan()),
        );
        return;
    }

    let body = match crate::live_sync::fetch_impacts_json() {
        Ok(body) => body,
        Err(e) => {
            say(
                serde_json::json!({ "error": e }),
                format!("  {} {}", "✗".red(), e),
            );
            return;
        }
    };
    let outstanding = ids_of(&body);

    let targets: Vec<String> = if all {
        if outstanding.is_empty() {
            say(
                serde_json::json!({"resolved": [], "note": "nothing was outstanding"}),
                format!("  {} Nothing to resolve — no impacts are outstanding.", "✓".green()),
            );
            return;
        }
        outstanding
    } else {
        // An empty argument is the same question as no argument at all.
        let Some(typed) = alert_id.map(str::trim).filter(|t| !t.is_empty()) else {
            say(
                serde_json::json!({"error": "an alert id is required, or --all"}),
                format!(
                    "  {} Which one? {} lists them, each with a short id.",
                    "✗".red(),
                    "aura live impacts".cyan()
                ),
            );
            return;
        };
        match match_alert(typed, &outstanding) {
            Match::One(id) => vec![id],
            Match::None => {
                let known: Vec<String> = outstanding.iter().map(|id| short_id(id)).collect();
                say(
                    serde_json::json!({"error": "no such impact", "outstanding": known}),
                    if known.is_empty() {
                        format!(
                            "  {} No impact `{}` — nothing is outstanding on this repo.",
                            "✗".red(),
                            typed
                        )
                    } else {
                        format!(
                            "  {} No impact `{}`. Outstanding: {}",
                            "✗".red(),
                            typed,
                            known.join(", ").cyan()
                        )
                    },
                );
                return;
            }
            Match::Several(hits) => {
                let longer: Vec<String> = hits.iter().map(|id| short_id(id)).collect();
                say(
                    serde_json::json!({"error": "ambiguous", "matches": hits}),
                    format!(
                        "  {} `{}` matches {} impacts: {}. Type more of it.",
                        "✗".red(),
                        typed,
                        hits.len(),
                        longer.join(", ").cyan()
                    ),
                );
                return;
            }
        }
    };

    let mut resolved: Vec<String> = Vec::new();
    let mut failed: Vec<(String, String)> = Vec::new();
    for id in &targets {
        match crate::live_sync::resolve_impact(id) {
            Ok(_) => resolved.push(id.clone()),
            Err(e) => failed.push((id.clone(), e)),
        }
    }

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "resolved": resolved,
                "failed": failed
                    .iter()
                    .map(|(id, e)| serde_json::json!({"alert_id": id, "error": e}))
                    .collect::<Vec<_>>(),
            }))
            .unwrap_or_else(|_| "{}".to_string())
        );
        return;
    }

    if !resolved.is_empty() {
        println!(
            "  {} {} impact{} marked handled. It will not be counted again.",
            "✓".green().bold(),
            resolved.len(),
            if resolved.len() == 1 { "" } else { "s" }
        );
    }
    // Reported one by one rather than as a count: a partial failure on
    // `--all` is the case where knowing which one is left matters.
    for (id, e) in &failed {
        println!("  {} {} — {}", "✗".red(), short_id(id).bold(), e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_short_id_is_enough_to_name_an_alert() {
        let all = ids(&["8f2c1d90-aaaa-4a16-a1a1-000000000001", "1b0e77aa-bbbb-4a16-a1a1-000000000002"]);
        assert_eq!(
            match_alert("8f2c1d90", &all),
            Match::One(all[0].clone())
        );
    }

    #[test]
    fn a_full_uuid_pasted_out_of_json_still_matches() {
        let all = ids(&["8f2c1d90-aaaa-4a16-a1a1-000000000001"]);
        assert_eq!(match_alert(&all[0], &all), Match::One(all[0].clone()));
    }

    #[test]
    fn case_does_not_matter() {
        let all = ids(&["8F2C1D90-AAAA-4a16-a1a1-000000000001"]);
        assert_eq!(match_alert("8f2c1d90", &all), Match::One(all[0].clone()));
    }

    #[test]
    fn an_ambiguous_prefix_is_reported_not_guessed() {
        let all = ids(&["8f2c0000-a", "8f2c1111-b"]);
        assert_eq!(match_alert("8f2c", &all), Match::Several(all.clone()));
    }

    #[test]
    fn nothing_typed_matches_nothing() {
        let all = ids(&["8f2c0000-a"]);
        assert_eq!(match_alert("   ", &all), Match::None);
        assert_eq!(match_alert("zzzz", &all), Match::None);
    }

    #[test]
    fn ids_come_out_of_a_response_in_order() {
        let body = serde_json::json!({
            "total": 2,
            "alerts": [{"id": "a-1"}, {"id": "b-2"}, {"no_id": true}]
        });
        assert_eq!(ids_of(&body), vec!["a-1".to_string(), "b-2".to_string()]);
    }

    #[test]
    fn a_response_with_no_alerts_yields_no_ids() {
        assert_eq!(ids_of(&serde_json::json!({})), Vec::<String>::new());
    }

    #[test]
    fn both_shapes_of_affected_functions_are_read() {
        let objects = serde_json::json!({
            "affected_functions": [{"name": "sync::push", "depends_on": "http::send"}]
        });
        assert_eq!(
            affected(&objects),
            vec![("sync::push".to_string(), Some("http::send".to_string()))]
        );

        // The other detector writes bare strings. This alert used to render
        // as "your ? depends on ?" here, and as nothing at all in the console.
        let strings = serde_json::json!({
            "affected_functions": ["FleetSurface::rows", "useFleet", "  "]
        });
        assert_eq!(
            affected(&strings),
            vec![
                ("FleetSurface::rows".to_string(), None),
                ("useFleet".to_string(), None)
            ]
        );
    }

    #[test]
    fn an_alert_naming_nothing_of_yours_lists_nothing() {
        assert_eq!(affected(&serde_json::json!({})), vec![]);
        assert_eq!(
            affected(&serde_json::json!({"affected_functions": [{"depends_on": "x"}]})),
            vec![]
        );
    }
}
