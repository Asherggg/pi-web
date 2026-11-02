import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const { readSnapshotReviews, setSnapshotReviewed } = await createJiti(import.meta.url).import("./snapshot-review-store.ts");
const snapshotId = "11111111-1111-4111-8111-111111111111";
test("snapshot review marks persist, are scoped to immutable snapshot and preserve concurrent file reviews", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-snapshot-marks-")), path = join(dir, "marks.json");
  try {
    assert.deepEqual(readSnapshotReviews("parent", snapshotId, path), []);
    await Promise.all([setSnapshotReviewed("parent", snapshotId, "a.txt", true, path), setSnapshotReviewed("parent", snapshotId, "b.txt", true, path)]);
    assert.deepEqual(readSnapshotReviews("parent", snapshotId, path).sort(), ["a.txt", "b.txt"]);
    assert.deepEqual(readSnapshotReviews("other", snapshotId, path), []);
    assert.deepEqual(readSnapshotReviews("parent", "22222222-2222-4222-8222-222222222222", path), []);
    assert.deepEqual((await setSnapshotReviewed("parent", snapshotId, "a.txt", false, path)), ["b.txt"]);
    await setSnapshotReviewed("parent", snapshotId, "b.txt", true, path);
    assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8")).marks).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("corrupt review bytes are preserved and invalid snapshot identities are rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-snapshot-marks-")), path = join(dir, "marks.json");
  try {
    writeFileSync(path, "{corrupt original");
    await assert.rejects(setSnapshotReviewed("parent", snapshotId, "a.txt", true, path));
    assert.equal(readFileSync(path, "utf8"), "{corrupt original");
    await assert.rejects(setSnapshotReviewed("parent", "../../escape", "a.txt", true, path));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
