import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { applyWorkbenchAction, initialWorkbenchState, decodeSteps, workflowPrompt } = await jiti.import("./workflow.ts");
const { readWorkbenchState, updateWorkbenchState } = await jiti.import("./workflow-store.ts");
const { buildTaskLane, familySessionIds } = await jiti.import("./graph.ts");
const session = { id: "main", cwd: "D:/project", path: "", created: "2026-01-01", modified: "2026-01-01", messageCount: 1, firstMessage: "test" };
const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message });
test("module templates are copied, edits do not rewrite assigned workflows, archive preserves them", () => {
  let state = applyWorkbenchAction(initialWorkbenchState(), { type: "assign", sessionId: "main", moduleId: "development" });
  const before = structuredClone(state.sessions.main);
  state = applyWorkbenchAction(state, { type: "save-module", module: { ...state.modules[0], steps: [{ title: "Changed", skills: [], goal: "test", deliverables: "report" }] } });
  assert.deepEqual(state.sessions.main, before);
  state = applyWorkbenchAction(state, { type: "toggle-module", id: "development", deleted: true });
  assert.deepEqual(state.sessions.main, before);
  assert.throws(() => applyWorkbenchAction(state, { type: "assign", sessionId: "other", moduleId: "development" }));
  state = applyWorkbenchAction(state, { type: "toggle-module", id: "development", deleted: false });
  assert.equal(state.modules[0].deleted, undefined);
  state = applyWorkbenchAction(state, { type: "assign", sessionId: "main", moduleId: null });
  assert.equal(state.sessions.main.disabled, true);
  state = applyWorkbenchAction(state, { type: "assign", sessionId: "main", moduleId: "development" });
  assert.deepEqual(state.sessions.main.steps, before.steps);
  assert.equal(state.sessions.main.disabled, undefined);
});
test("stage validation rejects invalid ranges and keeps selection distinct from completion", () => {
  assert.throws(() => decodeSteps([]));
  assert.throws(() => decodeSteps(new Array(9).fill({ title: "x" })));
  assert.throws(() => decodeSteps([{ title: "x", goal: "x".repeat(4001) }]));
  const state = applyWorkbenchAction(initialWorkbenchState(), { type: "assign", sessionId: "main", moduleId: "research" });
  assert.throws(() => applyWorkbenchAction(state, { type: "select-stage", sessionId: "main", index: 30 }));
  const next = applyWorkbenchAction(state, { type: "select-stage", sessionId: "main", index: 1 });
  assert.equal(next.sessions.main.activeStep, 1);
  assert.equal(next.sessions.main.completed, undefined);
});
test("stage prompt uses actual discovered skill files and refuses missing or disabled skills", () => {
  const step = { title: "Read", skills: ["repo"], goal: "Study", deliverables: "Report" };
  const skills = [{ name: "repo", filePath: "/skills/repo/SKILL.md" }];
  const text = workflowPrompt(step, skills, "zh-CN");
  assert.match(text, /\/skills\/repo\/SKILL.md/);
  assert.match(text, /Report/);
  assert.throws(() => workflowPrompt(step, []));
  assert.throws(() => workflowPrompt(step, [{ ...skills[0], disableModelInvocation: true }]));
});
test("store uses revision checks across concurrent writers and refuses corrupt saved bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-workbench-")); const path = join(dir, "state.json");
  try {
    assert.equal(readWorkbenchState(path).revision, 0);
    const first = await updateWorkbenchState({ type: "assign", sessionId: "main", moduleId: "research" }, 0, path);
    const outcomes = await Promise.allSettled([
      updateWorkbenchState({ type: "select-stage", sessionId: "main", index: 0 }, first.revision, path),
      updateWorkbenchState({ type: "select-stage", sessionId: "main", index: 1 }, first.revision, path),
    ]);
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(readWorkbenchState(path).revision, 2);
    writeFileSync(path, "{broken original");
    await assert.rejects(updateWorkbenchState({ type: "assign", sessionId: "main", moduleId: null }, 0, path));
    assert.equal(readFileSync(path, "utf8"), "{broken original");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("a run that starts while a settings write is queued prevents that write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-workbench-")); const path = join(dir, "state.json");
  try {
    const original = JSON.stringify(initialWorkbenchState()); writeFileSync(path, original);
    await assert.rejects(updateWorkbenchState({ type: "assign", sessionId: "main", moduleId: "research" }, 0, path, () => { throw new Error("busy"); }));
    assert.equal(readFileSync(path, "utf8"), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("dangerous object keys cannot be session identities", () => {
  for (const sessionId of ["__proto__", "constructor", "prototype", "../escape"]) assert.throws(() => applyWorkbenchAction(initialWorkbenchState(), { type: "assign", sessionId, moduleId: "research" }));
});
test("task graph keeps native branches and hides system content", () => {
  const lane = buildTaskLane(session, [entry("u", null, { role: "user", content: "question" }), entry("sys", "u", { role: "system", content: "secret" }), entry("a", "sys", { role: "assistant", content: [{ type: "text", text: "first" }] }), entry("b", "u", { role: "assistant", content: [{ type: "text", text: "alternative" }] })]);
  assert.deepEqual(lane.nodes.map((n) => n.entryId), ["u", "a", "b"]);
  assert.equal(lane.nodes[1].parentId, "main:u");
  assert.equal(lane.nodes[2].parentId, "main:u");
  assert.ok(!JSON.stringify(lane).includes("secret"));
});
test("deliverables require a successful tool result; prose and failed calls create no file nodes", () => {
  const call = entry("a", null, { role: "assistant", content: [{ type: "toolCall", id: "call", name: "write", arguments: { path: "report.md", content: "done" } }] });
  const result = (error) => entry("r", "a", { role: "toolResult", toolCallId: "call", toolName: "write", isError: error, content: [{ type: "text", text: "done" }] });
  assert.equal(buildTaskLane(session, [call]).nodes.filter((n) => n.kind === "file").length, 0);
  assert.equal(buildTaskLane(session, [call, result(true)]).nodes.filter((n) => n.kind === "file").length, 0);
  const files = buildTaskLane(session, [call, result(false)]).nodes.filter((n) => n.kind === "file");
  assert.equal(files.length, 1); assert.match(files[0].filePath, /report\.md$/);
  assert.equal(buildTaskLane(session, [entry("a", null, { role: "assistant", content: [{ type: "text", text: "Created fake.md" }] })]).nodes.filter((n) => n.kind === "file").length, 0);
});
test("family scope includes recursive subagents but does not absorb independent forks", () => {
  const rows = [session, { ...session, id: "child", relation: { kind: "subagent", parentSessionId: "main" } }, { ...session, id: "grandchild", relation: { kind: "subagent", parentSessionId: "child" } }, { ...session, id: "fork", parentSessionId: "main", relation: { kind: "fork" } }];
  assert.deepEqual([...familySessionIds(rows, "child")].sort(), ["child", "grandchild", "main"]);
});
test("graph projections are bounded and preserve the newest native IDs", () => {
  const entries = new Array(500).fill(0).map((_, i) => entry(String(i), i ? String(i - 1) : null, { role: "user", content: "x".repeat(1000) }));
  const lane = buildTaskLane(session, entries, 100);
  assert.equal(lane.nodes.length, 100); assert.equal(lane.truncated, true); assert.equal(lane.nodes.at(-1).entryId, "499"); assert.ok(lane.nodes.every((n) => n.text.length <= 180));
});
