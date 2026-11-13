// An uploaded image, made into an icon: fitted inside a square of at most
// 128px, centred, and written out as a PNG `data:` URL.

export const ICON_EDGE = 128;
/** Larger files are refused before they are read. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Larger images are refused before they are drawn. */
export const MAX_UPLOAD_EDGE = 10_000;

export const UPLOAD_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** The image type for a picked file, or null when it is not one we take. */
export function uploadType(path: string): string | null {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? "").toLowerCase();
  return UPLOAD_TYPES[ext] ?? null;
}

/** Where an image of this size lands in the icon square. */
export function fitIcon(width: number, height: number): {
  edge: number;
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const wide = width || ICON_EDGE;
  const tall = height || ICON_EDGE;
  const edge = Math.min(ICON_EDGE, Math.max(wide, tall));
  const scale = edge / Math.max(wide, tall);
  const w = Math.max(1, Math.round(wide * scale));
  const h = Math.max(1, Math.round(tall * scale));
  return { edge, x: (edge - w) / 2, y: (edge - h) / 2, w, h };
}

function decode(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode image"));
    img.src = src;
  });
}

/** Shrink an image (as base64 bytes of the given type) to icon size. */
export async function shrinkIcon(base64: string, mediaType: string): Promise<string> {
  const img = await decode(`data:${mediaType};base64,${base64}`);
  const width = img.naturalWidth || ICON_EDGE;
  const height = img.naturalHeight || ICON_EDGE;
  if (width > MAX_UPLOAD_EDGE || height > MAX_UPLOAD_EDGE) {
    throw new Error(`Image dimensions ${width}x${height} exceed the ${MAX_UPLOAD_EDGE}px limit`);
  }
  const fit = fitIcon(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = fit.edge;
  canvas.height = fit.edge;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, fit.x, fit.y, fit.w, fit.h);
  return canvas.toDataURL("image/png");
}
