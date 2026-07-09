// Typed bridge to the native browser webview manager (src-tauri/cmd_browser.rs).
//
// Each browser tab is a REAL WebKit child webview owned by the Rust backend
// and keyed by a tab id. These wrappers are the only place the frontend talks
// to it: the React shell renders chrome + a transparent "hole", measures the
// hole's rect, and calls `browserSetBounds` so the native webview tracks it.
//
// Tauri converts camelCase JS arg keys to the Rust snake_case params
// (`tabId` → `tab_id`), matching the rest of `api.ts`.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Logical-pixel rect for positioning the native webview over the hole. */
export type BrowserRect = { x: number; y: number; width: number; height: number };

/** Page read used by the agentic loop (title + url + rendered innerText). */
export type PageSnapshot = { title: string; url: string; text: string };

/** One `browser:state` event — a navigation start (loading, no title yet) or
 *  a settled page (title filled, loading false). Frontend filters by tabId. */
export type BrowserStateEvent = {
  tabId: string;
  url: string;
  title: string | null;
  loading: boolean;
};

export function browserOpen(tabId: string, url: string, rect: BrowserRect): Promise<void> {
  return invoke("browser_open", {
    tabId,
    url,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });
}

export function browserNavigate(tabId: string, url: string): Promise<void> {
  return invoke("browser_navigate", { tabId, url });
}

export function browserSetBounds(tabId: string, rect: BrowserRect): Promise<void> {
  return invoke("browser_set_bounds", {
    tabId,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });
}

export function browserShow(tabId: string): Promise<void> {
  return invoke("browser_show", { tabId });
}

export function browserHide(tabId: string): Promise<void> {
  return invoke("browser_hide", { tabId });
}

export function browserBack(tabId: string): Promise<void> {
  return invoke("browser_back", { tabId });
}

export function browserForward(tabId: string): Promise<void> {
  return invoke("browser_forward", { tabId });
}

export function browserReload(tabId: string): Promise<void> {
  return invoke("browser_reload", { tabId });
}

export function browserClose(tabId: string): Promise<void> {
  return invoke("browser_close", { tabId });
}

export function browserExtract(tabId: string): Promise<PageSnapshot> {
  return invoke("browser_extract", { tabId });
}

export function browserEval(tabId: string, js: string): Promise<void> {
  return invoke("browser_eval", { tabId, js });
}

/** Move a tab's native webview under another window (the detach-to-popout
 *  path) and position it over that window's hole. The live page is preserved —
 *  it's the SAME webview, just reparented. */
export function browserReparent(
  tabId: string,
  windowLabel: string,
  rect: BrowserRect,
): Promise<void> {
  return invoke("browser_reparent", {
    tabId,
    windowLabel,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });
}

/** Subscribe to native nav/load state. Returns the unlisten fn. */
export function onBrowserState(cb: (ev: BrowserStateEvent) => void): Promise<UnlistenFn> {
  return listen<BrowserStateEvent>("browser:state", (e) => cb(e.payload));
}

/** Turn an address-bar entry into a destination: explicit scheme passes
 *  through, localhost gets http, a bare host gets https, and anything else is
 *  a web search. Unlike the old iframe (which needed DuckDuckGo's lite HTML to
 *  dodge X-Frame-Options), a real webview loads normal search results. */
