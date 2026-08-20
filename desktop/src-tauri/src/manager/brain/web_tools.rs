//! Reading the web — the tool the chat brain was missing.
//!
//! Asked to "check askangle.com and design our website", the brain answered
//! "I don't have access to a live web browser tool". It was telling the truth:
//! every native tool pointed inward, at the board, the Pages and the code
//! graph. A coding agent that can't open a URL can't look at the design it's
//! being asked to match, read the API docs it's being asked to integrate, or
//! check the error message it's being asked to fix.
//!
//! Two tools close that:
//!
//!   * `web_fetch` — open one URL and return it as readable text.
//!   * `web_search` — find URLs worth opening.
//!
//! Search runs against two keyless backends (Bing's RSS feed, then
//! DuckDuckGo's no-JS HTML) because a single scraped endpoint is one redesign
//! or one anti-bot rollout away from silently answering "no results" forever.
//!
//! Both return TEXT, never markup. Feeding a model raw HTML burns thousands of
//! tokens on `<div class="…">` and buries the prose it needed, so the tags,
//! scripts and styles come off here where the cost is paid once.

use serde_json::{Value, json};

/// Sent on every request. A blank or library-default agent gets a 403 from a
/// noticeable share of sites, which would read to the model as "the page is
/// broken" rather than "we were turned away".
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Aura/1.0";

/// Cap on the text handed back from one fetch. Roughly 12k tokens — enough for
/// a long article, small enough that one greedy page can't evict the
/// conversation from the context window.
const DEFAULT_MAX_CHARS: usize = 40_000;
const HARD_MAX_CHARS: usize = 120_000;

/// A page that hasn't answered in this long isn't going to. Kept short: the
/// user is watching a spinner while this runs.
const TIMEOUT_SECS: u64 = 20;

const TOOL_NAMES: [&str; 2] = ["web_fetch", "web_search"];

pub fn is_web_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

/// Anthropic-format schemas for the two tools.
pub fn schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "web_fetch",
            "description": "Open a URL and read it as plain text. Use this whenever the user names a site, links to documentation, or asks you to look at something that lives on the web — do NOT answer that you cannot browse. Returns the page's readable text with markup, scripts and navigation stripped. Follows redirects.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Absolute URL to fetch, including the scheme (https://example.com/page). A bare domain is assumed to be https."
                    },
                    "max_chars": {
                        "type": "integer",
                        "description": "Truncate the returned text to this many characters (default 40000)."
                    }
                },
                "required": ["url"]
            }
        }),
        json!({
            "name": "web_search",
            "description": "Search the web and get back a ranked list of results — title, URL and snippet. Use it to FIND pages, then call web_fetch on the ones worth reading in full. Prefer web_fetch directly when the user already gave you a URL.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "What to search for, in natural language." },
                    "limit": { "type": "integer", "description": "How many results to return (default 8, max 20)." }
                },
                "required": ["query"]
            }
        }),
    ]
}

/// Run one web tool. Returns `(result_text, is_error)` on the same contract as
/// the board tools: a failure comes back as text the model can read and react
/// to, never as a dead turn.
pub async fn execute(name: &str, input: &Value) -> (String, bool) {
    match name {
        "web_fetch" => {
            let url = input.get("url").and_then(Value::as_str).unwrap_or("").trim();
            let max = input
                .get("max_chars")
                .and_then(Value::as_u64)
                .map(|v| (v as usize).min(HARD_MAX_CHARS))
                .unwrap_or(DEFAULT_MAX_CHARS);
            fetch(url, max).await
        }
        "web_search" => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or("").trim();
            let limit = input
                .get("limit")
                .and_then(Value::as_u64)
                .map(|v| (v as usize).clamp(1, 20))
                .unwrap_or(8);
            search(query, limit).await
        }
        other => (format!("unknown web tool: {other}"), true),
    }
}

/// Accept what a person would type. A bare `example.com` becomes https, and
/// anything that isn't http(s) is refused — `file://` and friends would turn a
/// web tool into an arbitrary-file reader.
fn normalize_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("no url given".into());
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Ok(url.to_string());
    }
    if lower.contains("://") {
        return Err(format!(
            "only http and https URLs can be fetched (got {})",
            lower.split("://").next().unwrap_or("that scheme")
        ));
    }
    Ok(format!("https://{url}"))
}

