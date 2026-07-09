//! In-app browser — a real native WebKit webview embedded inside the ADE
//! window, NOT an `<iframe>`. The previous rail browser was an iframe, so any
//! site sending `X-Frame-Options` / `frame-ancestors` (Google, GitHub, most
//! of the web) refused to load and the panel read as "flaky and childish".
//!
//! Here each browser tab is a genuine child webview added to the `main`
//! window via `Window::add_child` (Tauri's `unstable` multi-webview API).
//! Because it's a top-level navigation in its own webview — not a framed
//! document — it loads ANY URL. The React side renders only the chrome
//! (address bar, tabs, AI strip) and leaves a transparent "hole"; this module
//! keeps the native webview positioned exactly over that hole via
//! `browser_set_bounds`.
//!
//! The webview is deliberately NOT granted Tauri IPC access, so an untrusted
//! page cannot reach our `invoke` surface. All control flows the other way:
//! Rust drives the page through `navigate` / `eval` / `eval_with_callback`,
//! which is also how the agentic "navigate-by-prompt" loop reads page text
//! (`browser_extract`) and performs actions (`browser_eval`).
//!
//! Events: every navigation + page-load emits `browser:state` carrying
//! `{ tabId, url, title, loading }`; the frontend filters by `tabId`.

use std::collections::HashSet;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, State, Url,
    WebviewUrl,
};

/// Live browser-tab registry. The native webviews themselves are owned by the
/// Tauri window (looked up by label); this set just tracks which tab ids we
/// created so `browser_open` is idempotent and teardown can sweep them.
///
/// `pending_close` / `pending_hide` are tombstones for the open↔close race:
/// `browser_open` is an async command that only registers the webview at the
/// END of its (multi-millisecond) `add_child` build, while `browser_close` /
/// `browser_hide` are sync commands that look the webview up by label. Tauri
/// commands don't serialise, so a close arriving mid-build finds no webview,
/// no-ops, and would leave a visible orphan once the build finishes. When a
/// close/hide can't find its webview we tombstone the id here; `browser_open`
/// honours the tombstone the moment the build completes.
pub struct BrowserManager {
    tabs: Mutex<HashSet<String>>,
    pending_close: Mutex<HashSet<String>>,
    pending_hide: Mutex<HashSet<String>>,
}

impl BrowserManager {
    pub fn new() -> Self {
        Self {
            tabs: Mutex::new(HashSet::new()),
            pending_close: Mutex::new(HashSet::new()),
            pending_hide: Mutex::new(HashSet::new()),
        }
    }

    fn insert(&self, tab_id: &str) {
        if let Ok(mut g) = self.tabs.lock() {
            g.insert(tab_id.to_string());
        }
    }

    fn remove(&self, tab_id: &str) {
        if let Ok(mut g) = self.tabs.lock() {
            g.remove(tab_id);
        }
    }

    fn has(&self, tab_id: &str) -> bool {
        self.tabs
            .lock()
            .map(|g| g.contains(tab_id))
            .unwrap_or(false)
    }

    /// Mark a close that raced ahead of the webview's build. A pending close
    /// supersedes a pending hide for the same id (close wins).
    fn mark_pending_close(&self, tab_id: &str) {
        if let Ok(mut g) = self.pending_hide.lock() {
            g.remove(tab_id);
        }
        if let Ok(mut g) = self.pending_close.lock() {
            g.insert(tab_id.to_string());
        }
    }

    /// Mark a hide that raced ahead of the webview's build.
    fn mark_pending_hide(&self, tab_id: &str) {
        if let Ok(mut g) = self.pending_hide.lock() {
            g.insert(tab_id.to_string());
        }
    }

    /// Consume the close tombstone, if any.
    fn take_pending_close(&self, tab_id: &str) -> bool {
        self.pending_close
            .lock()
            .map(|mut g| g.remove(tab_id))
            .unwrap_or(false)
    }

