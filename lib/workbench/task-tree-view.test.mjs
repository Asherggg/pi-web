import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildTaskLane } = await jiti.import("./graph.ts");
const { taskTurns, turnAnchorOwners, currentTaskTurn } = await jiti.import("./task-tree-view.ts");
const { compactToolTarget } = await jiti.import("./task-tool-summary.ts");
const session = { id: "s", cwd: "D:/repo", name: "Session" };
const stamp = "2026-01-01T00:00:00Z";
const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: stamp, message });
const user = (id, parentId = null) => entry(id, parentId, { role: "user", content: id });
const call = (id, parentId, toolId, name = "read", args = { path: "D:/repo/components/Panel.tsx" }) => entry(id, parentId, { role: "assistant", content: [{ type: "toolCall", id: toolId, name, arguments: args }] });
const result = (id, parentId, toolId, error = false) => entry(id, parentId, { role: "toolResult", toolCallId: toolId, toolName: "read", isError: error, content: [{ type: "text", text: "import SECRET_SOURCE from './large-file';".repeat(40) }] });
const answer = (id, parentId) => entry(id, parentId, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: id }] });

test("tool rows use recorded arguments, merge a result by identity and preserve navigation to that result", () => {
  const entries = [user("u"), call("c", "u", "read1"), result("r", "c", "read1"), answer("a", "r")];
  const before = JSON.stringify(entries);
  const lane = buildTaskLane(session, entries);
  const [turn] = taskTurns(lane);
  assert.equal(turn.toolCount, 1);
  const operation = turn.process.find((row) => row.operation);
  assert.equal(operation.node.entryId, "r");
  assert.equal(operation.settled, true);
  assert.deepEqual(operation.members.map((node) => node.entryId), ["c", "r"]);
  assert.equal(compactToolTarget(operation.operation), "Panel.tsx");
  assert.ok(!JSON.stringify(lane).includes("SECRET_SOURCE"));
  assert.equal(JSON.stringify(entries), before, "display work never rewrites transcript inputs");
  assert.equal(turn.highlights.at(-1).node.entryId, "a");
});

test("branch ownership follows parents rather than file adjacency, even if the prompt was windowed out", () => {
  const lane = buildTaskLane(session, [user("u"), answer("a1", "u"), user("u2", "a1"), answer("a2", "u2"), answer("branch", "u")], 3);
  const turns = taskTurns(lane);
  assert.deepEqual(turns.map((turn) => turn.nodes.map((node) => node.entryId)), [["u2", "a2"], ["branch"]]);
  assert.equal(turns[1].id, "turn:s:u");
  assert.equal(turns[0].id, "turn:s:u2");
});

test("batched calls count each operation once and do not guess which tool represents a shared entry", () => {
  const batched = entry("c", "u", { role: "assistant", content: [
    { type: "toolCall", id: "x", name: "read", arguments: { path: "one.ts" } },
    { type: "toolCall", id: "y", name: "edit", arguments: { path: "two.ts", edits: [{ oldText: "a", newText: "b" }] } },
  ] });
  const lane = buildTaskLane(session, [user("u"), batched, result("r1", "c", "x"), result("r2", "r1", "y"), answer("a", "r2")]);
  const [turn] = taskTurns(lane);
  assert.equal(turn.toolCount, 2);
  assert.equal(turn.process.length, 2);
  const owners = turnAnchorOwners(turn, true, turn.rows);
  assert.equal(owners.get("s:c"), turn.id, "ambiguous batched call maps explicitly to its round");
  assert.equal(owners.get("s:r1"), turn.process[0].id);
  assert.equal(owners.get("s:r2"), turn.process[1].id);
});

test("folds map every native ID to the owning round; expanded rows restore exact targets", () => {
  const [turn] = taskTurns(buildTaskLane(session, [user("u"), call("c", "u", "x"), result("r", "c", "x"), answer("a", "r")]));
  const closed = turnAnchorOwners(turn, false, []);
  assert.deepEqual([...new Set(closed.values())], [turn.id]);
  assert.deepEqual([...closed.keys()], ["s:u", "s:c", "s:r", "s:a"]);
  const open = turnAnchorOwners(turn, true, turn.highlights);
  assert.equal(open.get("s:a"), "s:a");
  assert.equal(open.get("s:r"), turn.id);
});

