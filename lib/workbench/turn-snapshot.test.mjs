import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { TurnSnapshotStore } = await jiti.import("./turn-snapshot-store.ts");
const { captureTurnSnapshot, snapshotGitEnvironment, safeSnapshotPath, snapshotCheckoutRoot } = await jiti.import("./turn-snapshot-capture.ts");
const { TURN_SNAPSHOT_LIMITS } = await jiti.import("./turn-snapshot.ts");
const exec = promisify(execFile);
const git = (cwd, args) => exec("git", ["-c", "core.fsmonitor=false", ...args], { cwd, env: snapshotGitEnvironment(), encoding: "utf8" });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-turn-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "checkout"); const agentDir = join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  await git(cwd, ["init", "--template=", "-q"]);
  await writeFile(join(cwd, "a.txt"), "before\r\n");
  await writeFile(join(cwd, "delete.txt"), "gone\n");
  await writeFile(join(cwd, ".gitignore"), "ignored*\n");
  await git(cwd, ["add", "."]);
  const store = new TurnSnapshotStore(agentDir, options);
  const begin = (id = "session-a", signal) => store.begin({ sessionId: id, cwd, beforeEntryId: "before-entry", runtimeId: randomUUID(), runId: randomUUID() }, signal);
  return { root, cwd, agentDir, store, begin };
}
async function assertMissing(path) { await assert.rejects(access(path), { code: "ENOENT" }); }

test("opt-in only records future turns; immutable raw content includes tracked deletions and new untracked files, leaving staging unchanged", async (t) => {
  const { cwd, store, begin } = await fixture(t);
  assert.deepEqual(await store.list("session-a"), { enabled: false, snapshots: [] });
  assert.equal(await begin(), null);
  await assertMissing(store.directory);
  await store.setEnabled("session-a", true);
  const staged = await readFile(join(cwd, ".git", "index"));
  const handle = await begin();
  assert.ok(handle);
  assert.deepEqual((await store.list("session-a")).snapshots, [], "open records are not finished snapshots");
  await writeFile(join(cwd, "a.txt"), "after\r\n");
  await rm(join(cwd, "delete.txt"));
  await writeFile(join(cwd, "new file 文.txt"), "new\n");
  await writeFile(join(cwd, "ignored-secret"), "excluded\n");
  await store.setEnabled("session-a", false);
  await store.finish(handle, "after-entry", "completed");
  const listing = await store.list("session-a");
  assert.equal(listing.enabled, false);
  assert.equal(listing.snapshots.length, 1);
  const detail = await store.detail("session-a", handle.snapshotId);
  assert.equal(detail.beforeEntryId, "before-entry"); assert.equal(detail.afterEntryId, "after-entry");
  assert.equal(detail.status, "completed"); assert.equal(detail.coverage.state, "complete", JSON.stringify({ before: detail.before, after: detail.after, coverage: detail.coverage }));
  assert.deepEqual(detail.files, [
    { path: "a.txt", kind: "modified", before: "before\r\n", after: "after\r\n" },
    { path: "delete.txt", kind: "deleted", before: "gone\n", after: null },
    { path: "new file 文.txt", kind: "added", before: null, after: "new\n" },
  ]);
  assert.deepEqual(await readFile(join(cwd, ".git", "index")), staged);
  await writeFile(join(cwd, "a.txt"), "changed later");
  assert.deepEqual(await store.detail("session-a", handle.snapshotId), detail, "detail never rereads source files");
  assert.equal(await begin(), null, "disabling preserves the active run but prevents future baselines");
  await assert.rejects(store.finish(handle, "later", "completed"), (e) => e.code === "snapshot-ownership");
  await assert.rejects(store.detail("session-b", handle.snapshotId), (e) => e.status === 404);
  await assert.rejects(store.detail("session-a", "../escape"), (e) => e.status === 400);
});

test("capture scrubs inherited repository/index/config overrides and never executes fsmonitor", async (t) => {
  const { cwd, root, store, begin } = await fixture(t);
  const hook = join(root, "fsmonitor.sh"); const marker = join(root, "hook-ran");
  await writeFile(hook, `#!/bin/sh\necho unsafe > '${marker.replaceAll("\\", "/")}'\n`);
  await git(cwd, ["config", "core.fsmonitor", hook]);
  const keys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
  const original = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = join(root, "wrong");
    assert.ok(keys.every((key) => snapshotGitEnvironment()[key] === undefined));
    await store.setEnabled("session-a", true);
    const handle = await begin(); await store.finish(handle, "after", "completed");
    assert.equal((await store.detail("session-a", handle.snapshotId)).coverage.state, "complete");
    await assertMissing(marker);
  } finally { keys.forEach((key, i) => original[i] === undefined ? delete process.env[key] : process.env[key] = original[i]); }
});

