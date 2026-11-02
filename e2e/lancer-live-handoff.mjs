// Explicit live-provider acceptance. Does not run under npm test.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
if (process.env.LANCER_RUN_LIVE !== "1") throw new Error("Set LANCER_RUN_LIVE=1 to run real-provider checks.");
const base = process.env.LANCER_TEST_BASE ?? "http://127.0.0.1:30141";
const out = resolve(process.env.LANCER_TEST_ARTIFACTS ?? "artifacts/lancer-next-step");
mkdirSync(out, { recursive: true });
const report = { kind: "real-provider-handoff", passed: false, models: [], requests: [], sessionId: null, cwd: null };
async function api(path, body) {
  const response = await fetch(`${base}${path}`, { ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${result.error ?? "request failed"}`);
  return result;
}
async function settled(id, timeoutMs = 100000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    const status = await api(`/api/agent/${id}?systemPrompt=0`);
    if (!status.state?.isStreaming && !status.state?.isPromptRunning && !status.state?.isCompacting) {
      const history = await api(`/api/sessions/${id}?tail=30`);
      const answer = history.context.messages.findLast((m) => m.role === "assistant");
      if (!answer) throw new Error("No assistant response was persisted");
      if (["error", "aborted"].includes(answer.stopReason)) throw new Error(answer.errorMessage ?? answer.stopReason);
      return { history, answer, text: answer.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") };
    }
    await delay(600);
  }
  await api(`/api/agent/${id}`, { type: "abort" });
  throw new Error("Live response exceeded its acceptance timeout and was stopped");
}
try {
  const catalog = await api(`/api/models?cwd=${encodeURIComponent(process.cwd())}`);
  const defaults = [{ provider: "ppt", modelId: "gpt-6.1-sol" }, { provider: "ppt", modelId: "gpt-6-astra" }];
  const models = process.env.LANCER_LIVE_MODELS ? JSON.parse(process.env.LANCER_LIVE_MODELS) : defaults;
  assert.equal(models.length, 2);
  for (const model of models) assert.ok(catalog.modelList.some((m) => m.provider === model.provider && m.id === model.modelId), `Model unavailable: ${model.provider}/${model.modelId}`);
  report.models = models;
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-lancer-live-")); report.cwd = cwd;
  const created = await api("/api/agent/new", { type: "ensure_session", cwd, toolNames: [], provider: models[0].provider, modelId: models[0].modelId, thinkingLevel: "minimal" });
  const id = created.sessionId; report.sessionId = id;
  await api(`/api/agent/${id}`, { type: "set_session_name", name: "Lancer live acceptance · model handoff" });
  const settings = await api("/api/workbench/modules");
  const preset = settings.modules.find((m) => !m.deleted);
  if (!preset) throw new Error("No active module available for live acceptance");
  const workflow = { moduleId: preset.id, activeStep: 0, steps: models.map((model, index) => ({ title: `Live stage ${index + 1}`, model, skills: [], goal: index ? "Recall the token from this conversation" : "Remember a verification token", deliverables: "A short verified answer" })) };
  await api("/api/workbench/modules", { revision: settings.revision, action: { type: "save-workflow", sessionId: id, workflow } });
  const token = `LANCER-${randomBytes(6).toString("hex")}`;
  await api(`/api/agent/${id}`, { type: "prompt", message: `Remember this verification token for this conversation: ${token}. Reply only READY.` });
  const first = await settled(id); report.requests.push({ stage: 0, provider: first.answer.provider, model: first.answer.model, text: first.text });
  const switched = await api(`/api/agent/${id}`, { type: "set_model", ...models[1] });
  assert.equal(switched.data.provider, models[1].provider); assert.equal(switched.data.id, models[1].modelId);
  const next = await api("/api/workbench/modules");
  await api("/api/workbench/modules", { revision: next.revision, action: { type: "select-stage", sessionId: id, index: 1 } });
  await api(`/api/agent/${id}`, { type: "prompt", message: "What verification token did I ask you to remember earlier in this conversation? Reply only that token." });
  const second = await settled(id); report.requests.push({ stage: 1, provider: second.answer.provider, model: second.answer.model, text: second.text });
  assert.ok(second.text.includes(token), "The second model did not retain the first model's conversation context");
  assert.equal(second.history.sessionId, id);
  const graph = await api(`/api/workbench/graph?sessionId=${id}&scope=current`);
  assert.equal(graph.lanes.length, 1); assert.ok(!graph.lanes[0].error);
  report.contextRetained = true;
  report.graphNodes = graph.lanes[0].nodes.length;
  report.passed = true;
  console.log(`PASS: real handoff ${models.map((m) => `${m.provider}/${m.modelId}`).join(" -> ")}; same session; context retained`);
} catch (error) {
  report.error = String(error); console.error(String(error)); process.exitCode = 1;
  if (report.sessionId) await api(`/api/agent/${report.sessionId}`, { type: "abort" }).catch(() => {});
} finally {
  writeFileSync(join(out, "LIVE_HANDOFF_RESULT.json"), JSON.stringify(report, null, 2));
}
