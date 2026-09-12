import { describe, expect, test } from "bun:test";

import {
  LOW_DISK_FLOOR_BYTES,
  diskWarning,
} from "./diskWarning";

const GB = 1024 * 1024 * 1024;

describe("diskWarning", () => {
  test("a healthy disk gives no warning", () => {
    expect(diskWarning({ disk_free_bytes: 120 * GB, disk_total_bytes: 500 * GB })).toBeNull();
  });

  test("under the 5 GiB floor trips it whatever the percent", () => {
    // 4 TB volume, 3.2 GB free: 0.08% AND under the floor.
    const w = diskWarning({ disk_free_bytes: 3.2 * GB, disk_total_bytes: 4096 * GB });
    expect(w).not.toBeNull();
    expect(w?.message).toBe("Low disk space: 3.2 GB left");
  });

  test("under 5% trips it even with more than the floor free", () => {
    // 6 GB free on a 200 GB volume is 3%: over the byte floor, under the percent.
    const w = diskWarning({ disk_free_bytes: 6 * GB, disk_total_bytes: 200 * GB });
    expect(w).not.toBeNull();
    expect(w?.freePercent).toBe(3);
    expect(w?.message).toBe("Low disk space: 6 GB left");
  });

  test("exactly at the floor is not low", () => {
    expect(
      diskWarning({ disk_free_bytes: LOW_DISK_FLOOR_BYTES, disk_total_bytes: 100 * GB }),
    ).toBeNull();
  });

  test("an unmeasured volume is unknown, not low", () => {
    expect(diskWarning({ disk_free_bytes: 0, disk_total_bytes: 0 })).toBeNull();
    expect(diskWarning(null)).toBeNull();
    expect(diskWarning(undefined)).toBeNull();
  });

  test("a snapshot from an older backend without the fields is unknown", () => {
    const legacy = { cpu_percent: 3 } as unknown as { disk_free_bytes: number; disk_total_bytes: number };
    expect(diskWarning(legacy)).toBeNull();
  });
});
