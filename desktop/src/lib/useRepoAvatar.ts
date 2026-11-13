// The React side of the repository picture.
//
// The rules (one look per repository per run, no scan of a checkout on another
// machine, the owner remembered across restarts) live in `repoAvatar.ts`, which
// knows nothing about React or Tauri. This file binds that store to the app's
// git and file calls once, and hands a component whatever is known this
// instant. A miss is `{ icon: null, avatar: null }` and the caller draws its
// fallback; a picture that arrives later swaps in place.

import { useEffect, useSyncExternalStore } from "react";

import { remotePlaceForRoot } from "./activeMachine";
import { api } from "./api";
import { gitRemoteOrigin, placeScope } from "./place/workApi";
import {
  chosenRepoIcon,
  repoPictureFor,
  requestRepoPicture,
  setRepoAvatarTransport,
  subscribeRepoAvatars,
  type RepoPicture,
} from "./repoAvatar";

let bound = false;
function bindTransportOnce(): void {
  if (bound) return;
  bound = true;
  setRepoAvatarTransport({
    origin: (root) => gitRemoteOrigin(root),
    readBase64: async (path) => {
      const file = await api.readFileBase64(path);
      return typeof file?.data_base64 === "string" ? file.data_base64 : null;
    },
    isRemote: (root) => remotePlaceForRoot(root) !== null,
    scope: (root) => placeScope(root),
  });
}

/** The pictures known for this repository root. `null` asks for nothing. */
export function useRepoAvatar(root: string | null | undefined): RepoPicture {
  bindTransportOnce();
  const picture = useSyncExternalStore(
    subscribeRepoAvatars,
    () => repoPictureFor(root),
    () => repoPictureFor(null),
  );
  useEffect(() => {
    requestRepoPicture(root);
  }, [root]);
  return picture;
}

/** The icon picked for this repository (a named icon or an image `data:` URL),
 *  or null for automatic. */
export function useChosenRepoIcon(root: string | null | undefined): string | null {
  return useSyncExternalStore(
    subscribeRepoAvatars,
    () => chosenRepoIcon(root),
    () => null,
  );
}