test("failed results stay actionable highlights, and unmatched calls are never presented as successful", () => {
  const [turn] = taskTurns(buildTaskLane(session, [user("u"), call("c", "u", "bad"), result("r", "c", "bad", true), call("unfinished", "r", "pending")]));
  assert.equal(turn.error, true);
  assert.equal(turn.highlights[0].node.entryId, "r");
  assert.equal(turn.highlights[0].settled, true);
  assert.equal(turn.process.at(-1).settled, false);
});

test("truncation does not lose the operation summary of a retained result", () => {
  const lane = buildTaskLane(session, [user("u"), call("c", "u", "x"), result("r", "c", "x")], 1);
  const [turn] = taskTurns(lane);
  assert.equal(turn.id, "turn:s:u");
  assert.equal(turn.toolCount, 1);
  assert.equal(turn.rows[0].settled, true);
  assert.equal(compactToolTarget(turn.rows[0].operation), "Panel.tsx");
});

test("a reused toolCallId on another branch cannot steal the result's operation", () => {
  const entries = [user("u"), call("left", "u", "same", "read", { path: "left.ts" }),
    call("right", "u", "same", "read", { path: "right.ts" }), result("r", "left", "same")];
  const lane = buildTaskLane(session, entries);
  const [turn] = taskTurns(lane);
  const completed = turn.rows.find((row) => row.node.entryId === "r");
  assert.equal(completed.operation.target, "left.ts");
  assert.equal(completed.id, "s:left:tool:same");
  assert.deepEqual(completed.members.map((node) => node.entryId), ["left", "r"]);
});

test("two branch results under the same call retain separate navigation and an unambiguous folded owner", () => {
  const [turn] = taskTurns(buildTaskLane(session, [user("u"), call("c", "u", "x"), result("left", "c", "x"), result("right", "c", "x")]));
  assert.equal(turn.toolCount, 2);
  assert.deepEqual(turn.process.map((row) => row.node.entryId), ["left", "right"]);
  const owners = turnAnchorOwners(turn, true, turn.rows);
  assert.equal(owners.get("s:c"), turn.id);
  assert.notEqual(owners.get("s:left"), owners.get("s:right"));
});

test("refreshing a result replaces a pending display row without changing its key", () => {
  const entries = [user("u"), call("c", "u", "x")];
  const before = taskTurns(buildTaskLane(session, entries))[0].process[0];
  const after = taskTurns(buildTaskLane(session, [...entries, result("r", "c", "x")]))[0].process[0];
  assert.equal(before.id, after.id);
  assert.equal(before.settled, false);
  assert.equal(after.settled, true);
});

test("repeated deliveries to one path collapse to one stable file row with all native IDs mapped", () => {
  const file = (id) => ({ id, sessionId: "s", entryId: id, kind: "file", parentId: "s:u", turnId: "s:u", filePath: "D:/repo/report.txt", text: "D:/repo/report.txt", timestamp: stamp });
  const lane = { session, nodes: [{ id: "s:u", entryId: "u", sessionId: "s", kind: "user", text: "work", parentId: null, turnId: "s:u", timestamp: stamp }, file("first"), file("second")] };
  const [turn] = taskTurns(lane);
  assert.equal(turn.highlights.length, 1);
  assert.equal(turn.fileCount, 1);
  assert.equal(turn.highlights[0].node.id, "second");
  const owners = turnAnchorOwners(turn, true, turn.highlights);
  assert.equal(owners.get("first"), turn.highlights[0].id);
  assert.equal(owners.get("second"), turn.highlights[0].id);
  assert.equal(turn.process.length, 0);
});

test("the active round is selected by branch membership and IDs remain stable across refreshes", () => {
  const lane = buildTaskLane(session, [user("u1"), answer("a1", "u1"), user("u2", "a1"), answer("a2", "u2")]);
  lane.nodes.forEach((node) => { node.active = ["u1", "a1"].includes(node.entryId); });
  const turns = taskTurns(lane);
  assert.equal(currentTaskTurn(turns), "turn:s:u1");
  assert.deepEqual(taskTurns(structuredClone(lane)).map((turn) => turn.id), turns.map((turn) => turn.id));
});
