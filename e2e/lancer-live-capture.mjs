// Explicit live acceptance for future-turn capture via the running Pi Web HTTP API.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
if (process.env.LANCER_RUN_LIVE !== "1") throw new Error("Set LANCER_RUN_LIVE=1 for real model capture acceptance");
const base = process.env.LANCER_TEST_BASE ?? "http://127.0.0.1:30141";
const out = resolve(process.env.LANCER_TEST_ARTIFACTS ?? "artifacts/lancer-p4"); mkdirSync(out, { recursive: true });
const result = { passed: false, realProvider: true, sessionId: null, cwd: null };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function api(path, body) {
  const response = await fetch(base + path, { ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const json = await response.json(); if (!response.ok) throw new Error(`${path}: ${response.status} ${json.error ?? "failure"}`); return json;
}
async function waitForRun(id) {
  const end = performance.now() + 120000;
  while (performance.now() < end) {
    const status = await api(`/api/agent/${id}?systemPrompt=0`);
    if (status.state && !status.state.isStreaming && !status.state.isPromptRunning) {
      const history = await api(`/api/sessions/${id}?tail=30`);
      const answer = history.context.messages.findLast((message) => message.role === "assistant");
      if (!answer || ["error", "aborted"].includes(answer.stopReason)) throw new Error(answer?.errorMessage ?? "live answer incomplete");
      return history;
    }
    await delay(600);
  }
  await api(`/api/agent/${id}`, { type: "abort" }); throw new Error("Live capture probe exceeded its deadline and was stopped");
}
try {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-live-capture-")); result.cwd = cwd;
  execFileSync("git", ["init", "--template=", "-q", cwd], { windowsHide: true });
  writeFileSync(join(cwd, "existing.txt"), "original before the agent ran\n");
  execFileSync("git", ["-C", cwd, "-c", "core.fsmonitor=false", "add", "existing.txt"], { windowsHide: true });
  const indexBefore = hash(readFileSync(join(cwd, ".git", "index")));
  const headBefore = readFileSync(join(cwd, ".git", "HEAD"), "utf8");
  const model = process.env.LANCER_LIVE_MODEL ? JSON.parse(process.env.LANCER_LIVE_MODEL) : { provider: "ppt", modelId: "gpt-6.1-sol" };
  const created = await api("/api/agent/new", { type: "ensure_session", cwd, toolNames: ["write"], provider: model.provider, modelId: model.modelId, thinkingLevel: "low" });
  const id = created.sessionId; result.sessionId = id;
  await api(`/api/agent/${id}`, { type: "set_session_name", name: "Lancer P4 live acceptance · captured writes" });
  await api(`/api/agent/${id}`, { type: "prompt", message: "A short test is starting. Reply only READY. Do not use tools yet." }); await waitForRun(id);
  const before = await api(`/api/workbench/snapshots?sessionId=${id}`); assert.equal(before.snapshots.length, 0);
  await api("/api/workbench/snapshots", { sessionId: id, action: "set-enabled", enabled: true });
  const marker = `CAPTURE-${randomBytes(5).toString("hex")}`;
  await api(`/api/agent/${id}`, { type: "prompt", message: `Use the write tool to replace existing.txt with exactly ${marker}, and create delivery.txt with exactly ${marker}. Then reply DONE. Both files are in the current working directory.` });
  await waitForRun(id);
  const listing = await api(`/api/workbench/snapshots?sessionId=${id}`);
  assert.equal(listing.snapshots.length, 1);
  const snapshot = await api(`/api/workbench/snapshots?sessionId=${id}&snapshotId=${listing.snapshots[0].snapshotId}`);
  assert.equal(snapshot.status, "completed"); assert.equal(snapshot.coverage.state, "complete");
  const changed = snapshot.files.find((file) => file.path === "existing.txt"), delivered = snapshot.files.find((file) => file.path === "delivery.txt");
  assert.equal(changed.before, "original before the agent ran\n"); assert.ok(changed.after.includes(marker));
  assert.equal(delivered.before, null); assert.ok(delivered.after.includes(marker));
  await api("/api/workbench/snapshot-reviews", { sessionId: id, snapshotId: snapshot.snapshotId, path: "existing.txt", reviewed: true });
  const marks = await api(`/api/workbench/snapshot-reviews?sessionId=${id}&snapshotId=${snapshot.snapshotId}`);
  assert.deepEqual(marks.paths, ["existing.txt"]);
  await api("/api/workbench/snapshots", { sessionId: id, action: "set-enabled", enabled: false });
  const graph = await api(`/api/workbench/graph?sessionId=${id}&scope=current`);
  assert.ok(graph.lanes[0].nodes.some((node) => node.kind === "file" && node.filePath.endsWith("delivery.txt")));
  assert.equal(hash(readFileSync(join(cwd, ".git", "index"))), indexBefore);
  assert.equal(readFileSync(join(cwd, ".git", "HEAD"), "utf8"), headBefore);
  Object.assign(result, { passed: true, model, snapshotId: snapshot.snapshotId, captureStatus: snapshot.status, coverage: snapshot.coverage.state, changedPaths: snapshot.files.map((file) => file.path), fileReviewRestored: true, sourceIndexUnchanged: true, sourceHeadUnchanged: true, recorderDisabledAfterTest: true });
  console.log("PASS: real model writes captured before/after; file review persisted; source Git index and HEAD unchanged");
} catch (cause) { result.error = String(cause); process.exitCode = 1; console.error(String(cause)); if (result.sessionId) { await api(`/api/agent/${result.sessionId}`, { type: "abort" }).catch(() => {}); await api("/api/workbench/snapshots", { sessionId: result.sessionId, action: "set-enabled", enabled: false }).catch(() => {}); } }
finally { writeFileSync(join(out, "LIVE_CAPTURE_RESULT.json"), JSON.stringify(result, null, 2)); }
