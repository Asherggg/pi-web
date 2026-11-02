import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { TurnSnapshotStore } = await jiti.import("./turn-snapshot-store.ts");
const { cacheSessionPath, invalidateSessionManagerCache } = await jiti.import("../session-reader.ts");
const route = await jiti.import("../../app/api/workbench/snapshot-reviews/route.ts");
const headers = { host: "127.0.0.1:30141", origin: "http://127.0.0.1:30141", "content-type": "application/json" };

test("snapshot file review API binds marks to owned immutable files without changing the source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-file-review-api-"));
  const cwd = join(dir, "repo"), agentDir = join(dir, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    execFileSync("git", ["init", "--template=", "-q", cwd], { windowsHide: true });
    const path = join(cwd, "report.txt"); writeFileSync(path, "before");
    const sid = `review-${randomUUID()}`, sessionPath = join(dir, "session.jsonl");
    writeFileSync(sessionPath, JSON.stringify({ type: "session", version: 3, id: sid, cwd, timestamp: new Date().toISOString() }) + "\n"); cacheSessionPath(sid, sessionPath);
    const store = new TurnSnapshotStore(agentDir); await store.setEnabled(sid, true);
    const handle = await store.begin({ sessionId: sid, cwd, runtimeId: randomUUID(), runId: randomUUID(), beforeEntryId: "before" });
    writeFileSync(path, "after"); await store.finish(handle, "after", "completed");
    const query = new URLSearchParams({ sessionId: sid, snapshotId: handle.snapshotId });
    const get = () => route.GET(new Request(`http://127.0.0.1:30141/api/workbench/snapshot-reviews?${query}`, { headers }));
    const post = (patch) => route.POST(new Request("http://127.0.0.1:30141/api/workbench/snapshot-reviews", { method: "POST", headers, body: JSON.stringify({ sessionId: sid, snapshotId: handle.snapshotId, path: "report.txt", reviewed: true, ...patch }) }));
    assert.deepEqual(await (await get()).json(), { paths: [] });
    assert.deepEqual(await (await post({})).json(), { paths: ["report.txt"] });
    assert.deepEqual(await (await get()).json(), { paths: ["report.txt"] });
    assert.equal((await post({ path: "not-captured.txt" })).status, 404);
    assert.equal((await post({ sessionId: "someone-else" })).status, 404);
    assert.deepEqual(await (await post({ reviewed: false })).json(), { paths: [] });
    assert.equal(readFileSync(path, "utf8"), "after");
    rmSync(sessionPath);
    assert.equal((await post({})).status, 404);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionManagerCache(); rmSync(dir, { recursive: true, force: true });
  }
});
test("snapshot review writes require trusted JSON and valid ownership identities", async () => {
  const request = (type, body) => new Request("http://127.0.0.1:30141/api/workbench/snapshot-reviews", { method: "POST", headers: { ...headers, "content-type": type }, body });
  assert.equal((await route.POST(request("text/plain", "{}"))).status, 415);
  assert.equal((await route.POST(request("application/json", "{bad"))).status, 400);
  assert.equal((await route.POST(request("application/json", JSON.stringify({ sessionId: "../invalid", snapshotId: randomUUID(), path: "a", reviewed: true })))).status, 400);
});