    /// Consume the hide tombstone, if any.
    fn take_pending_hide(&self, tab_id: &str) -> bool {
        self.pending_hide
            .lock()
            .map(|mut g| g.remove(tab_id))
            .unwrap_or(false)
    }
}

/// One `browser:state` event payload. `title` is filled on page load (a fresh
/// navigation emits `loading: true` with no title yet).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BrowserState {
    tab_id: String,
    url: String,
    title: Option<String>,
    loading: bool,
}

/// Result of `browser_extract` — what the agentic loop reads to decide its
/// next action. `text` is the rendered `innerText`, capped so a huge page
/// can't blow the model's context.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PageSnapshot {
    pub title: String,
    pub url: String,
    pub text: String,
}

/// JS that serialises the visible page into a `PageSnapshot`. Wrapped in a
/// try/catch so a hostile or half-loaded document degrades to an empty
/// snapshot instead of rejecting the eval.
const EXTRACT_JS: &str = r#"(function(){try{return JSON.stringify({title:document.title||"",url:location.href,text:(document.body?document.body.innerText:"").slice(0,12000)});}catch(e){return JSON.stringify({title:"",url:location.href,text:""});}})()"#;

/// JS that returns just the current document title (used to enrich the
/// `browser:state` event once a page finishes loading).
const TITLE_JS: &str = r#"(document.title||"")"#;

const MAIN_WINDOW: &str = "main";

/// Native webview label for a tab id. Kept distinct from the `main` /
/// `popout-*` namespaces so window sweeps never confuse a browser tab.
fn label_for(tab_id: &str) -> String {
    format!("aura-browser-{tab_id}")
}

/// Turn whatever the address bar holds into a real URL. Explicit schemes pass
/// through; a bare host gets `https://` prepended. (The TS side already does
/// search-vs-URL disambiguation, so anything reaching here is meant to be a
/// destination.)
fn parse_url(raw: &str) -> Result<Url, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("empty url".to_string());
    }
    if let Ok(u) = Url::parse(s) {
        return Ok(u);
    }
    Url::parse(&format!("https://{s}")).map_err(|e| e.to_string())
}

fn bounds(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        position: Position::from(LogicalPosition::new(x, y)),
        size: Size::from(LogicalSize::new(width.max(0.0), height.max(0.0))),
    }
}

fn emit_state(app: &AppHandle, tab_id: &str, url: String, title: Option<String>, loading: bool) {
    let _ = app.emit(
        "browser:state",
        BrowserState {
            tab_id: tab_id.to_string(),
            url,
            title,
            loading,
        },
    );
}

/// Open (or re-target) a browser tab. If the tab already exists this just
/// navigates it and repositions it over the hole — so the rail re-mounting
/// never spawns a duplicate native layer.
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    tab_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let target = parse_url(&url)?;
    let label = label_for(&tab_id);

    // Idempotent: an existing tab is navigated + repositioned, not rebuilt.
    if manager.has(&tab_id) {
        if let Some(webview) = app.get_webview(&label) {
            webview
                .set_bounds(bounds(x, y, width, height))
                .map_err(|e| e.to_string())?;
            webview.navigate(target).map_err(|e| e.to_string())?;
            webview.show().map_err(|e| e.to_string())?;
            return Ok(());
        }
        // Registry drifted from reality (window closed underneath us) — fall
        // through and rebuild.
        manager.remove(&tab_id);
    }

    let window = app
        .get_window(MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())?;

    let nav_app = app.clone();
    let nav_tab = tab_id.clone();
    let load_app = app.clone();
    let load_tab = tab_id.clone();

    let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(target))
        .on_navigation(move |u| {
            // Every navigation (link click, JS redirect, address-bar go) flips
            // the tab into the loading state with its new URL. Returning true
            // allows the navigation — we never block.
            emit_state(&nav_app, &nav_tab, u.to_string(), None, true);
            true
        })
        .on_page_load(move |webview, payload| {
            if !matches!(payload.event(), PageLoadEvent::Finished) {
                return;
            }
            let url = payload.url().to_string();
            emit_state(&load_app, &load_tab, url.clone(), None, false);
            // Enrich with the title once the document settled.
            let title_app = load_app.clone();
            let title_tab = load_tab.clone();
            let title_url = url;
            let _ = webview.eval_with_callback(TITLE_JS, move |raw| {
                let title = serde_json::from_str::<String>(&raw).unwrap_or(raw);
                emit_state(&title_app, &title_tab, title_url.clone(), Some(title), false);
            });
        });

    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(0.0), height.max(0.0)),
        )
        .map_err(|e| e.to_string())?;

    // A concurrent browser_close / browser_hide may have arrived while this
    // webview was still building (Tauri commands don't serialise). It couldn't
    // find the webview then and tombstoned the id; honour it now that the
    // child exists, so a close never leaves a visible orphan.
    if manager.take_pending_close(&tab_id) {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
        manager.remove(&tab_id);
        return Ok(());
    }
    manager.insert(&tab_id);
    if manager.take_pending_hide(&tab_id) {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.hide();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, tab_id: String, url: String) -> Result<(), String> {
    let target = parse_url(&url)?;
    let webview = app
        .get_webview(&label_for(&tab_id))
        .ok_or_else(|| format!("no browser tab '{tab_id}'"))?;
    webview.navigate(target).map_err(|e| e.to_string())
}

