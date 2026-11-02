import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createJiti } from "jiti";
const root = await mkdtemp(join(tmpdir(), "pi-web-snapshot-route-"));
const agentDir = join(root, "agent"); const cwd = join(root, "checkout");
await mkdir(agentDir); await mkdir(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
const exec = promisify(execFile);
await exec("git", ["init", "--template=", "-q"], { cwd });
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET, POST } = await jiti.import("./route.ts");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("../../../../lib/session-reader.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { TurnSnapshotStore } = await jiti.import("../../../../lib/workbench/turn-snapshot-store.ts");
const store = new TurnSnapshotStore(agentDir);
const ids = [];
const registry = new Map(); globalThis.__piSessions = registry;
test.after(async () => { ids.forEach(invalidateSessionPathCache); await rm(root, { recursive: true, force: true }); });
function request(url = "", init = {}) {
  return new Request(`http://localhost/api/workbench/snapshots${url}`, { ...init, headers: { host: "localhost", ...init.headers } });
}
function post(body, headers = {}) {
  return POST(request("", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));
}
async function saved() {
  const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
  manager.appendMessage({ role: "user", content: "saved fixture", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "existing history" }], timestamp: Date.now() });
  const id = manager.getSessionId(); ids.push(id); cacheSessionPath(id, manager.getSessionFile());
  return { manager, id, path: manager.getSessionFile() };
}

test("GET observes a saved session without creating a runtime or recording historical turns", async () => {
  const session = await saved(); const bytes = await readFile(session.path);
  const response = await GET(request(`?sessionId=${session.id}`));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { enabled: false, snapshots: [] });
  assert.equal(registry.size, 0); assert.deepEqual(await readFile(session.path), bytes);
  await assert.rejects(access(store.directory), { code: "ENOENT" });
});

test("POST opts in one saved session, GET lists finished snapshots and enforces detail ownership", async () => {
  const a = await saved(); const b = await saved(); const bytes = await readFile(a.path);
  await writeFile(join(cwd, "source.txt"), "before");
  const enabled = await post({ sessionId: a.id, action: "set-enabled", enabled: true });
  assert.equal(enabled.status, 200); assert.deepEqual(await enabled.json(), { enabled: true, snapshots: [] });
  assert.deepEqual(await (await GET(request(`?sessionId=${b.id}`))).json(), { enabled: false, snapshots: [] });
  const handle = await store.begin({ sessionId: a.id, cwd, runtimeId: randomUUID(), runId: randomUUID(), beforeEntryId: a.manager.getLeafId() });
  assert.equal((await (await GET(request(`?sessionId=${a.id}`))).json()).snapshots.length, 0);
  await writeFile(join(cwd, "source.txt"), "after"); await store.finish(handle, a.manager.getLeafId(), "completed");
  const list = await (await GET(request(`?sessionId=${a.id}`))).json();
  assert.equal(list.enabled, true); assert.equal(list.snapshots.length, 1); assert.equal(list.snapshots[0].snapshotId, handle.snapshotId);
  const detailResponse = await GET(request(`?sessionId=${a.id}&snapshotId=${handle.snapshotId}`));
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.deepEqual(detail.files, [{ path: "source.txt", kind: "modified", before: "before", after: "after" }]);
  assert.equal(detail.coverage.state, "complete");
  assert.equal((await GET(request(`?sessionId=${b.id}&snapshotId=${handle.snapshotId}`))).status, 404);
  assert.equal((await GET(request(`?sessionId=${a.id}&snapshotId=${randomUUID()}`))).status, 404);
  assert.equal((await post({ sessionId: a.id, action: "set-enabled", enabled: false })).status, 200);
  const disabled = await (await GET(request(`?sessionId=${a.id}`))).json();
  assert.equal(disabled.enabled, false); assert.equal(disabled.snapshots.length, 1);
  assert.equal(registry.size, 0); assert.deepEqual(await readFile(a.path), bytes);
});

