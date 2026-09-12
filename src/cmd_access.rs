//! `aura access` — issue, list and revoke the org's agent credentials from the
//! command line: the org API keys and the per-agent scope grants that the
//! console's Access page manages, over the same cloud endpoints.
//!
//! These are **admin** acts. They run with the human cloud token (`aura cloud
//! login`, or `AURA_CLOUD_TOKEN`), never an org API key — a key is closed out of
//! the whole `/orgs` tree on purpose, so it cannot mint or revoke its siblings.
//! A human token is not bound to one org, so the org is named explicitly with
//! `--org <slug>` on every call.
//!
//! The endpoints are the ones `aura-cloud` routes at
//! `/api/v2/orgs/{slug}/api-keys` and `/api/v2/orgs/{slug}/scopes`; the scope
//! vocabulary is the server's, printed by `aura access scopes`.

use std::error::Error;

use chrono::{DateTime, Duration, Utc};
use clap::Subcommand;
use colored::Colorize;

#[derive(Subcommand, Debug)]
pub enum AccessSubcommands {
    /// Mint an org API key and print it once. The plaintext is shown a single
    /// time and never again — the server keeps only a hash.
    IssueKey {
        /// The org that owns the key (slug).
        #[arg(long)]
        org: String,
        /// A human label so the key can be told apart in the list.
        #[arg(long)]
        label: String,
        /// A scope the key is granted. Repeat for several: `--scope repo:read
        /// --scope intent:write`. See `aura access scopes`.
        #[arg(long = "scope", required = true)]
        scopes: Vec<String>,
        /// Bind the key to an agent, so every call it makes is judged against
        /// that agent's grant as well as against these scopes. The binding
        /// lives on the key row, so it holds whether or not the caller sends
        /// an `X-Aura-Agent` header — a key handed to a bot cannot pretend to
        /// be a person by staying quiet.
        #[arg(long)]
        agent: Option<String>,
        /// Expire the key after a relative span from now, e.g. `30d`, `12h`,
        /// `90m`, `2w`. Mutually exclusive with `--expires-at`.
        #[arg(long)]
        expires_in: Option<String>,
        /// Expire the key at an absolute RFC 3339 instant, e.g.
        /// `2026-12-31T00:00:00Z`. Mutually exclusive with `--expires-in`.
        #[arg(long)]
        expires_at: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// List the org's API keys (and runner tokens). Revoked keys are hidden
    /// unless `--all` is given.
    ListKeys {
        #[arg(long)]
        org: String,
        #[arg(long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// Revoke an org API key by id. Idempotent — revoking an already-revoked key
    /// succeeds quietly.
    RevokeKey {
        #[arg(long)]
        org: String,
        /// The key id from `aura access list-keys`.
        id: String,
    },
    /// Grant an agent a set of scopes, acting as a named member. Re-granting the
    /// same agent widens (replaces) its live grant.
    Grant {
        #[arg(long)]
        org: String,
        /// The agent this grant is for, e.g. `claude`, `gemini`.
        #[arg(long)]
        agent: String,
        /// The member the agent acts as — a GitHub login or a user id.
        #[arg(long)]
        member: String,
        #[arg(long = "scope", required = true)]
        scopes: Vec<String>,
        #[arg(long)]
        expires_in: Option<String>,
        #[arg(long)]
        expires_at: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// List the org's agent grants.
    ListGrants {
        #[arg(long)]
        org: String,
        #[arg(long)]
        json: bool,
    },
    /// Revoke an agent grant by id. Idempotent.
    RevokeGrant {
        #[arg(long)]
        org: String,
        /// The grant id from `aura access list-grants`.
        id: String,
    },
    /// Ask what an agent may actually do in this org, acting as you.
    ///
    /// This is the enforcement answer, not the grant list: it resolves the one
    /// grant keyed by (agent, the member acting) and says whether it is live,
    /// lapsed or absent. Name a call with `--method` and `--path` to get the
    /// verdict the server would give that exact request.
    Check {
        #[arg(long)]
        org: String,
        /// The agent to answer for, e.g. `claude`.
        #[arg(long)]
        agent: String,
        /// With `--path`, ask whether this exact call would pass.
        #[arg(long, default_value = "GET")]
        method: String,
        /// With `--method`, the route to judge, e.g. `/api/v2/intents`.
        #[arg(long)]
        path: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Turn the agent allow-list on or off for the org.
    ///
    /// Off (the default) an agent the org has granted nothing is not stopped —
    /// only a grant that exists is enforced. On, an agent with no grant is
    /// refused outright, which is what "only agents we named may act here"
    /// means. Grants that exist bind either way.
    Enforce {
        #[arg(long)]
        org: String,
        /// `on` to require a grant, `off` to enforce only the grants that exist.
        #[arg(value_parser = ["on", "off"])]
        state: String,
        #[arg(long)]
        json: bool,
    },
    /// Print the scope vocabulary the server enforces.
    Scopes {
        #[arg(long)]
        org: String,
        #[arg(long)]
        json: bool,
    },
}

// ─── Cloud client ───────────────────────────────────────────────────────────

fn client() -> Result<(reqwest::blocking::Client, String, String), String> {
    let (url, token) = crate::recall_cloud_creds()?;
    let c = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    Ok((c, url, token))
}

fn get(path: &str) -> Result<serde_json::Value, String> {
    let (c, url, token) = client()?;
    let resp = c
        .get(format!("{url}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .map_err(|e| format!("network: {e}"))?;
    read_json(resp)
}

/// GET with query parameters, encoded by the http client rather than by hand —
/// an agent name is user input and has no business being pasted into a URL raw.
fn get_query(path: &str, params: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let (c, url, token) = client()?;
    let resp = c
        .get(format!("{url}{path}"))
        .query(params)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .map_err(|e| format!("network: {e}"))?;
    read_json(resp)
}

fn post(path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let (c, url, token) = client()?;
    let resp = c
        .post(format!("{url}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .json(body)
        .send()
        .map_err(|e| format!("network: {e}"))?;
    read_json(resp)
}

fn put(path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let (c, url, token) = client()?;
    let resp = c
        .put(format!("{url}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .json(body)
        .send()
        .map_err(|e| format!("network: {e}"))?;
    read_json(resp)
}

/// DELETE, tolerant of the 204/empty body the revoke endpoints answer with.
fn delete(path: &str) -> Result<(), String> {
    let (c, url, token) = client()?;
    let resp = c
        .delete(format!("{url}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .map_err(|e| format!("network: {e}"))?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    let detail = resp.text().unwrap_or_default();
    Err(http_error(status, &detail))
}

fn read_json(resp: reqwest::blocking::Response) -> Result<serde_json::Value, String> {
    let status = resp.status();
    let text = resp.text().map_err(|e| format!("read body: {e}"))?;
    let body: serde_json::Value = if text.trim().is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(&text).map_err(|e| format!("parse (HTTP {status}): {e}: {text}"))?
    };
    if !status.is_success() {
        return Err(http_error(status, &text));
    }
    Ok(body)
}

/// Turn a failed response into the clearest sentence we can. The Access surface
/// answers a machine-readable `{error, detail}`, so surface those when present
/// rather than a bare status line.
fn http_error(status: reqwest::StatusCode, text: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
        let err = v["error"].as_str();
        let detail = v["detail"].as_str();
        match (err, detail) {
            (Some(e), Some(d)) => return format!("HTTP {status}: {e} — {d}"),
            (Some(e), None) => return format!("HTTP {status}: {e}"),
            _ => {}
        }
    }
    if text.trim().is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {text}")
    }
}

// ─── Expiry ─────────────────────────────────────────────────────────────────

/// Resolve the two expiry flags into an optional absolute instant. `--expires-in`
/// is relative to now; `--expires-at` is absolute RFC 3339; naming both is a
/// mistake the server cannot see, so it is caught here.
fn resolve_expiry(
    expires_in: &Option<String>,
    expires_at: &Option<String>,
) -> Result<Option<DateTime<Utc>>, String> {
    match (expires_in, expires_at) {
        (Some(_), Some(_)) => {
            Err("pass either --expires-in or --expires-at, not both".to_string())
        }
        (None, None) => Ok(None),
        (Some(rel), None) => Ok(Some(Utc::now() + parse_relative(rel)?)),
        (None, Some(abs)) => {
            let at = DateTime::parse_from_rfc3339(abs.trim())
                .map_err(|e| format!("--expires-at is not RFC 3339 ('{abs}'): {e}"))?
                .with_timezone(&Utc);
            Ok(Some(at))
        }
    }
}

/// `<n><unit>` where unit is s, m, h, d or w. A bare number is refused rather
/// than guessed — "30" could be seconds or days, and a credential's lifetime is
/// not the place to guess.
fn parse_relative(s: &str) -> Result<Duration, String> {
    let s = s.trim();
    let (num, unit) = s.split_at(
        s.find(|c: char| !c.is_ascii_digit())
            .ok_or_else(|| format!("--expires-in needs a unit (s/m/h/d/w), got '{s}'"))?,
    );
    let n: i64 = num
        .parse()
        .map_err(|_| format!("--expires-in is not a number followed by a unit: '{s}'"))?;
    if n <= 0 {
        return Err(format!("--expires-in must be positive, got '{s}'"));
    }
    let dur = match unit {
        "s" => Duration::seconds(n),
        "m" => Duration::minutes(n),
        "h" => Duration::hours(n),
        "d" => Duration::days(n),
        "w" => Duration::weeks(n),
        other => return Err(format!("--expires-in unit must be s/m/h/d/w, got '{other}'")),
    };
    Ok(dur)
}

// ─── Rendering ──────────────────────────────────────────────────────────────

fn scopes_str(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => "—".dimmed().to_string(),
        serde_json::Value::Array(a) => a
            .iter()
            .filter_map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        _ => v.to_string(),
    }
}

fn colored_status(status: &str) -> colored::ColoredString {
    match status {
        "active" => status.green(),
        "expired" => status.yellow(),
        "revoked" => status.red(),
        other => other.normal(),
    }
}

fn opt_str<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("—")
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

pub fn run(sub: &AccessSubcommands) -> Result<(), Box<dyn Error>> {
    match sub {
        AccessSubcommands::IssueKey {
            org,
            label,
            scopes,
            agent,
            expires_in,
            expires_at,
            json,
        } => {
            let exp = resolve_expiry(expires_in, expires_at)?;
            let mut body = serde_json::json!({ "label": label, "scopes": scopes });
            if let Some(at) = exp {
                body["expires_at"] = serde_json::json!(at.to_rfc3339());
            }
            if let Some(agent) = agent {
                body["agent"] = serde_json::json!(agent);
            }
            let res = post(&format!("/api/v2/orgs/{org}/api-keys"), &body)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&res)?);
                return Ok(());
            }
            let token = res["token"].as_str().unwrap_or_default();
            let key = &res["key"];
            println!("{}", "  Key issued.".green().bold());
            println!("    id     {}", opt_str(key, "id"));
            println!("    label  {}", opt_str(key, "label"));
            println!("    scopes {}", scopes_str(&key["scopes"]));
            if let Some(a) = key["agent"].as_str() {
                println!("    agent  {a}  (calls are judged against this agent's grant too)");
            }
            if let Some(at) = key["expires_at"].as_str() {
                println!("    expires {at}");
            }
            println!();
            println!("{}", "  ┌─ Copy this now. It is shown once and cannot be recovered.".yellow());
            println!("  │  {}", token.bold());
            println!("{}", "  └─ Store it in your secret manager, not in the repo.".yellow());
        }
        AccessSubcommands::ListKeys { org, all, json } => {
            let q = if *all { "?include_revoked=true" } else { "" };
            let res = get(&format!("/api/v2/orgs/{org}/api-keys{q}"))?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&res)?);
                return Ok(());
            }
            let keys = res["keys"].as_array().cloned().unwrap_or_default();
            if keys.is_empty() {
                println!("  No keys.");
                return Ok(());
            }
            for k in &keys {
                let kind = k["kind"].as_str().unwrap_or("key");
                let status = k["status"].as_str().unwrap_or("active");
                println!(
                    "  {}  {}  [{}]  {}",
                    opt_str(k, "id").dimmed(),
                    opt_str(k, "label").bold(),
                    kind,
                    colored_status(status),
                );
                println!("      prefix  {}", opt_str(k, "key_prefix"));
                println!("      scopes  {}", scopes_str(&k["scopes"]));
                if let Some(at) = k["expires_at"].as_str() {
                    println!("      expires {at}");
                }
                if let Some(at) = k["last_used_at"].as_str() {
                    println!("      used    {at}");
                }
            }
        }
        AccessSubcommands::RevokeKey { org, id } => {
            delete(&format!("/api/v2/orgs/{org}/api-keys/{id}"))?;
            println!("{}", format!("  Key {id} revoked.").green());
        }
        AccessSubcommands::Grant {
            org,
            agent,
            member,
            scopes,
            expires_in,
            expires_at,
            json,
        } => {
            let exp = resolve_expiry(expires_in, expires_at)?;
            let mut body =
                serde_json::json!({ "agent": agent, "acts_as": member, "scopes": scopes });
            if let Some(at) = exp {
                body["expires_at"] = serde_json::json!(at.to_rfc3339());
            }
            let res = post(&format!("/api/v2/orgs/{org}/scopes"), &body)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&res)?);
                return Ok(());
            }
            println!("{}", "  Grant saved.".green().bold());
            println!("    id      {}", opt_str(&res, "id"));
            println!("    agent   {}", opt_str(&res, "agent"));
            println!("    acts as {}", opt_str(&res["acts_as"], "user_id"));
            println!("    scopes  {}", scopes_str(&res["scopes"]));
            if let Some(at) = res["expires_at"].as_str() {
                println!("    expires {at}");
            }
        }
        AccessSubcommands::ListGrants { org, json } => {
            let res = get(&format!("/api/v2/orgs/{org}/scopes"))?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&res)?);
                return Ok(());
            }
            let grants = res["grants"].as_array().cloned().unwrap_or_default();
            if grants.is_empty() {
                println!("  No grants.");
                return Ok(());
            }
            for g in &grants {
                let status = g["status"].as_str().unwrap_or("active");
                println!(
                    "  {}  {}  {}",
                    opt_str(g, "id").dimmed(),
                    opt_str(g, "agent").bold(),
                    colored_status(status),
                );
                println!("      acts as {}", opt_str(&g["acts_as"], "user_id"));
                println!("      scopes  {}", scopes_str(&g["scopes"]));
                if let Some(at) = g["expires_at"].as_str() {
                    println!("      expires {at}");
                }
            }
        }
        AccessSubcommands::RevokeGrant { org, id } => {
            delete(&format!("/api/v2/orgs/{org}/scopes/{id}"))?;
            println!("{}", format!("  Grant {id} revoked.").green());
        }
        AccessSubcommands::Check {
            org,
            agent,
            method,
            path,
            json,
        } => {
            let mut params: Vec<(&str, &str)> = vec![("agent", agent.as_str())];
            if let Some(p) = path {
                params.push(("method", method.as_str()));
                params.push(("path", p.as_str()));
            }
            let res = get_query(&format!("/api/v2/orgs/{org}/scopes/effective"), &params)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&res)?);
                return Ok(());
            }
            let status = res["status"].as_str().unwrap_or("none");
            let allow_list = res["allow_list"].as_bool().unwrap_or(false);
            println!("  Agent  {}", agent.bold());
            println!("  Grant  {}", colored_status(status));
            match status {
                "active" => {
                    println!("  Scopes {}", scopes_str(&res["scopes"]));
                    match res["expires_at"].as_str() {
                        Some(at) => println!("  Until  {at}"),
                        None => println!("  Until  {}", "no expiry".dimmed()),
                    }
                }
                "expired" => {
                    if let Some(at) = res["expires_at"].as_str() {
                        println!("  Lapsed {at}");
                    }
                    println!("  {}", "A lapsed grant refuses every call, whatever the org policy says.".yellow());
                }
                _ => {
                    if allow_list {
                        println!(
                            "  {}",
                            "This org requires a grant, so this agent is refused everywhere.".yellow()
                        );
                    } else {
                        println!(
                            "  {}",
                            "This org enforces only the grants that exist, so this agent is not stopped.".dimmed()
                        );
                    }
                }
            }
            if let Some(v) = res.get("verdict") {
                let p = path.as_deref().unwrap_or("");
                println!();
                if v["allowed"].as_bool().unwrap_or(false) {
                    let by = v["satisfied_by"].as_str().unwrap_or("");
                    println!("  {} {method} {p}  ({by})", "allowed".green().bold());
                } else {
                    println!("  {} {method} {p}", "refused".red().bold());
                    println!("    {}", v["detail"].as_str().unwrap_or(""));
                }
            }
        }
        AccessSubcommands::Enforce { org, state, json } => {
            let enforced = state == "on";
            let res = put(
                &format!("/api/v2/orgs/{org}/scopes/policy"),
                &serde_json::json!({ "enforced": enforced }),
            )?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&res)?);
                return Ok(());
            }
            if enforced {
                println!("{}", "  Allow-list on.".green().bold());
                println!("    An agent with no grant in this org is now refused.");
            } else {
                println!("{}", "  Allow-list off.".green().bold());
                println!("    Only the grants that exist are enforced; an ungranted agent is not stopped.");
            }
        }
        AccessSubcommands::Scopes { org, json } => {
            // The grant list travels with the vocabulary it was written against,
            // so ask for it there rather than keeping a second copy in the CLI.
            let res = get(&format!("/api/v2/orgs/{org}/scopes"))?;
            let vocab = res["vocabulary"].as_array().cloned().unwrap_or_default();
            if *json {
                println!("{}", serde_json::to_string_pretty(&res["vocabulary"])?);
                return Ok(());
            }
            println!("  Scopes the server enforces:");
            for s in &vocab {
                if let Some(s) = s.as_str() {
                    println!("    {s}");
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_spans_parse_by_unit() {
        assert_eq!(parse_relative("30d").unwrap(), Duration::days(30));
        assert_eq!(parse_relative("12h").unwrap(), Duration::hours(12));
        assert_eq!(parse_relative("90m").unwrap(), Duration::minutes(90));
        assert_eq!(parse_relative("2w").unwrap(), Duration::weeks(2));
        assert_eq!(parse_relative("45s").unwrap(), Duration::seconds(45));
    }

    #[test]
    fn a_bare_number_or_bad_unit_is_refused() {
        assert!(parse_relative("30").is_err(), "a unitless span was accepted");
        assert!(parse_relative("30y").is_err(), "an unknown unit was accepted");
        assert!(parse_relative("0d").is_err(), "a zero span was accepted");
        assert!(parse_relative("-5d").is_err(), "a negative span was accepted");
    }

    #[test]
    fn expiry_flags_are_mutually_exclusive() {
        let both = resolve_expiry(&Some("1d".into()), &Some("2026-01-01T00:00:00Z".into()));
        assert!(both.is_err(), "naming both expiry flags was allowed");
        assert!(resolve_expiry(&None, &None).unwrap().is_none());
        assert!(resolve_expiry(&Some("1h".into()), &None).unwrap().is_some());
    }

    #[test]
    fn absolute_expiry_must_be_rfc3339() {
        assert!(resolve_expiry(&None, &Some("not-a-date".into())).is_err());
        let ok = resolve_expiry(&None, &Some("2026-12-31T00:00:00Z".into())).unwrap();
        assert!(ok.is_some());
    }
}
