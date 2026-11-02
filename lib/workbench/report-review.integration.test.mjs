import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../../app/api/workbench/reviews/route.ts");
const { cacheSessionPath, invalidateSessionManagerCache } = await jiti.import("../session-reader.ts");
const { readWorkbenchState } = await jiti.import("./workflow-store.ts");
const { buildReportEvidence, reportFiles } = await jiti.import("./report-evidence.ts");
const { readSubagentRun } = await jiti.import("../subagents.ts");
const { buildTaskLane } = await jiti.import("./graph.ts");
const { applyWorkbenchAction, initialWorkbenchState } = await jiti.import("./workflow.ts");
const host = { host: "127.0.0.1:30141", origin: "http://127.0.0.1:30141", "content-type": "application/json" };
const time = "2026-11-02T00:00:00.000Z";
const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: time, message });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-report-api-"));
  const agentDir = join(dir, "agent"); mkdirSync(agentDir);
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const childId = `child-${Date.now()}`, parentId = `parent-${Date.now()}`, reportEntryId = "report", artifact = join(dir, "report.txt");
  writeFileSync(artifact, "original");
  const parentPath = join(dir, "parent.jsonl"), childPath = join(dir, "child.jsonl");
  const message = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: time, message });
  const parentEntries = [message("call", null, { role: "assistant", content: [{ type: "toolCall", id: "dispatch", name: "Agent", arguments: {} }] }), { type: "custom_message", id: reportEntryId, parentId: "call", timestamp: time, customType: "pi-web:subagent-notification", display: true, content: "Result received", details: { kind: "pi-web-subagent", sessionId: childId, status: "completed", completedAt: time, resultEntryId: "result" } }];
  const childEntries = [{ type: "custom", id: "meta", parentId: null, timestamp: time, customType: "pi-web:subagent", data: { version: 1, parentSessionId: parentId, parentSessionPath: parentPath, parentToolCallId: "dispatch" } }, message("write", "meta", { role: "assistant", content: [{ type: "toolCall", id: "write-call", name: "write", arguments: { path: artifact, content: "original" } }] }), message("written", "write", { role: "toolResult", toolCallId: "write-call", toolName: "write", isError: false, content: [{ type: "text", text: "Written" }] }), { type: "custom", id: "result", parentId: "written", timestamp: time, customType: "pi-web:subagent-result", data: { version: 1, status: "completed", completedAt: time, result: "Verified result" } }];
  const save = (path, id, entries) => writeFileSync(path, [{ type: "session", version: 3, id, cwd: dir, timestamp: time }, ...entries].map((x) => JSON.stringify(x)).join("\n") + "\n");
  save(parentPath, parentId, parentEntries); save(childPath, childId, childEntries);
  cacheSessionPath(parentId, parentPath); cacheSessionPath(childId, childPath);
  const query = new URLSearchParams({ parentSessionId: parentId, childSessionId: childId, reportEntryId });
  const detail = () => route.GET(new Request(`http://127.0.0.1:30141/api/workbench/reviews?${query}`, { headers: host }));
  const submit = (evidence, revision, status, note = "") => route.POST(new Request("http://127.0.0.1:30141/api/workbench/reviews", { method: "POST", headers: host, body: JSON.stringify({ parentSessionId: parentId, childSessionId: childId, reportEntryId, resultEntryId: evidence.resultEntryId, fingerprint: evidence.fingerprint, revision, status, note }) }));
  return { dir, detail, submit, parentPath, childPath, parentId, childId, artifact, cleanup: () => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; invalidateSessionManagerCache(); rmSync(dir, { recursive: true, force: true }); } };
}
test("review API persists exact decisions, rejects premature or stale saves, and never writes transcripts", async () => {
  const f = fixture();
  try {
    const originalParent = readFileSync(f.parentPath), originalChild = readFileSync(f.childPath);
    const first = await (await f.detail()).json();
    assert.equal(first.evidence.text, "Verified result"); assert.equal(first.evidence.files[0].state, "available");
    const premature = await f.submit(first.evidence, first.revision, "accepted");
    assert.equal(premature.status, 409, await premature.clone().text());
    const reviewed = await (await f.submit(first.evidence, first.revision, "reviewed", "Read report and checked file")).json();
    assert.equal(reviewed.evidence.adoption.status, "reviewed");
    const accepted = await (await f.submit(reviewed.evidence, reviewed.revision, "accepted", "Verified")).json();
    assert.equal(accepted.evidence.adoption.status, "accepted");
    assert.equal((await f.submit(first.evidence, first.revision, "reviewed")).status, 409);
    assert.equal(Object.values(readWorkbenchState().adoptions)[0].status, "accepted");
    writeFileSync(f.artifact, "changed");
    const changed = await (await f.detail()).json();
    assert.equal(changed.evidence.staleReview, true);
    assert.equal((await f.submit(accepted.evidence, accepted.revision, "accepted")).status, 409);
    const rerunReviewed = await (await f.submit(changed.evidence, accepted.revision, "reviewed")).json();
    const correction = await (await f.submit(rerunReviewed.evidence, rerunReviewed.revision, "needs_changes", "Update the conclusions")).json();
    assert.equal(correction.evidence.adoption.status, "needs_changes");
    assert.deepEqual(readFileSync(f.parentPath), originalParent); assert.deepEqual(readFileSync(f.childPath), originalChild);
  } finally { f.cleanup(); }
});
test("a child resumed after notification makes its old report unavailable and leaves the new generation unreviewed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-generation-test-"));
  try {
    const completed1 = "2026-11-02T00:01:00Z", completed2 = "2026-11-02T00:02:00Z";
    const childSession = { ...fixtureSession("child-generation"), cwd: dir };
    const parent = { ...fixtureSession("parent-generation"), cwd: dir };
    const metadata = { type: "custom", id: "meta", parentId: null, timestamp: completed1, customType: "pi-web:subagent", data: { version: 1, parentSessionId: parent.id, parentSessionPath: "parent.jsonl", parentToolCallId: "dispatch" } };
    const result1 = { type: "custom", id: "result-1", parentId: "answer-1", timestamp: completed1, customType: "pi-web:subagent-result", data: { version: 1, status: "completed", completedAt: completed1, result: "old" } };
    const result2 = { type: "custom", id: "result-2", parentId: "answer-2", timestamp: completed2, customType: "pi-web:subagent-result", data: { version: 1, status: "completed", completedAt: completed2, result: "new" } };
    const notify = (id, completedAt) => ({ type: "custom_message", id, parentId: "dispatch-answer", timestamp: completedAt, customType: "pi-web:subagent-notification", display: true, content: `Result ${completedAt}`, details: { kind: "pi-web-subagent", sessionId: childSession.id, completedAt, status: "completed", resultEntryId: id === "report-1" ? "result-1" : "result-2" } });
    const childEntries = [metadata, entry("answer-1", null, { role: "assistant", content: [{ type: "text", text: "old" }] }), result1, { type: "custom", id: "resume-status", parentId: "result-1", timestamp: completed2, customType: "pi-web:subagent-status", data: { version: 1, status: "running" } }, entry("answer-2", "resume-status", { role: "assistant", content: [{ type: "text", text: "new" }] }), result2];
    const parentEntries = [entry("dispatch", null, { role: "assistant", content: [{ type: "toolCall", id: "child-call", name: "Agent", arguments: {} }] }), notify("report-1", completed1), notify("report-2", completed2)];
    const childPath = join(dir, "child.jsonl"); writeFileSync(childPath, "stub\n");
    const old = buildReportEvidence({ parentSessionId: parent.id, childSessionId: childSession.id, reportEntryId: "report-1", parentEntries, childEntries, childPath, cwd: dir, busy: false, adoptions: {} });
    const latest = buildReportEvidence({ parentSessionId: parent.id, childSessionId: childSession.id, reportEntryId: "report-2", parentEntries, childEntries, childPath, cwd: dir, busy: false, adoptions: {} });
    assert.equal(old.latest, false); assert.equal(old.canReview, false); assert.equal(latest.latest, true); assert.notEqual(old.resultEntryId, latest.resultEntryId);
    const adoption = applyWorkbenchAction(initialWorkbenchState(), { type: "review-report", parentSessionId: parent.id, childSessionId: childSession.id, reportEntryId: "report-1", resultEntryId: old.resultEntryId, fingerprint: old.fingerprint, status: "reviewed" }).adoptions;
    const oldProjection = buildTaskLane(parent, parentEntries);
    assert.deepEqual(oldProjection.nodes.filter((node) => node.kind === "report").map((node) => node.completedAt), [completed1, completed2]);
    assert.throws(() => buildReportEvidence({ parentSessionId: parent.id, childSessionId: childSession.id, reportEntryId: "report-1", parentEntries: parentEntries.map((e) => e.id === "report-1" ? { ...e, details: { ...e.details, sessionId: "different-child" } } : e), childEntries, childPath, cwd: dir, busy: false, adoptions: adoption }), { code: "reportMismatch" });
    const changed = buildReportEvidence({ parentSessionId: parent.id, childSessionId: childSession.id, reportEntryId: "report-2", parentEntries, childEntries, childPath, cwd: dir, busy: false, adoptions: adoption });
    assert.equal(changed.adoption, undefined);
    assert.equal(reportFiles(childEntries, childEntries.length - 1, dir).length, 0);
    assert.equal(readSubagentRun(childEntries, childSession.id, childPath)?.completedAt, completed2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
function fixtureSession(id) { return { id, path: `${id}.jsonl`, cwd: "/tmp", created: time, modified: time, messageCount: 1, firstMessage: "fixture" }; }

test("a resumed child invalidates the older report and missing artifacts cannot be accepted", async () => {
  const f = fixture();
  try {
    const first = await (await f.detail()).json();
    const reviewed = await (await f.submit(first.evidence, first.revision, "reviewed")).json();
    rmSync(f.artifact);
    const missing = await (await f.detail()).json();
    assert.equal(missing.evidence.files[0].state, "missing");
    assert.equal((await f.submit(missing.evidence, reviewed.revision, "accepted")).status, 409);
    appendFileSync(f.childPath, JSON.stringify({ type: "custom", id: "resume", parentId: "result", timestamp: time, customType: "pi-web:subagent-status", data: { version: 1, status: "running" } }) + "\n");
    const previous = await (await f.detail()).json();
    assert.equal(previous.evidence.latest, false); assert.equal(previous.evidence.staleReview, true);
    assert.equal((await f.submit(previous.evidence, reviewed.revision, "reviewed")).status, 409);
  } finally { f.cleanup(); }
});
test("review GET refuses legacy session migrations before SessionManager.open changes the transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-legacy-review-"));
  const agentDir = join(dir, "agent"); mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const sessionPath = join(dir, "legacy.jsonl"), bytes = JSON.stringify({ type: "session", version: 2, id: "legacy-session", cwd: dir, timestamp: time }) + "\n";
    writeFileSync(sessionPath, bytes); cacheSessionPath("legacy-session", sessionPath);
    const query = new URLSearchParams({ parentSessionId: "legacy-session", childSessionId: "child-session", reportEntryId: "report" });
    const response = await route.GET(new Request(`http://127.0.0.1:30141/api/workbench/reviews?${query}`, { headers: host }));
    assert.equal(response.status, 409); assert.equal((await response.json()).error, "sessionVersionUnavailable");
    assert.equal(readFileSync(sessionPath, "utf8"), bytes);
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; invalidateSessionManagerCache(); rmSync(dir, { recursive: true, force: true }); }
});
test("report routes reject foreign origins, malformed IDs and non-JSON writes", async () => {
  const request = (options) => new Request("http://127.0.0.1:30141/api/workbench/reviews", options);
  assert.equal((await route.POST(request({ method: "POST", headers: { ...host, origin: "https://evil.invalid" }, body: "{}" }))).status, 403);
  assert.equal((await route.POST(request({ method: "POST", headers: { ...host, "content-type": "text/plain" }, body: "{}" }))).status, 415);
  assert.equal((await route.GET(request({ headers: host }))).status, 400);
  assert.equal((await route.POST(request({ method: "POST", headers: host, body: "{broken" }))).status, 400);
});
