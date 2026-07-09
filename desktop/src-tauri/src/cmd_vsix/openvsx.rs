//! Open VSX gallery client. Open VSX (open-vsx.org, run by the Eclipse
//! Foundation) is the ONLY gallery a non-Microsoft product is permitted to
//! use — the Microsoft Marketplace Terms of Use forbid it, and that's enforced.
//! Every download URL comes from the API response and is re-pinned to the
//! Open VSX host before we fetch, so a poisoned response can't redirect us.

use std::time::Duration;

use super::archive::summarize_contributes;
use super::model::{ContributesSummary, OpenVsxHit};

const OPEN_VSX_API: &str = "https://open-vsx.org/api";
const DOWNLOAD_MAX_BYTES: u64 = 96 * 1024 * 1024;
const USER_AGENT: &str = "Aura-Desktop";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// Search Open VSX. Returns listing metadata only.
pub async fn search(query: &str, size: u32) -> Result<Vec<OpenVsxHit>, String> {
    let size = size.clamp(1, 50);
    let size_s = size.to_string();
    let resp = client()?
        .get(format!("{OPEN_VSX_API}/-/search"))
        .query(&[
            ("query", query),
            ("size", size_s.as_str()),
            ("offset", "0"),
            ("sortBy", "relevance"),
            ("sortOrder", "desc"),
            ("includeAllVersions", "false"),
        ])
        .send()
        .await
        .map_err(|e| format!("search request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Open VSX search failed: HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("search json: {e}"))?;
    let items = v
        .get("extensions")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items.iter().map(hit_from_search).collect())
}

/// Browse the gallery without a search term — by category and/or popularity.
/// Powers the Discover grid's curated rows ("Color themes", "Language support",
/// "Popular") so a non-engineer can explore live listings instead of having to
/// know what to type. Listing metadata only — no code is fetched.
pub async fn browse(
    category: Option<&str>,
    sort: &str,
    size: u32,
) -> Result<Vec<OpenVsxHit>, String> {
    let size = size.clamp(1, 50);
    let size_s = size.to_string();
    // Map our calm sort tokens onto Open VSX's field names.
    let sort_by = match sort {
        "downloads" => "downloadCount",
        "rating" => "averageRating",
        "updated" => "timestamp",
        _ => "relevance",
    };
    let mut params: Vec<(&str, &str)> = vec![
        ("size", size_s.as_str()),
        ("offset", "0"),
        ("sortBy", sort_by),
        ("sortOrder", "desc"),
        ("includeAllVersions", "false"),
    ];
    let cat = category.map(str::trim).filter(|c| !c.is_empty());
    if let Some(c) = cat {
        params.push(("category", c));
    }
    let resp = client()?
        .get(format!("{OPEN_VSX_API}/-/search"))
        .query(&params)
        .send()
        .await
        .map_err(|e| format!("browse request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Open VSX browse failed: HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("browse json: {e}"))?;
    let items = v
        .get("extensions")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items.iter().map(hit_from_search).collect())
}

fn hit_from_search(it: &serde_json::Value) -> OpenVsxHit {
    let s = |k: &str| {
        it.get(k)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
    };
    let display_name = {
        let d = s("displayName");
        if d.is_empty() {
            s("name")
        } else {
            d
        }
    };
    let icon_url = it
        .get("files")
        .and_then(|f| f.get("icon"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    OpenVsxHit {
        namespace: s("namespace"),
        name: s("name"),
        display_name,
        version: s("version"),
        description: s("description"),
        download_count: it.get("downloadCount").and_then(|x| x.as_u64()).unwrap_or(0),
        average_rating: it.get("averageRating").and_then(|x| x.as_f64()),
        icon_url,
        timestamp: it.get("timestamp").and_then(|x| x.as_str()).map(|s| s.to_string()),
    }
}

/// Summarise an extension's declarative `contributes` straight from the gallery
/// — WITHOUT downloading or extracting its `.vsix`. Two cheap, host-pinned GETs:
/// the metadata record (for its `files.manifest` URL), then the manifest
/// (`package.json`) itself, run through the same summariser an installed bundle
/// uses. Lets the Discover view tell a non-engineer what they'll actually get
/// (or that it "runs its own program") *before* they install.
pub async fn preview_contributes(
    namespace: &str,
    name: &str,
) -> Result<ContributesSummary, String> {
    let c = client()?;
    let meta: serde_json::Value = c
        .get(format!("{OPEN_VSX_API}/{namespace}/{name}"))
        .send()
        .await
        .map_err(|e| format!("preview request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("preview lookup for {namespace}.{name}: {e}"))?
        .json()
        .await
        .map_err(|e| format!("preview json: {e}"))?;

    let manifest_url = meta
        .get("files")
        .and_then(|f| f.get("manifest"))
        .and_then(|x| x.as_str())
        .ok_or_else(|| format!("{namespace}.{name} has no manifest on Open VSX"))?;
    // The manifest URL comes from the API response — re-pin it to the Open VSX
    // host before fetching, exactly like the download path does.
    if !is_open_vsx_url(manifest_url) {
        return Err("refusing to read a manifest from a non-Open-VSX host".into());
    }

    let manifest: serde_json::Value = c
        .get(manifest_url)
        .send()
        .await
        .map_err(|e| format!("manifest request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("manifest fetch: {e}"))?
        .json()
        .await
        .map_err(|e| format!("manifest json: {e}"))?;

    Ok(summarize_contributes(&manifest))
}

/// The resolved download target for an extension.
pub struct Resolved {
    pub version: String,
    pub download_url: String,
}

/// Resolve an extension's downloadable `.vsix` URL via the metadata API.
/// `version` None → latest published version.
pub async fn resolve(
    namespace: &str,
    name: &str,
    version: Option<&str>,
) -> Result<Resolved, String> {
    let url = match version {
        Some(v) if !v.trim().is_empty() => format!("{OPEN_VSX_API}/{namespace}/{name}/{v}"),
        _ => format!("{OPEN_VSX_API}/{namespace}/{name}"),
    };
    let resp = client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("resolve request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Open VSX lookup failed for {namespace}.{name}: HTTP {}",
            resp.status()
        ));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("resolve json: {e}"))?;
    let download = v
        .get("files")
        .and_then(|f| f.get("download"))
        .and_then(|x| x.as_str())
        .ok_or_else(|| format!("{namespace}.{name} has no downloadable .vsix on Open VSX"))?;
    let resolved_version = v
        .get("version")
        .and_then(|x| x.as_str())
        .unwrap_or(version.unwrap_or(""))
        .to_string();
    Ok(Resolved {
        version: resolved_version,
        download_url: download.to_string(),
    })
}

/// Download a `.vsix` to bytes, host-pinned and size-capped.
pub async fn download(url: &str) -> Result<Vec<u8>, String> {
    if !is_open_vsx_url(url) {
        return Err("refusing to download from a non-Open-VSX host".into());
    }
    let resp = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    if let Some(len) = resp.content_length() {
        if len > DOWNLOAD_MAX_BYTES {
            return Err(format!("vsix too large: {len} bytes"));
        }
    }
    let bytes = resp.bytes().await.map_err(|e| format!("download body: {e}"))?;
    if bytes.len() as u64 > DOWNLOAD_MAX_BYTES {
        return Err("vsix exceeds size limit".into());
    }
    Ok(bytes.to_vec())
}

/// Accept only `https://open-vsx.org` (and subdomains). The MS Marketplace and
/// any other host are refused outright.
fn is_open_vsx_url(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(u) => {
            u.scheme() == "https"
                && u
                    .host_str()
                    .map(|h| h == "open-vsx.org" || h.ends_with(".open-vsx.org"))
                    .unwrap_or(false)
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_open_vsx_hosts_pass() {
        assert!(is_open_vsx_url(
            "https://open-vsx.org/api/redhat/java/1.0.0/file/redhat.java-1.0.0.vsix"
        ));
        assert!(is_open_vsx_url("https://openvsxorg.blob.open-vsx.org/x.vsix"));
        // The MS Marketplace and lookalikes are refused.
        assert!(!is_open_vsx_url(
            "https://marketplace.visualstudio.com/_apis/public/gallery/x.vsix"
        ));
        assert!(!is_open_vsx_url("https://evil-open-vsx.org.attacker.com/x.vsix"));
        assert!(!is_open_vsx_url("http://open-vsx.org/x.vsix")); // not https
        assert!(!is_open_vsx_url("not a url"));
    }
}
