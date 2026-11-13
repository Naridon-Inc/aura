// What these pin: the percent and megabytes the update toast prints come from
// the updater's own byte counts and never overshoot; an unknown size reads as
// "so far" rather than a made-up percent; the chunk-by-chunk stream only
// produces a new value when the line on screen would change; and the toast
// picks ready over failed over downloading, with hidden progress staying
// hidden until the download ends.

import { describe, expect, it } from "bun:test";

import {
  DOWNLOAD_START,
  downloadLabel,
  downloadPercent,
  megabytes,
  nextProgress,
  updateToastView,
  type DownloadProgress,
} from "./updateProgress";

const MB = 1_000_000;

describe("downloadPercent", () => {
  it("is the share of the announced size, rounded down", () => {
    expect(downloadPercent({ downloaded: 19 * MB, total: 56 * MB })).toBe(33);
    expect(downloadPercent({ downloaded: 0, total: 56 * MB })).toBe(0);
    expect(downloadPercent({ downloaded: 56 * MB - 1, total: 56 * MB })).toBe(99);
    expect(downloadPercent({ downloaded: 56 * MB, total: 56 * MB })).toBe(100);
  });

  it("never goes past 100 or below 0", () => {
    expect(downloadPercent({ downloaded: 60 * MB, total: 56 * MB })).toBe(100);
    expect(downloadPercent({ downloaded: -5, total: 56 * MB })).toBe(0);
  });

  it("is null while the server has not said how big the release is", () => {
    expect(downloadPercent({ downloaded: 4 * MB, total: null })).toBeNull();
    expect(downloadPercent({ downloaded: 4 * MB, total: 0 })).toBeNull();
    expect(downloadPercent({ downloaded: 4 * MB, total: Number.NaN })).toBeNull();
    expect(downloadPercent(DOWNLOAD_START)).toBeNull();
  });
});

describe("megabytes", () => {
  it("shows tenths under 10 MB and whole megabytes above, rounded down", () => {
    expect(megabytes(0)).toBe("0");
    expect(megabytes(420_000)).toBe("0.4");
    expect(megabytes(4_290_000)).toBe("4.2");
    expect(megabytes(4_000_000)).toBe("4");
    expect(megabytes(9_999_999)).toBe("9.9");
    expect(megabytes(10 * MB)).toBe("10");
    expect(megabytes(56_900_000)).toBe("56");
  });

  it("reads nonsense as nothing", () => {
    expect(megabytes(-1)).toBe("0");
    expect(megabytes(Number.NaN)).toBe("0");
  });
});

describe("downloadLabel", () => {
  it("says percent and megabytes of the total", () => {
    expect(downloadLabel({ downloaded: 19.2 * MB, total: 56.3 * MB })).toBe("34% · 19 of 56 MB");
    expect(downloadLabel({ downloaded: 56.3 * MB, total: 56.3 * MB })).toBe("100% · 56 of 56 MB");
  });

  it("never prints more downloaded than the total", () => {
    expect(downloadLabel({ downloaded: 70 * MB, total: 56 * MB })).toBe("100% · 56 of 56 MB");
  });

  it("counts up with no percent when the size is unknown", () => {
    expect(downloadLabel({ downloaded: 19.2 * MB, total: null })).toBe("19 MB so far");
    expect(downloadLabel({ downloaded: 1_500_000, total: null })).toBe("1.5 MB so far");
  });

  it("says it is starting before the first byte", () => {
    expect(downloadLabel(DOWNLOAD_START)).toBe("Starting…");
    expect(downloadLabel({ downloaded: 0, total: null })).toBe("Starting…");
    expect(downloadLabel({ downloaded: 0, total: 56 * MB })).toBe("0% · 0 of 56 MB");
  });
});

describe("nextProgress", () => {
  it("keeps the same value while the line on screen would not change", () => {
    const prev: DownloadProgress = { downloaded: 19.2 * MB, total: 56.3 * MB };
    // 16 KB more: still 34% · 19 of 56 MB.
    expect(nextProgress(prev, 19.2 * MB + 16_384, 56.3 * MB)).toBe(prev);
  });

  it("moves on once the percent or the megabytes do", () => {
    const prev: DownloadProgress = { downloaded: 19.2 * MB, total: 56.3 * MB };
    const next = nextProgress(prev, 20.1 * MB, 56.3 * MB);
    expect(next).not.toBe(prev);
    expect(next).toEqual({ downloaded: 20.1 * MB, total: 56.3 * MB });
  });

  it("moves on when the size arrives", () => {
    const next = nextProgress(DOWNLOAD_START, 0, 56 * MB);
    expect(next).toEqual({ downloaded: 0, total: 56 * MB });
  });

  it("turns a whole chunk-by-chunk stream into a few hundred redraws", () => {
    const total = 56 * MB;
    const chunk = 16_384;
    let shown: DownloadProgress = nextProgress(DOWNLOAD_START, 0, total);
    let redraws = 0;
    for (let got = chunk; got < total; got += chunk) {
      const next = nextProgress(shown, got, total);
      if (next !== shown) redraws += 1;
      shown = next;
    }
    shown = nextProgress(shown, total, total);
    expect(downloadLabel(shown)).toBe("100% · 56 of 56 MB");
    // ~3,400 chunks, but the line only changes with the percent (100 steps),
    // the tenths of the first 10 MB (100) and each whole megabyte after (46),
    // many of them landing together.
    expect(redraws).toBeGreaterThan(100);
    expect(redraws).toBeLessThan(300);
  });
});

describe("updateToastView", () => {
  it("shows the download while it runs", () => {
    expect(updateToastView({ ready: false, download: "downloading", progressHidden: false })).toBe(
      "downloading",
    );
  });

  it("stays out of the way once the person hides the progress", () => {
    expect(updateToastView({ ready: false, download: "downloading", progressHidden: true })).toBeNull();
  });

  it("shows a failure even when the progress was hidden", () => {
    expect(updateToastView({ ready: false, download: "failed", progressHidden: true })).toBe("failed");
  });

  it("puts a release that is ready ahead of everything", () => {
    expect(updateToastView({ ready: true, download: "downloading", progressHidden: false })).toBe("ready");
    expect(updateToastView({ ready: true, download: "failed", progressHidden: false })).toBe("ready");
    expect(updateToastView({ ready: true, download: null, progressHidden: true })).toBe("ready");
  });

  it("shows nothing when there is nothing to say", () => {
    expect(updateToastView({ ready: false, download: null, progressHidden: false })).toBeNull();
  });
});