test("symlink and junction ancestors never expose files outside the checkout", async (t) => {
  const { cwd, root, store, begin } = await fixture(t);
  const outside = join(root, "outside"); await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "NEVER_CAPTURE_THIS_SECRET");
  await mkdir(join(cwd, "nested")); await writeFile(join(cwd, "nested", "secret.txt"), "inside");
  await git(cwd, ["add", "nested/secret.txt"]);
  await rm(join(cwd, "nested"), { recursive: true });
  await symlink(outside, join(cwd, "nested"), process.platform === "win32" ? "junction" : "dir");
  await store.setEnabled("session-a", true);
  const handle = await begin();
  await writeFile(join(cwd, "a.txt"), "safe change");
  await store.finish(handle, "after", "completed");
  const detail = await store.detail("session-a", handle.snapshotId);
  assert.equal(detail.coverage.state, "partial");
  assert.ok(detail.coverage.omitted.symlink >= 2);
  assert.ok(!JSON.stringify(detail).includes("NEVER_CAPTURE_THIS_SECRET"));
  assert.deepEqual(detail.files.map((f) => f.path), ["a.txt"]);
  const blobs = join(store.directory, "records", handle.snapshotId, "blobs");
  for (const name of await readdir(blobs)) assert.ok(!gunzipSync(await readFile(join(blobs, name))).includes("NEVER_CAPTURE_THIS_SECRET"));
  for (const path of ["../escape", "/etc/passwd", "x/../../y", "C:/secret", "x\\secret", ".git/config", "x/.git/objects", "x\0y", "x//y"]) assert.equal(safeSnapshotPath(path), false, path);
});

test("binary, unsupported encodings and oversized files have explicit omissions instead of fabricated deletions", async (t) => {
  const { cwd, store, begin } = await fixture(t, { limits: { maxFileBytes: 64, maxBytes: 256 } });
  await writeFile(join(cwd, "binary"), Buffer.from([1, 0, 3]));
  await writeFile(join(cwd, "encoded"), Buffer.from([255, 254, 255]));
  await writeFile(join(cwd, "large"), "x".repeat(65));
  await store.setEnabled("session-a", true);
  const handle = await begin();
  await writeFile(join(cwd, "a.txt"), Buffer.from([0]));
  await store.finish(handle, "after", "completed");
  const detail = await store.detail("session-a", handle.snapshotId);
  assert.equal(detail.coverage.state, "partial");
  assert.ok(detail.coverage.omitted.binary >= 2);
  assert.ok(detail.coverage.omitted["unsupported-encoding"] >= 2);
  assert.ok(detail.coverage.omitted["file-byte-limit"] >= 2);
  assert.deepEqual(detail.files, [], "a file omitted on either side has unknown comparison content");
});

test("file count, total bytes, inventory output, elapsed time and abort limits stay honest", async (t) => {
  const { cwd, store, begin, agentDir } = await fixture(t, { limits: { maxFiles: 1 } });
  await store.setEnabled("session-a", true);
  const handle = await begin(); await writeFile(join(cwd, "new"), "new");
  await store.finish(handle, "after", "completed");
  const detail = await store.detail("session-a", handle.snapshotId);
  assert.equal(detail.coverage.state, "partial"); assert.equal(detail.before.inventoryComplete, false);
  assert.ok(detail.coverage.omitted["file-limit"] > 0); assert.deepEqual(detail.files, []);
  const captures = async (overrides, signal) => captureTurnSnapshot(cwd, { ...TURN_SNAPSHOT_LIMITS, ...overrides }, async () => {}, signal);
  const byteLimited = await captures({ maxBytes: 1 });
  assert.equal(byteLimited.capture.state, "partial"); assert.ok(byteLimited.capture.coverage.omitted["total-byte-limit"]);
  const inventoryLimited = await captures({ maxInventoryBytes: 1 });
  assert.equal(inventoryLimited.capture.state, "unavailable"); assert.equal(inventoryLimited.capture.inventoryComplete, false);
  const started = Date.now(); const timed = await captures({ timeoutMs: 1 });
  assert.notEqual(timed.capture.state, "complete"); assert.ok(Date.now() - started < 2000);
  const aborted = await captures({}, AbortSignal.abort());
  assert.equal(aborted.capture.state, "unavailable"); assert.ok(aborted.capture.coverage.omitted["capture-timeout-or-aborted"]);
  assert.throws(() => new TurnSnapshotStore(agentDir, { limits: { maxFiles: 0 } }));
  const abortedHandle = await begin("session-a", AbortSignal.abort());
  await store.finish(abortedHandle, "after", "completed");
  assert.equal((await store.detail("session-a", abortedHandle.snapshotId)).coverage.state, "unavailable");
});

