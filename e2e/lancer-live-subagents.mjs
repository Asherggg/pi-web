// Explicit live-provider acceptance for the existing Pi Web subagent runtime.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ModelRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
if (process.env.LANCER_RUN_LIVE !== "1") throw new Error("Set LANCER_RUN_LIVE=1 to run real-provider checks.");
const out = resolve(process.env.LANCER_TEST_ARTIFACTS ?? "artifacts/lancer-next-step");
await mkdir(out, { recursive: true });
const sourceAgentDir = getAgentDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const dir = await mkdtemp(join(tmpdir(), "pi-web-lancer-parallel-"));
const models = process.env.LANCER_LIVE_MODELS ? JSON.parse(process.env.LANCER_LIVE_MODELS) : [{ provider: "ppt", modelId: "gpt-6.1-sol" }, { provider: "ppt", modelId: "gpt-6-astra" }];
const report = { kind: "real-provider-subagents", passed: false, models, isolatedAgentDir: dir, maxConcurrent: 0, children: [], returnedReports: 0, graphReportNodes: 0, reopened: [] };
const sessions = new Map();
let watchdog;
const active = new Set();
try {
  process.env.PI_CODING_AGENT_DIR = dir;
  await mkdir(join(dir, "agents"));
  await writeFile(join(dir, "settings.json"), JSON.stringify({ defaultProvider: models[0].provider, defaultModel: models[0].modelId, retry: { enabled: false } }));
  await writeFile(join(dir, "agents", "settings.json"), JSON.stringify({ builtInEnabled: true, maxConcurrent: 2 }));
  await writeFile(join(dir, "agents", "acceptance.md"), ["---", "description: Short isolated live acceptance probe.", "tools: none", "load_skills: false", "load_extensions: false", "thinking: low", "max_turns: 1", "prompt_mode: replace", "---", "Follow the supplied short task. Output only the requested token."].join("\n"));
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { createSubagentController } = await jiti.import("../lib/subagent-runtime.ts");
  const { readSubagentRun } = await jiti.import("../lib/subagents.ts");
  const { buildTaskLane, familySessionIds } = await jiti.import("../lib/workbench/graph.ts");
  const runtime = await ModelRuntime.create({ authPath: join(sourceAgentDir, "auth.json"), modelsPath: join(sourceAgentDir, "models.json"), refreshOnCreate: false });
  const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, modelRuntime: runtime, settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }), resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "You coordinate a short acceptance test. When child reports arrive, respond with all LANE- tokens found in every report in this conversation, separated by spaces. Do not use tools." } });
  const { session: parent } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(dir, join(dir, "sessions")), model: runtime.getModel(models[0].provider, models[0].modelId), thinkingLevel: "low", tools: [] });
  const parentId = parent.sessionId;
  const register = (inner) => {
    const wrapped = { inner, sessionFile: inner.sessionFile ?? "", cwd: dir, isAlive: () => true, isRunning: () => inner.isStreaming, waitUntilReady: async () => {} };
    sessions.set(inner.sessionId, wrapped);
    inner.subscribe((event) => {
      if (inner.sessionId === parentId) return;
      if (event.type === "agent_start") { active.add(inner.sessionId); report.maxConcurrent = Math.max(report.maxConcurrent, active.size); }
      if (event.type === "agent_end" || event.type === "agent_settled") active.delete(inner.sessionId);
    });
    return wrapped;
  };
  register(parent);
  const controller = createSubagentController({ getSession: (id) => sessions.get(id), registerSession: register, resolveSessionPath: async (id) => sessions.get(id)?.sessionFile ?? null, reopenSession: async () => { throw new Error("Acceptance must retain its live runtime"); }, invalidateSessionList() {}, isBuiltInSubagentsEnabled: () => true });
  watchdog = setTimeout(() => { for (const { inner } of sessions.values()) void inner.abort(); }, 180000);
  await parent.prompt("A short acceptance test is starting. Reply only READY.");
  assert.ok(parent.getLastAssistantText()?.includes("READY"), "Lead model must answer before dispatch");
  const tokens = models.map(() => `LANE-${randomBytes(5).toString("hex")}`);
  const executions = await Promise.all(models.map((model, index) => controller.extensionRuntime.start({ parentContext: { sessionManager: parent.sessionManager }, parentToolCallId: `acceptance-${index}`, profile: "acceptance", task: `Reply exactly ${tokens[index]}.`, model: `${model.provider}/${model.modelId}:low`, description: `Live acceptance lane ${index + 1}`, runInBackground: true })));
  const results = await Promise.all(executions.map((execution) => execution.completion));
  for (let i = 0; i < results.length; i++) {
    const run = results[i]; report.children.push({ sessionId: run.sessionId, model: models[i], status: run.status, result: run.result, error: run.error });
    assert.equal(run.status, "completed"); assert.ok(run.result?.includes(tokens[i]));
  }
  assert.equal(report.maxConcurrent, 2, "Both real SDK child requests must overlap");
  for (const run of results) await controller.extensionRuntime.notifyParent(run);
  const returns = parent.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "pi-web:subagent-notification");
  report.returnedReports = returns.length;
  assert.equal(returns.length, 2);
  const summary = parent.getLastAssistantText() ?? "";
  assert.ok(tokens.every((token) => summary.includes(token)), "Lead summary must retain both child results");
  report.leadSummary = summary;
  const info = { id: parentId, cwd: dir, path: parent.sessionFile, created: new Date().toISOString(), modified: new Date().toISOString(), firstMessage: "Live acceptance", messageCount: 1 };
  const lane = buildTaskLane(info, parent.sessionManager.getEntries());
  report.graphReportNodes = lane.nodes.filter((node) => node.kind === "report").length;
  assert.equal(report.graphReportNodes, 2);
  const infos = [info];
  for (const run of results) {
    const manager = SessionManager.open(run.sessionPath);
    const reopened = readSubagentRun(manager.getEntries(), run.sessionId, run.sessionPath);
    report.reopened.push({ sessionId: run.sessionId, status: reopened?.status, result: reopened?.result });
    assert.equal(reopened?.status, "completed"); assert.equal(reopened?.result, run.result);
    infos.push({ ...info, id: run.sessionId, relation: { kind: "subagent", parentSessionId: parentId, profile: "acceptance", description: run.description, status: run.status } });
  }
  assert.equal(familySessionIds(infos, parentId).size, 3);
  const stopSignal = new AbortController();
  let stopTimer;
  let stopRequestedDuringRun = false;
  const stoppedExecution = await controller.extensionRuntime.start({
    parentContext: { sessionManager: parent.sessionManager }, parentToolCallId: "acceptance-stop", profile: "acceptance",
    task: "Write a very long numbered list, one number per line, from 1 to 10000.",
    model: `${models[0].provider}/${models[0].modelId}:low`, description: "Live Stop acceptance", runInBackground: false, signal: stopSignal.signal,
    onUpdate: (run) => { if (run.status === "running" && !stopTimer) stopTimer = setTimeout(() => { stopRequestedDuringRun = true; stopSignal.abort(); }, 250); },
  });
  const stopped = await stoppedExecution.completion;
  clearTimeout(stopTimer);
  report.stop = { sessionId: stopped.sessionId, status: stopped.status, requestedDuringRun: stopRequestedDuringRun };
  assert.equal(stopRequestedDuringRun, true); assert.equal(stopped.status, "aborted");
  const reopenedStopped = readSubagentRun(SessionManager.open(stopped.sessionPath).getEntries(), stopped.sessionId, stopped.sessionPath);
  assert.equal(reopenedStopped.status, "aborted");
  const resumeToken = `RESUME-${randomBytes(5).toString("hex")}`;
  const resumed = await controller.extensionRuntime.resume({ sessionId: stopped.sessionId, parentContext: { sessionManager: parent.sessionManager }, task: `The stopped task is finished. Reply exactly ${resumeToken}.`, description: "Live resume acceptance", runInBackground: false });
  const resumedResult = await resumed.completion;
  report.resumed = { sessionId: resumedResult.sessionId, status: resumedResult.status, result: resumedResult.result };
  assert.equal(resumedResult.sessionId, stopped.sessionId); assert.equal(resumedResult.status, "completed"); assert.ok(resumedResult.result?.includes(resumeToken));
  report.passed = true;
  console.log("PASS: two real-model subagents overlapped, returned results, projected report nodes, reopened records, and passed Stop/resume");
} catch (error) { report.error = String(error); console.error(String(error)); process.exitCode = 1; }
finally {
  clearTimeout(watchdog);
  for (const { inner } of sessions.values()) inner.dispose();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await writeFile(join(out, "LIVE_PARALLEL_RESULT.json"), JSON.stringify(report, null, 2));
}
