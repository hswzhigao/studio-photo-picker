import { describe, it, expect } from "vitest";
import {
  canEditFeedback,
  uploadUrl,
  runUploadQueue,
  latestRequest,
  duplicateNames,
  batchIds,
} from "./utils/retouched.js";

describe("retouched state boundaries", () => {
  it("uses selector identity, not customer account identity, with five minute window", () => {
    const c = {
      author_type: "customer",
      author_id: 7,
      created_at: new Date(1000).toISOString(),
    };
    expect(canEditFeedback(c, "customer", 1, 2000)).toBe(false);
    expect(canEditFeedback(c, "customer", 7, 2000)).toBe(true);
    expect(canEditFeedback(c, "customer", 7, 302000)).toBe(false);
  });
  it("encodes version and association as URL query parameters", () => {
    expect(uploadUrl("/api/admin/jobs/2/retouched", "a b", null)).toBe(
      "/api/admin/jobs/2/retouched?asset_id=a+b",
    );
    expect(uploadUrl("/b", null, 8)).toBe("/b?photo_id=8");
  });
  it("rejects stale responses after page or version changes", () => {
    const gate = latestRequest();
    const first = gate.next();
    const second = gate.next();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });
  it("limits real queue concurrency to two and isolates failures for retry", async () => {
    let active = 0,
      max = 0;
    const rows = [1, 2, 3, 4].map((id) => ({ id, status: "queued" }));
    await runUploadQueue(rows, async (row) => {
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (row.id === 2) throw Error("failed");
    });
    expect(max).toBe(2);
    expect(rows.map((r) => r.status)).toEqual([
      "done",
      "failed",
      "done",
      "done",
    ]);
    await runUploadQueue(rows, async () => {});
    expect(rows[1].status).toBe("failed");
    rows[1].status = "queued";
    await runUploadQueue(rows, async () => {});
    expect(rows[1].status).toBe("done");
  });
  it("stops starting queued uploads when the order context changes", async () => {
    let current = true;
    const started = [];
    const rows = [1, 2, 3, 4].map((id) => ({ id, status: "queued" }));
    await runUploadQueue(
      rows,
      async (row) => {
        started.push(row.id);
        current = false;
      },
      () => current,
    );
    expect(started.length).toBeLessThanOrEqual(2);
    expect(rows[3].status).toBe("queued");
  });
  it("requires explicit handling of same filenames including within a new batch", () => {
    expect(duplicateNames([{ name: "a.jpg" }, { name: "a.jpg" }], [])).toEqual([
      "a.jpg",
    ]);
    expect(
      duplicateNames([{ name: "b.jpg" }], [{ filename: "b.jpg" }]),
    ).toEqual(["b.jpg"]);
  });
  it("publishes only ready and withdraws only published selected versions", () => {
    const rows = [
      { id: 1, status: "ready" },
      { id: 2, status: "published" },
      { id: 3, status: "withdrawn" },
    ];
    expect(batchIds(rows, [1, 2, 3], "publish")).toEqual([1]);
    expect(batchIds(rows, [1, 2, 3], "withdraw")).toEqual([2]);
  });
});