test("routes reject non-JSON, cross-origin, invalid identities and bounded-body violations", async () => {
  const { id } = await saved();
  const valid = { sessionId: id, action: "set-enabled", enabled: true };
  for (const body of [{ ...valid, enabled: "yes" }, { ...valid, action: "capture-history" }, { ...valid, surprise: 1 }, [], "{bad", { ...valid, sessionId: "../escape" }, { ...valid, sessionId: "__proto__" }]) assert.equal((await post(body)).status, 400);
  assert.equal((await post(valid, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post(valid, { origin: "https://evil.example" })).status, 403);
  assert.equal((await GET(request(`?sessionId=${id}`, { headers: { origin: "https://evil.example" } }))).status, 403);
  assert.equal((await post(valid, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post(valid, { "sec-fetch-site": "same-site" })).status, 403);
  assert.equal((await post(" ".repeat(16385))).status, 413);
  for (const query of ["", "?sessionId=../escape", "?sessionId=constructor", `?sessionId=${id}&sessionId=${id}`, `?sessionId=${id}&snapshotId=../escape`, `?sessionId=${id}&snapshotId=`]) assert.equal((await GET(request(query))).status, 400);
});

test("stale cached paths and deleted saved sessions are refused even through an existing wrapper", async () => {
  const session = await saved();
  registry.set(session.id, { isAlive: () => true, sessionFile: session.path, inner: { sessionManager: session.manager } });
  const original = await readFile(session.path);
  await rm(session.path);
  assert.equal((await GET(request(`?sessionId=${session.id}`))).status, 404);
  assert.equal((await post({ sessionId: session.id, action: "set-enabled", enabled: true })).status, 404);
  await assert.rejects(access(session.path), { code: "ENOENT" });
  registry.delete(session.id);
  assert.equal((await GET(request(`?sessionId=${session.id}`))).status, 404);
  await writeFile(session.path, original);
  const mismatched = original.toString("utf8").replace(session.id, randomUUID());
  await writeFile(session.path, mismatched);
  assert.equal((await GET(request(`?sessionId=${session.id}`))).status, 404);
  assert.equal(await readFile(session.path, "utf8"), mismatched);
});

test("legacy headers are unavailable without invoking SDK migration; a missing checkout does not destroy immutable history", async () => {
  const session = await saved();
  const original = await readFile(session.path, "utf8");
  const lines = original.trimEnd().split("\n"); const header = JSON.parse(lines[0]); header.version = 2;
  lines[0] = JSON.stringify(header); const legacy = lines.join("\n") + "\n"; await writeFile(session.path, legacy);
  const response = await GET(request(`?sessionId=${session.id}`));
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: "session-version-unavailable" });
  assert.equal(await readFile(session.path, "utf8"), legacy);
  await writeFile(session.path, original);
  const missingCwd = join(root, "removed-checkout"); header.version = 3; header.cwd = missingCwd; lines[0] = JSON.stringify(header);
  await writeFile(session.path, lines.join("\n") + "\n");
  assert.equal((await GET(request(`?sessionId=${session.id}`))).status, 200, "saved snapshot reads need no source checkout");
  assert.equal(registry.size, 0);
});

test("an already-open wrapper without the recording extension must be reopened before opt-in", async () => {
  const session = await saved();
  registry.set(session.id, { isAlive: () => true, sessionFile: session.path, inner: { sessionManager: session.manager, resourceLoader: { getExtensions: () => ({ extensions: [] }) } } });
  const response = await post({ sessionId: session.id, action: "set-enabled", enabled: true });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "recording-runtime-unavailable" });
  assert.equal((await store.list(session.id)).enabled, false);
  registry.delete(session.id);
});

test("corrupt auxiliary state returns 409 and preserves the exact bytes", async () => {
  const { id } = await saved();
  const path = join(store.directory, "state.json"); const original = await readFile(path);
  await writeFile(path, "{corrupt original");
  const get = await GET(request(`?sessionId=${id}`)); const set = await post({ sessionId: id, action: "set-enabled", enabled: true });
  assert.equal(get.status, 409); assert.equal(set.status, 409);
  assert.equal(await readFile(path, "utf8"), "{corrupt original");
  await writeFile(path, original);
});
