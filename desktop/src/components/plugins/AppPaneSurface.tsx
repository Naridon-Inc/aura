// Full-surface render for a plugin mini-app workpane (`app` pane kind).
//
// A "mini-app" is a plugin `contributes.apps[]` entry — a Gmail/Gemini/
// Reddit-style client that takes the whole work area instead of a narrow
// rail panel. It runs in the EXACT same sandbox as a rail panel
// (`PluginSandboxFrame`: opaque-origin `sandbox="allow-scripts"` iframe +
// capability-checked postMessage bridge, re-checked in Rust) — only the
// sizing differs. The single shared frame means a full app can never get a
// weaker sandbox than a panel.
//
// The pane carries an opaque `<pluginId>:<appId>` key. We resolve it against
// the LIVE contributes rows on every render so that disabling/uninstalling a
// plugin out from under a persisted layout degrades to a calm empty state
// rather than a broken iframe.

import {
  usePluginContributes,
  findPluginApp,
} from "../../lib/pluginContributesStore";
import { builtinIdFromKey, getBuiltinApp } from "../../lib/commonsApps";
import { RedditApp } from "../commons/builtins/RedditApp";
import { HackerNewsApp } from "../commons/builtins/HackerNewsApp";
import { PluginSandboxFrame } from "./PluginSandboxFrame";

type Props = {
  /** `builtin:<id>` (first-party) or `<pluginId>:<appId>` (plugin) — the id
   *  the `app` workpane ref carries. */
  appKey: string;
};

/** First-party builtin apps render as trusted React, not in the plugin
 *  sandbox — they are Aura's own code. Only `ready` builtins have a surface;
 *  anything else degrades to a calm "coming soon" state. */
function BuiltinAppSurface({ id }: { id: string }) {
  const def = getBuiltinApp(id);
  if (def?.id === "reddit") return <RedditApp />;
  if (def?.id === "hackernews") return <HackerNewsApp />;
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-1 text-center px-6">
      <div className="text-base text-text-2">{def?.title ?? id}</div>
      <div className="text-xs text-text-3">
        This builtin app isn’t available yet.
      </div>
    </div>
  );
}

export function AppPaneSurface({ appKey }: Props) {
  const { rows } = usePluginContributes();

  const builtinId = builtinIdFromKey(appKey);
  if (builtinId) return <BuiltinAppSurface id={builtinId} />;

  const app = findPluginApp(rows, appKey);

  if (!app) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-1 text-center px-6">
        <div className="text-base text-text-2">App unavailable</div>
        <div className="text-xs text-text-3">
          {appKey}. Its plugin is disabled or no longer installed.
        </div>
      </div>
    );
  }

  return (
    <PluginSandboxFrame
      pluginId={app.pluginId}
      surfaceId={app.id}
      title={app.title}
      entry={app.entry}
      className="flex-1 min-h-0 w-full border-0"
    />
  );
}