/// Reposition / resize the native webview to track the React hole. Called on
/// layout, scroll, and window resize. A missing tab is a silent no-op so a
/// teardown race never surfaces an error to the UI.
#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label_for(&tab_id)) {
        webview
            .set_bounds(bounds(x, y, width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_show(app: AppHandle, tab_id: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label_for(&tab_id)) {
        webview.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_hide(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    tab_id: String,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label_for(&tab_id)) {
        webview.hide().map_err(|e| e.to_string())?;
    } else {
        // No webview yet — it may be mid-build inside a concurrent browser_open.
        // Tombstone the hide so the build hides itself on completion. If a close
        // is also pending the open tail honours that first (it checks
        // take_pending_close before take_pending_hide) and this tombstone is
        // simply never consumed — close always wins.
        manager.mark_pending_hide(&tab_id);
    }
    Ok(())
}

#[tauri::command]
pub fn browser_back(app: AppHandle, tab_id: String) -> Result<(), String> {
    eval_history(&app, &tab_id, "history.back()")
}

#[tauri::command]
pub fn browser_forward(app: AppHandle, tab_id: String) -> Result<(), String> {
    eval_history(&app, &tab_id, "history.forward()")
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, tab_id: String) -> Result<(), String> {
    eval_history(&app, &tab_id, "location.reload()")
}

fn eval_history(app: &AppHandle, tab_id: &str, js: &str) -> Result<(), String> {
    let webview = app
        .get_webview(&label_for(tab_id))
        .ok_or_else(|| format!("no browser tab '{tab_id}'"))?;
    webview.eval(js).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_close(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    tab_id: String,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label_for(&tab_id)) {
        let _ = webview.close();
        manager.remove(&tab_id);
    } else {
        // The webview may still be mid-build inside a concurrent browser_open.
        // Tombstone the close so that build tears itself down on completion
        // instead of leaving a visible orphan.
        manager.mark_pending_close(&tab_id);
        manager.remove(&tab_id);
    }
    Ok(())
}

/// Read the current page for the agentic loop: title, url, and rendered text.
/// Bridges Tauri's fire-and-forget `eval_with_callback` into an awaitable
/// result via a oneshot channel, with a hard timeout so a wedged page can't
/// hang the loop.
#[tauri::command]
pub async fn browser_extract(app: AppHandle, tab_id: String) -> Result<PageSnapshot, String> {
    let webview = app
        .get_webview(&label_for(&tab_id))
        .ok_or_else(|| format!("no browser tab '{tab_id}'"))?;

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    // The callback is `Fn` but a oneshot sender is single-use, so park it in
    // an Option behind a mutex and take it on first fire.
    let slot = std::sync::Arc::new(Mutex::new(Some(tx)));
    let slot_cb = slot.clone();
    webview
        .eval_with_callback(EXTRACT_JS, move |raw| {
            if let Ok(mut guard) = slot_cb.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(raw);
                }
            }
        })
        .map_err(|e| e.to_string())?;

    let raw = tokio::time::timeout(std::time::Duration::from_secs(3), rx)
        .await
        .map_err(|_| "page extract timed out".to_string())?
        .map_err(|_| "page extract channel closed".to_string())?;

    parse_snapshot(&raw)
}

