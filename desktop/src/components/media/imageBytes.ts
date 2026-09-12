// Getting a picture out of an `<img>` and into the OS.
//
// Two backend commands exist for this and both speak in clips — the durable
// workspace clipboard at `~/.aura/clips/`. `clips_save_image` takes PNG bytes
// as base64 and files them there; `clips_copy_image_to_os` puts a filed clip
// on the system clipboard. So "copy" is "file it, then copy the file", and
// "save" is "file it, then show the person where". Both start from the same
// step: turn whatever the image element is showing into PNG bytes.
//
// PNG always. `clips_save_image` names every file `.png`, and a JPEG under
// that name would be a file whose extension lies — so anything that is not
// already PNG is re-encoded through a canvas on the way.

import { api, type ClipEntry } from "../../lib/api";

/** The bytes behind an image `src` — a `data:` URL, an `asset://` path, or
 *  anything else the webview can fetch — as PNG, base64-encoded. */
export async function imageSrcToPngBase64(src: string): Promise<string> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`could not read image (${res.status})`);
  const blob = await res.blob();
  const png = blob.type === "image/png" ? blob : await reencodeAsPng(blob);
  return blobToBase64(png);
}

async function reencodeAsPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((out) => (out ? resolve(out) : reject(new Error("encode failed"))), "image/png");
    });
  } finally {
    bitmap.close();
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.readAsDataURL(blob);
  });
}

/** A file name for the clip: the picture's own name with a `.png` ending,
 *  or `image.png` when it has none. The backend sanitises further. */
export function clipNameFor(name: string | null | undefined): string {
  const base = (name ?? "").trim().split(/[\\/]/).pop() ?? "";
  if (!base) return "image.png";
  const stem = base.replace(/\.[a-z0-9]+$/i, "");
  return `${stem || "image"}.png`;
}

/** File the picture as a clip. What comes back names where it went. */
export async function saveImageClip(src: string, name?: string | null): Promise<ClipEntry> {
  const b64 = await imageSrcToPngBase64(src);
  return api.clipsSaveImage(clipNameFor(name), b64);
}

/** Put the picture on the system clipboard, so ⌘V lands it in any app. */
export async function copyImageToClipboard(src: string, name?: string | null): Promise<void> {
  const entry = await saveImageClip(src, name);
  await api.clipsCopyImageToOs(entry.id);
}