test("the JSON response cap accounts for escaped content, returning partial coverage", async (t) => {
  const { cwd, store, begin } = await fixture(t, { limits: { maxResponseBytes: 16 * 1024 } });
  await writeFile(join(cwd, "large-text"), "\u0001".repeat(4000));
  await store.setEnabled("session-a", true);
  const handle = await begin();
  await writeFile(join(cwd, "large-text"), "\u0002".repeat(4000));
  await store.finish(handle, "after", "completed");
  const detail = await store.detail("session-a", handle.snapshotId);
  assert.equal(detail.response.truncated, true); assert.equal(detail.response.omittedFiles, 1);
  assert.equal(detail.coverage.state, "partial"); assert.ok(Buffer.byteLength(JSON.stringify(detail)) <= 16 * 1024);
});

test("sessions sharing a checkout serialize boundaries and preserve symmetric overlap provenance", async (t) => {
  const { cwd, agentDir, store, begin } = await fixture(t);
  const secondStore = new TurnSnapshotStore(agentDir);
  await Promise.all([store.setEnabled("session-a", true), secondStore.setEnabled("session-b", true)]);
  const [a, b] = await Promise.all([begin(), secondStore.begin({ sessionId: "session-b", cwd, runtimeId: randomUUID(), runId: randomUUID(), beforeEntryId: "b-before" })]);
  await writeFile(join(cwd, "a.txt"), "shared change 1");
  await store.finish(a, "a-after", "completed");
  await writeFile(join(cwd, "a.txt"), "shared change 2");
  await secondStore.finish(b, "b-after", "stopped");
  const da = await store.detail("session-a", a.snapshotId); const db = await secondStore.detail("session-b", b.snapshotId);
  assert.deepEqual(da.overlaps, [{ snapshotId: b.snapshotId, sessionId: "session-b", runId: b.runId }]);
  assert.deepEqual(db.overlaps, [{ snapshotId: a.snapshotId, sessionId: "session-a", runId: a.runId }]);
  assert.equal(da.overlapCount, 1); assert.equal(db.overlapCount, 1);
  assert.equal(da.coverage.state, "partial"); assert.equal(db.status, "stopped");
  assert.match(da.coverage.notes.join(" "), /cannot be attributed/);
  assert.equal(da.files[0].after, "shared change 1"); assert.equal(db.files[0].after, "shared change 2");
});

test("retention bounds finalized records per session and overall without pruning open or unrelated storage", async (t) => {
  const { cwd, agentDir, store, begin } = await fixture(t, { retention: { perSession: 2, overall: 3 } });
  await Promise.all([store.setEnabled("session-a", true), store.setEnabled("session-b", true)]);
  const unrelated = join(agentDir, "unrelated-session.jsonl"); await writeFile(unrelated, "keep unrelated bytes");
  const open = await begin("session-b");
  const dropped = await begin(); await store.finish(dropped, "first", "completed");
  for (let i = 0; i < 3; i++) { const h = await begin(); await store.finish(h, `a-${i}`, "completed"); }
  assert.equal((await store.list("session-a")).snapshots.length, 2);
  await assertMissing(join(store.directory, "records", dropped.snapshotId));
  await access(join(store.directory, "records", open.snapshotId));
  assert.equal((await store.detail("session-b", open.snapshotId)).status, "open");
  await store.finish(open, "b-after", "failed");
  const extra = await begin("session-b"); await store.finish(extra, "b-2", "unknown");
  assert.equal((await store.list("session-a")).snapshots.length + (await store.list("session-b")).snapshots.length, 3);
  assert.equal(await readFile(unrelated, "utf8"), "keep unrelated bytes");
  assert.equal((await store.detail("session-b", extra.snapshotId)).status, "unknown");
  await access(join(cwd, "a.txt"));
});

test("restart leaves unfinished records interrupted and unavailable", async (t) => {
  const { cwd, agentDir, store } = await fixture(t);
  await store.setEnabled("crash-session", true);
  const source = new URL("./turn-snapshot-store.ts", import.meta.url).href;
  const script = `import { createJiti } from 'jiti';
    import { randomUUID } from 'node:crypto';
    const jiti = createJiti(import.meta.url);
    const { TurnSnapshotStore } = await jiti.import(process.argv[1]);
    const store = new TurnSnapshotStore(process.argv[2]);
    const h = await store.begin({ sessionId: 'crash-session', cwd: process.argv[3], runtimeId: randomUUID(), runId: randomUUID(), beforeEntryId: 'before' });
    console.log(JSON.stringify(h));`;
  const child = await exec(process.execPath, ["--input-type=module", "-e", script, source, agentDir, cwd], { cwd: process.cwd(), timeout: 15000 });
  const handle = JSON.parse(child.stdout.trim());
  const reopened = new TurnSnapshotStore(agentDir);
  const [record] = (await reopened.list("crash-session")).snapshots;
  assert.equal(record.status, "interrupted"); assert.equal(record.after, null); assert.equal(record.coverage.state, "unavailable");
  const detail = await reopened.detail("crash-session", handle.snapshotId);
  assert.deepEqual(detail.files, []); assert.equal(detail.status, "interrupted");
  await assert.rejects(reopened.finish(handle, "after", "completed"), (e) => e.code === "snapshot-ownership");
});