/// The cloud metadata endpoint hands out credentials to anything that asks it.
/// Nothing a model decides to open should ever reach it.
fn is_blocked_host(url: &str) -> bool {
    let host = url
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("")
        .split('@')
        .next_back()
        .unwrap_or("");
    host.starts_with("169.254.169.254") || host == "metadata.google.internal"
}

async fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("could not start an HTTP client: {e}"))
}

async fn fetch(raw_url: &str, max_chars: usize) -> (String, bool) {
    let url = match normalize_url(raw_url) {
        Ok(u) => u,
        Err(e) => return (e, true),
    };
    if is_blocked_host(&url) {
        return ("that host is not reachable from here".into(), true);
    }
    let client = match client().await {
        Ok(c) => c,
        Err(e) => return (e, true),
    };
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => return (format!("could not reach {url}: {e}"), true),
    };
    let status = resp.status();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let body = match resp.text().await {
        Ok(b) => b,
        Err(e) => return (format!("{url} responded but the body could not be read: {e}"), true),
    };
    if !status.is_success() {
        // Hand back the status AND the body — a 404 page or an API error
        // message is usually the answer the model needs.
        let excerpt = truncate(&html_to_text(&body), 2_000);
        return (format!("{url} returned HTTP {status}\n\n{excerpt}"), true);
    }

    // JSON, plain text and markdown are already readable; only markup needs
    // stripping. Guessing by content-type beats sniffing for '<'.
    let text = if content_type.contains("html") || content_type.contains("xml") {
        html_to_text(&body)
    } else {
        body
    };
    let text = truncate(&text, max_chars);
    if text.trim().is_empty() {
        return (
            format!("{final_url} loaded but had no readable text — it is probably rendered by JavaScript."),
            false,
        );
    }
    (format!("Source: {final_url}\n\n{text}"), false)
}

/// Run a query and hand back a readable result list.
///
/// Two backends, tried in order. Bing's RSS feed leads because it answers in a
/// STRUCTURED shape — title, link and description in named elements — so a page
/// redesign can't quietly turn our results into an empty list the way a scraped
/// CSS class can. DuckDuckGo's no-JS HTML stays behind it as a second opinion:
/// each answers from networks where the other serves a challenge page instead,
/// and between them a query usually lands.
///
/// When neither answers we say the search failed rather than reporting "no
/// results" — the web having nothing on a topic and us being unable to ask are
/// different facts, and a model told the first will stop looking.
async fn search(query: &str, limit: usize) -> (String, bool) {
    if query.is_empty() {
        return ("no query given".into(), true);
    }
    let client = match client().await {
        Ok(c) => c,
        Err(e) => return (e, true),
    };

    let mut hits = bing_rss(&client, query, limit).await;
    let mut reached_a_backend = !hits.is_empty();
    if hits.is_empty() {
        let (ddg, reached) = duckduckgo_html(&client, query, limit).await;
        reached_a_backend |= reached;
        hits = ddg;
    }

    if hits.is_empty() {
        let why = if reached_a_backend {
            format!("no results for {query:?}")
        } else {
            format!("search is unreachable right now (both backends refused), so this is not evidence that nothing exists for {query:?}")
        };
        return (
            format!("{why}. If you already know the URL, call web_fetch on it directly."),
            false,
        );
    }

    let mut out = format!("{} results for {query:?}:\n", hits.len());
    for (i, h) in hits.iter().enumerate() {
        out.push_str(&format!("\n{}. {}\n   {}\n", i + 1, h.title, h.url));
        if !h.snippet.is_empty() {
            out.push_str(&format!("   {}\n", h.snippet));
        }
    }
    (out, false)
}

/// Bing's RSS view of a query — same index as the web UI, delivered as a feed.
async fn bing_rss(client: &reqwest::Client, query: &str, limit: usize) -> Vec<Hit> {
    let resp = client
        .get("https://www.bing.com/search")
        .query(&[("q", query), ("format", "rss")])
        .send()
        .await;
    let Ok(resp) = resp else { return Vec::new() };
    let Ok(body) = resp.text().await else {
        return Vec::new();
    };
    parse_rss(&body, limit)
}

