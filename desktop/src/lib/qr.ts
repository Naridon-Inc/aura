// Tiny QR helper used by RemoteDialog. The `qrcode` npm module is
// promise-based, so we expose an async `toQrSvgDataUrl` and a tiny
// `useQr` hook that resolves once per text and caches the result so
// re-renders don't re-encode.

import { useEffect, useState } from "react";
import QRCode from "qrcode";

const cache = new Map<string, string>();

export async function toQrSvgDataUrl(text: string): Promise<string> {
  if (!text) return "";
  const hit = cache.get(text);
  if (hit) return hit;
  const svg = await QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
  });
  const url = "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  cache.set(text, url);
  return url;
}

export function useQr(text: string): string {
  const [url, setUrl] = useState<string>(cache.get(text) ?? "");
  useEffect(() => {
    if (!text) {
      setUrl("");
      return;
    }
    let mounted = true;
    toQrSvgDataUrl(text).then((u) => {
      if (mounted) setUrl(u);
    });
    return () => {
      mounted = false;
    };
  }, [text]);
  return url;
}