test("retention recovers a full store of interrupted records before admitting future captures", async (t) => {
  const { cwd, store, begin } = await fixture(t);
  await store.setEnabled("session-a", true);
  const handle = await begin();
  const statePath = join(store.directory, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")); const seed = state.records[0];
  state.records = Array.from({ length: 500 }, (_, i) => ({ ...seed, snapshotId: randomUUID(), sessionId: `retained-${i}`,
    status: "completed", after: seed.before, finishedAt: new Date().toISOString() }));
  state.records.push(...Array.from({ length: 64 }, () => ({ ...seed, snapshotId: randomUUID(), ownerId: randomUUID(), ownerPid: process.pid })));
  await writeFile(statePath, JSON.stringify(state));
  await store.setEnabled("recovered-session", true);
  const recovered = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(recovered.records.length, 500);
  const next = await store.begin({ sessionId: "recovered-session", cwd, runtimeId: randomUUID(), runId: randomUUID(), beforeEntryId: null });
  assert.ok(next); assert.notEqual(next.snapshotId, handle.snapshotId);
});

test("corrupt state is preserved; corrupt manifests and blobs never become a complete diff", async (t) => {
  const { store, begin, cwd } = await fixture(t);
  await store.setEnabled("session-a", true);
  const handle = await begin(); await writeFile(join(cwd, "a.txt"), "after"); await store.finish(handle, "after", "completed");
  const manifestPath = join(store.directory, "records", handle.snapshotId, "before.json");
  const manifest = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(manifest); parsed.entries[0].path = "../../outside";
  await writeFile(manifestPath, JSON.stringify(parsed));
  assert.equal((await store.detail("session-a", handle.snapshotId)).coverage.state, "unavailable");
  await writeFile(manifestPath, manifest);
  const textEntry = JSON.parse(manifest).entries.find((e) => e.path === "a.txt");
  await writeFile(join(store.directory, "records", handle.snapshotId, "blobs", `${textEntry.blob}.gz`), "not gzip");
  const partial = await store.detail("session-a", handle.snapshotId);
  assert.equal(partial.coverage.state, "partial"); assert.ok(partial.coverage.omitted["blob-unavailable"]);
  assert.deepEqual(partial.files, []);
  const statePath = join(store.directory, "state.json");
  for (const corrupt of ["{broken original", JSON.stringify({ version: 9, records: [], enabledSessionIds: [] }), JSON.stringify({ version: 1, records: [{ snapshotId: "../x" }], enabledSessionIds: [] })]) {
    await writeFile(statePath, corrupt);
    await assert.rejects(store.list("session-a"), (e) => e.code === "corrupt" && e.status === 409);
    await assert.rejects(store.setEnabled("session-a", false), (e) => e.code === "corrupt");
    assert.equal(await readFile(statePath, "utf8"), corrupt);
  }
});

test("subdirectory and linked worktree sessions resolve their own checkout; storage inside a checkout is refused", async (t) => {
  const { cwd, root, store, begin } = await fixture(t);
  const subdir = join(cwd, "src"); await mkdir(subdir);
  assert.equal(await snapshotCheckoutRoot(subdir), await snapshotCheckoutRoot(cwd));
  await git(cwd, ["-c", "user.name=Snapshot Test", "-c", "user.email=snapshot@example.invalid", "commit", "-qm", "fixture"]);
  const linked = join(root, "linked"); await git(cwd, ["worktree", "add", "--detach", linked]);
  assert.notEqual(await snapshotCheckoutRoot(linked), await snapshotCheckoutRoot(cwd));
  const inside = new TurnSnapshotStore(join(cwd, "private"));
  await assert.rejects(inside.assertStorageOutside(subdir), (e) => e.code === "storage-inside-checkout");
  await assertMissing(inside.directory);
  await store.setEnabled("session-a", true); const handle = await begin();
  await rm(cwd, { recursive: true, force: true });
  await store.finish(handle, "after", "completed");
  assert.equal((await store.detail("session-a", handle.snapshotId)).coverage.state, "unavailable");
});