/// DuckDuckGo's no-JS HTML endpoint. Returns the hits and whether we actually
/// got a page back, so the caller can tell "nothing found" from "never asked".
async fn duckduckgo_html(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> (Vec<Hit>, bool) {
    let resp = client
        .post("https://html.duckduckgo.com/html/")
        .form(&[("q", query)])
        .send()
        .await;
    let Ok(resp) = resp else {
        return (Vec::new(), false);
    };
    let Ok(body) = resp.text().await else {
        return (Vec::new(), false);
    };
    (parse_results(&body, limit), true)
}

/// Pull `(title, url, snippet)` out of an RSS feed's `<item>` elements.
fn parse_rss(xml: &str, limit: usize) -> Vec<Hit> {
    let mut out = Vec::new();
    for chunk in xml.split("<item>").skip(1) {
        if out.len() >= limit {
            break;
        }
        let item = chunk.split("</item>").next().unwrap_or(chunk);
        let Some(url) = tag_text(item, "link") else {
            continue;
        };
        if url.is_empty() {
            continue;
        }
        out.push(Hit {
            title: collapse(&tag_text(item, "title").unwrap_or_default()),
            url,
            snippet: truncate(
                &collapse(&tag_text(item, "description").unwrap_or_default()),
                300,
            ),
        });
    }
    out
}

/// Text of the first `<tag>…</tag>` in `chunk`, CDATA unwrapped, entities and
/// any stray markup resolved — feeds carry both, sometimes in the same item.
fn tag_text(chunk: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = chunk.find(&open)? + open.len();
    let rest = &chunk[start..];
    let end = rest.find(&close)?;
    let raw = rest[..end].trim();
    let raw = raw
        .strip_prefix("<![CDATA[")
        .and_then(|r| r.strip_suffix("]]>"))
        .unwrap_or(raw);
    // Entities BEFORE tags, which is the opposite of a web page. A feed
    // carries its markup escaped (`&lt;b&gt;`), so stripping first would leave
    // the model reading the literal characters "<b>".
    Some(html_to_text(&decode_entities(raw)))
}

#[derive(Debug, PartialEq)]
struct Hit {
    title: String,
    url: String,
    snippet: String,
}

/// Pull `(title, url, snippet)` out of DuckDuckGo's HTML result list.
///
/// Deliberately regex-and-substring rather than a DOM parse: the only thing we
/// need is stable (`class="result__a" href=…` per hit), and a full parser is a
/// dependency plus a much larger blast radius for the same answer.
fn parse_results(html: &str, limit: usize) -> Vec<Hit> {
    let mut out = Vec::new();
    for chunk in html.split("result__a").skip(1) {
        if out.len() >= limit {
            break;
        }
        let Some(href) = attr_after(chunk, "href=\"") else {
            continue;
        };
        let url = unwrap_redirect(&href);
        if url.is_empty() {
            continue;
        }
        let title = chunk
            .split_once('>')
            .map(|(_, rest)| rest.split('<').next().unwrap_or(""))
            .map(html_to_text)
            .unwrap_or_default();
        let snippet = chunk
            .split_once("result__snippet")
            .and_then(|(_, rest)| rest.split_once('>'))
            .map(|(_, rest)| rest.split("</a").next().unwrap_or(""))
            .map(html_to_text)
            .unwrap_or_default();
        out.push(Hit {
            title: collapse(&title),
            url,
            snippet: truncate(&collapse(&snippet), 300),
        });
    }
    out
}

/// The value of an attribute that starts at `needle`, up to the closing quote.
fn attr_after(chunk: &str, needle: &str) -> Option<String> {
    let start = chunk.find(needle)? + needle.len();
    let rest = &chunk[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// DuckDuckGo wraps every result in `/l/?uddg=<percent-encoded real url>`.
/// Unwrap it so the model gets a URL it can hand straight to `web_fetch`.
fn unwrap_redirect(href: &str) -> String {
    let target = href
        .split("uddg=")
        .nth(1)
        .map(|s| s.split('&').next().unwrap_or(s))
        .map(percent_decode)
        .unwrap_or_else(|| href.to_string());
    let target = target.trim();
    if target.starts_with("//") {
        format!("https:{target}")
    } else {
        target.to_string()
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Markup in, prose out.
///
/// Drops `<script>` / `<style>` / `<head>` bodies wholesale (they are pure
/// noise to a reader), turns block-level tags into line breaks so paragraphs
/// and list items stay apart, strips every other tag, then decodes entities.
pub fn html_to_text(html: &str) -> String {
    let mut cleaned = String::with_capacity(html.len());
    let lower = html.to_ascii_lowercase();
    let mut i = 0usize;
    while i < html.len() {
        // Skip whole elements whose content is never prose.
        let mut skipped = false;
        for (open, close) in [
            ("<script", "</script>"),
            ("<style", "</style>"),
            ("<head", "</head>"),
            ("<noscript", "</noscript>"),
            ("<svg", "</svg>"),
            ("<!--", "-->"),
        ] {
            if lower[i..].starts_with(open) {
                i = lower[i..]
                    .find(close)
                    .map(|off| i + off + close.len())
                    .unwrap_or(html.len());
                skipped = true;
                break;
            }
        }
        if skipped {
            continue;
        }
        if html[i..].starts_with('<') {
            let end = html[i..].find('>').map(|off| i + off + 1).unwrap_or(html.len());
            let tag = &lower[i..end];
            // A block boundary is a line break; an inline tag disappears with
            // no trace so words don't get glued together across it.
            if ["<p", "</p", "<br", "<div", "</div", "<li", "</li", "<tr", "</tr", "<h1", "<h2",
                "<h3", "<h4", "</h1", "</h2", "</h3", "</h4", "</ul", "</ol", "</table", "</section"]
                .iter()
                .any(|b| tag.starts_with(b))
            {
                cleaned.push('\n');
            } else {
                cleaned.push(' ');
            }
            i = end;
            continue;
        }
        let next = html[i..].find('<').map(|off| i + off).unwrap_or(html.len());
        cleaned.push_str(&html[i..next]);
        i = next;
    }
    collapse(&decode_entities(&cleaned))
}

/// The handful of entities that actually appear in prose, plus numeric refs.
fn decode_entities(s: &str) -> String {
    let mut out = s
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
        .replace("&hellip;", "…")
        .replace("&rsquo;", "’")
        .replace("&lsquo;", "‘")
        .replace("&ldquo;", "“")
        .replace("&rdquo;", "”");
    if out.contains("&#") {
        let re = regex::Regex::new(r"&#(\d{1,7});").expect("static pattern");
        out = re
            .replace_all(&out, |c: &regex::Captures| {
                c[1].parse::<u32>()
                    .ok()
                    .and_then(char::from_u32)
                    .map(String::from)
                    .unwrap_or_default()
            })
            .into_owned();
    }
    out
}

/// Squeeze the runs of whitespace markup leaves behind, keeping paragraph
/// breaks (a blank line) but never more than one.
fn collapse(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank_run = 0usize;
    for line in s.lines() {
        let trimmed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
            out.push('\n');
        } else {
            blank_run = 0;
            out.push_str(&trimmed);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}\n\n… [truncated at {max} characters]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_domain_is_assumed_to_be_https() {
        assert_eq!(normalize_url("askangle.com").unwrap(), "https://askangle.com");
        assert_eq!(normalize_url("http://x.dev").unwrap(), "http://x.dev");
    }

    #[test]
    fn a_web_tool_cannot_be_turned_into_a_file_reader() {
        // `file:///etc/passwd` through a "fetch a URL" tool would hand the
        // model local files it was never granted.
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("ftp://host/x").is_err());
    }

    #[test]
    fn the_cloud_metadata_endpoint_is_off_limits() {
        assert!(is_blocked_host("http://169.254.169.254/latest/meta-data/"));
        assert!(is_blocked_host("http://metadata.google.internal/x"));
        assert!(!is_blocked_host("https://example.com/169.254.169.254"));
    }

    #[test]
    fn scripts_and_styles_never_reach_the_model() {
        let html = "<html><head><title>t</title></head><body>\
            <style>.a{color:red}</style><script>var x = 1 < 2;</script>\
            <p>Hello there</p></body></html>";
        let text = html_to_text(html);
        assert!(text.contains("Hello there"));
        assert!(!text.contains("color:red"), "style body leaked: {text}");
        assert!(!text.contains("var x"), "script body leaked: {text}");
        assert!(!text.contains("<p>"));
    }

    #[test]
    fn block_tags_break_lines_and_inline_tags_do_not_glue_words() {
        let text = html_to_text("<p>one</p><p>two</p><span>a</span> <span>b</span>");
        let lines: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
        // Each block on its own line — "onetwo" would read as one word.
        assert_eq!(lines, vec!["one", "two", "a b"], "got {text:?}");
    }

    #[test]
    fn entities_come_back_as_the_characters_they_stand_for() {
        assert_eq!(html_to_text("<p>Tom &amp; Jerry &#8212; &quot;hi&quot;</p>"), "Tom & Jerry — \"hi\"");
    }

    /// The one test that can tell us a backend has been blocked. Ignored by
    /// default because it needs the network — a suite that fails on a plane is
    /// a suite people learn to skip. Run it when search looks wrong:
    ///   cargo test --lib web_tools -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn the_web_tools_reach_the_real_web() {
        let (results, err) = execute("web_search", &json!({ "query": "rust async book" })).await;
        println!("--- search ---\n{results}");
        assert!(!err, "search errored: {results}");
        assert!(results.contains("http"), "no usable URL came back: {results}");

        let (page, err) = execute("web_fetch", &json!({ "url": "example.com" })).await;
        println!("--- fetch ---\n{page}");
        assert!(!err, "fetch errored: {page}");
        assert!(page.contains("Example Domain"), "page text missing: {page}");
    }

    #[test]
    fn a_feed_item_yields_a_directly_fetchable_hit() {
        let xml = concat!(
            "<rss><channel><item><title>Ampersand &amp; Co</title>",
            "<link>https://example.com/a</link>",
            "<description>First &lt;b&gt;hit&lt;/b&gt;</description></item>",
            "<item><title>Two</title><link>https://example.com/b</link>",
            "<description>Second</description></item></channel></rss>",
        );
        let hits = parse_rss(xml, 5);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "Ampersand & Co");
        assert_eq!(hits[0].url, "https://example.com/a");
        // Markup inside a description must not reach the model.
        assert_eq!(hits[0].snippet, "First hit");
        // The limit is a limit, not a suggestion.
        assert_eq!(parse_rss(xml, 1).len(), 1);
        // A feed with no items is empty, not a panic.
        assert!(parse_rss("<rss><channel></channel></rss>", 5).is_empty());
    }

    #[test]
    fn a_result_row_yields_the_real_url_not_the_redirector() {
        let html = r##"<div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&amp;rut=x">Example &amp; Co</a>
            <a class="result__snippet" href="#">A short <b>description</b>.</a></div>"##;
        let hits = parse_results(html, 5);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://example.com/a?b=1");
        assert_eq!(hits[0].title, "Example & Co");
        assert!(hits[0].snippet.contains("A short description"));
    }

    #[test]
    fn the_result_limit_is_honoured() {
        let row = r#"<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fe.com">t</a>"#;
        let html = row.repeat(10);
        assert_eq!(parse_results(&html, 3).len(), 3);
    }

    #[test]
    fn truncation_says_so_instead_of_stopping_mid_sentence_silently() {
        let out = truncate(&"x".repeat(100), 10);
        assert!(out.contains("truncated at 10 characters"));
        assert_eq!(truncate("short", 10), "short");
    }

    #[test]
    fn both_tools_are_declared_and_recognised() {
        let names: Vec<String> = schemas()
            .iter()
            .map(|s| s["name"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(names, vec!["web_fetch", "web_search"]);
        for n in &names {
            assert!(is_web_tool(n));
        }
        assert!(!is_web_tool("aura_tasks_list"));
    }
}