/// Run arbitrary JS in the page (agentic click / fill). Best-effort: the
/// result is not returned, only success/failure of dispatch.
#[tauri::command]
pub fn browser_eval(app: AppHandle, tab_id: String, js: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label_for(&tab_id))
        .ok_or_else(|| format!("no browser tab '{tab_id}'"))?;
    webview.eval(&js).map_err(|e| e.to_string())
}

/// Like `browser_eval`, but bridges the evaluated result back to the caller as
/// a raw string — the same oneshot/timeout pattern `browser_extract` uses, just
/// with caller-supplied JS instead of the fixed `EXTRACT_JS`. The annotation
/// reader uses it to pull `window.__auraAnnotations` out of the page on demand.
/// The JS MUST return a string (e.g. `JSON.stringify(value)`); the raw payload
/// is handed back untouched for the TS side to parse (it may be one JSON-string
/// layer deep, exactly like `parse_snapshot` unwraps).
#[tauri::command]
pub async fn browser_eval_read(
    app: AppHandle,
    tab_id: String,
    js: String,
) -> Result<String, String> {
    let webview = app
        .get_webview(&label_for(&tab_id))
        .ok_or_else(|| format!("no browser tab '{tab_id}'"))?;

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let slot = std::sync::Arc::new(Mutex::new(Some(tx)));
    let slot_cb = slot.clone();
    webview
        .eval_with_callback(&js, move |raw| {
            if let Ok(mut guard) = slot_cb.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(raw);
                }
            }
        })
        .map_err(|e| e.to_string())?;

    tokio::time::timeout(std::time::Duration::from_secs(3), rx)
        .await
        .map_err(|_| "page eval timed out".to_string())?
        .map_err(|_| "page eval channel closed".to_string())
}

/// Detach a tab's native webview into another window — the "pop browser out
/// into its own OS window" path. `reparent` moves the SAME webview (live page,
/// scroll position, login session all intact) under the target window, then we
/// position it over that window's hole. The main rail has already forgotten the
/// tab (`detachTab`), so it stops reconciling it; the popout drives it from
/// here on. Looked up by the global webview label, so it works regardless of
/// which window currently hosts the tab.
#[tauri::command]
pub fn browser_reparent(
    app: AppHandle,
    tab_id: String,
    window_label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label_for(&tab_id))
        .ok_or_else(|| format!("no browser tab '{tab_id}'"))?;
    let window = app
        .get_window(&window_label)
        .ok_or_else(|| format!("no window '{window_label}'"))?;
    webview.reparent(&window).map_err(|e| e.to_string())?;
    webview
        .set_bounds(bounds(x, y, width, height))
        .map_err(|e| e.to_string())?;
    webview.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// The `eval_with_callback` result is the JSON serialisation of the evaluated
/// JS value. `EXTRACT_JS` returns a string, so the raw payload is usually a
/// JSON-encoded string wrapping the real object — but some platforms hand back
/// the object directly. Try the direct shape first, then unwrap one string
/// layer.
fn parse_snapshot(raw: &str) -> Result<PageSnapshot, String> {
    if let Ok(snap) = serde_json::from_str::<PageSnapshot>(raw) {
        return Ok(snap);
    }
    if let Ok(inner) = serde_json::from_str::<String>(raw) {
        if let Ok(snap) = serde_json::from_str::<PageSnapshot>(&inner) {
            return Ok(snap);
        }
    }
    Err(format!(
        "could not parse page snapshot: {}",
        raw.chars().take(120).collect::<String>()
    ))
}
