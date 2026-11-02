// Offline process-restart acceptance for the live probe's own persisted sessions.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const reportPath = resolve(process.argv[2] ?? "artifacts/lancer-next-step/LIVE_PARALLEL_RESULT.json");
const original = JSON.parse(await readFile(reportPath, "utf8"));
assert.equal(original.passed, true);
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readSubagentRun } = await jiti.import("../lib/subagents.ts");
const { buildTaskLane } = await jiti.import("../lib/workbench/graph.ts");
const expected = new Map([...original.children, original.resumed].map((run) => [run.sessionId, run]));
const records = [];
let parentPath;
for (const file of await readdir(join(original.isolatedAgentDir, "sessions"), { recursive: true })) {
  if (!file.endsWith(".jsonl")) continue;
  const path = join(original.isolatedAgentDir, "sessions", file);
  const manager = SessionManager.open(path);
  const expectedRun = expected.get(manager.getSessionId());
  if (!expectedRun) continue;
  const run = readSubagentRun(manager.getEntries(), manager.getSessionId(), path);
  assert.equal(run.status, expectedRun.status);
  assert.equal(run.result, expectedRun.result);
  records.push({ sessionId: run.sessionId, status: run.status, result: run.result });
  parentPath = manager.getHeader().parentSession;
}
assert.equal(records.length, expected.size);
const parent = SessionManager.open(parentPath);
const info = { id: parent.getSessionId(), cwd: original.isolatedAgentDir, path: parentPath, firstMessage: "Live probe", created: new Date().toISOString(), modified: new Date().toISOString(), messageCount: 1 };
const lane = buildTaskLane(info, parent.getEntries());
const reports = lane.nodes.filter((node) => node.kind === "report");
assert.equal(reports.length, original.returnedReports);
const result = { passed: true, newProcess: true, modelRequests: 0, records, graphReportNodes: reports.length, parentSessionId: parent.getSessionId() };
await writeFile(join(dirname(reportPath), "CROSS_PROCESS_REOPEN_RESULT.json"), JSON.stringify(result, null, 2));
console.log("PASS: a fresh Node process restored all real child results and report nodes without starting a model");