export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(s)) return `http://${s}`;
  if (/^[^\s]+\.[^\s]+$/.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

/** Host label for the address bar / tab title fallback. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// ── Agentation — click-to-annotate a live page (Conductor parity) ────────────
//
// The native webview paints above the React DOM, so we can't overlay our own
// click capture on top of it. Instead we INJECT a small in-page script that
// owns the annotate UX entirely inside the page: a hover outline, a capture-
// phase click handler that records the element (selector + text + position)
// and drops a numbered pin, and a teardown. The recorded list lives on
// `window.__auraAnnotations`; we read it back on demand via `browser_eval_read`.
// Everything an agent needs (page url + each element's selector and text) is
// plain text, so it works for the native brain and every CLI agent alike.

/** One captured annotation, mirrored from the in-page recorder. */
export type PageAnnotation = {
  n: number;
  selector: string;
  tag: string;
  text: string;
  x: number;
  y: number;
};

/** Run the caller's JS in the page and bridge back its string result. The JS
 *  MUST return a string. The raw payload may be one JSON-string layer deep
 *  (platform-dependent), so callers parse defensively. */
export function browserEvalRead(tabId: string, js: string): Promise<string> {
  return invoke<string>("browser_eval_read", { tabId, js });
}

const ANNOTATE_INSTALL_JS = `(function(){try{
  var W=window;
  W.__auraAnnotations=W.__auraAnnotations||[];
  var st=W.__auraAnn;
  if(st&&st.on){return;}
  st=W.__auraAnn={on:true,pins:[],hl:null};
  var hl=document.createElement('div');
  hl.style.cssText='position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #3b82f6;background:rgba(59,130,246,0.12);border-radius:3px;display:none;';
  document.documentElement.appendChild(hl);
  st.hl=hl;
  function sel(el){try{
    if(!el||el.nodeType!==1)return '';
    if(el.id)return '#'+el.id;
    var parts=[],node=el,depth=0;
    while(node&&node.nodeType===1&&depth<4){
      var s=node.tagName.toLowerCase();
      if(node.id){parts.unshift('#'+node.id);break;}
      if(node.classList&&node.classList.length){s+='.'+Array.prototype.slice.call(node.classList,0,2).join('.');}
      var p=node.parentNode;
      if(p){var sibs=Array.prototype.filter.call(p.children,function(c){return c.tagName===node.tagName;});
        if(sibs.length>1){s+=':nth-of-type('+(Array.prototype.indexOf.call(sibs,node)+1)+')';}}
      parts.unshift(s);node=p;depth++;
    }
    return parts.join(' > ');
  }catch(e){return '';}}
  st.move=function(e){var el=e.target;if(!el||el===hl){hl.style.display='none';return;}
    var r=el.getBoundingClientRect();hl.style.display='block';
    hl.style.left=r.left+'px';hl.style.top=r.top+'px';hl.style.width=r.width+'px';hl.style.height=r.height+'px';};
  st.click=function(e){try{var el=e.target;if(!el)return;
    e.preventDefault();e.stopPropagation();
    var r=el.getBoundingClientRect();var n=W.__auraAnnotations.length+1;
    var t=(el.innerText||el.textContent||el.value||(el.getAttribute&&el.getAttribute('aria-label'))||'').trim().replace(/\\s+/g,' ').slice(0,200);
    W.__auraAnnotations.push({n:n,selector:sel(el),tag:el.tagName?el.tagName.toLowerCase():'',text:t,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});
    var pin=document.createElement('div');pin.textContent=String(n);
    pin.style.cssText='position:absolute;z-index:2147483647;left:'+(r.left+window.scrollX+r.width/2-11)+'px;top:'+(r.top+window.scrollY+r.height/2-11)+'px;width:22px;height:22px;border-radius:50%;background:#3b82f6;color:#fff;font:600 11px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.4);pointer-events:none;';
    document.documentElement.appendChild(pin);st.pins.push(pin);
  }catch(_){}};
  document.addEventListener('mousemove',st.move,true);
  document.addEventListener('click',st.click,true);
  if(document.body)document.body.style.cursor='crosshair';
}catch(e){}})();`;

const ANNOTATE_TEARDOWN_JS = `(function(){try{
  var W=window,st=W.__auraAnn;
  if(st){
    if(st.move)document.removeEventListener('mousemove',st.move,true);
    if(st.click)document.removeEventListener('click',st.click,true);
    if(st.hl&&st.hl.parentNode)st.hl.parentNode.removeChild(st.hl);
    (st.pins||[]).forEach(function(p){if(p.parentNode)p.parentNode.removeChild(p);});
    st.on=false;st.pins=[];st.hl=null;
  }
  if(document.body)document.body.style.cursor='';
  W.__auraAnnotations=[];
}catch(e){}})();`;

/** Turn the page into annotate mode: hover outline + click-to-pin. Idempotent;
 *  re-installable after a navigation (a fresh document loses the script). */
export function installAnnotator(tabId: string): Promise<void> {
  return browserEval(tabId, ANNOTATE_INSTALL_JS);
}

/** Leave annotate mode: remove handlers, outline, and pins, and clear the
 *  recorded list. */
export function clearAnnotator(tabId: string): Promise<void> {
  return browserEval(tabId, ANNOTATE_TEARDOWN_JS);
}

/** Read the annotations recorded so far. Tolerates the one-string-layer-deep
 *  encoding `browser_eval_read` may return, and never throws — a wedged or
 *  navigated page just yields an empty list. */
export async function readAnnotations(tabId: string): Promise<PageAnnotation[]> {
  try {
    const raw = await browserEvalRead(
      tabId,
      "JSON.stringify(window.__auraAnnotations||[])",
    );
    let val: unknown = JSON.parse(raw);
    if (typeof val === "string") {
      val = JSON.parse(val);
    }
    return Array.isArray(val) ? (val as PageAnnotation[]) : [];
  } catch {
    return [];
  }
}
