import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(pathToFileURL(shimPath).href);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const workflow = { moduleId: "research", activeStep: 0, steps: [{ title: "Read", model: { provider: "fixture", modelId: "one" }, skills: [], goal: "Inspect", deliverables: "Report" }] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };
globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();
async function fixture({ reject = false, precreated = false } = {}) {
  const calls = [], restored = [], created = [], choices = [];
  const sources = [];
  const fetchBefore = globalThis.fetch;
  const eventSourceBefore = globalThis.EventSource;
  globalThis.EventSource = class {
    readyState = 0;
    constructor() { sources.push(this); queueMicrotask(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }); }); }
    close() { this.readyState = 2; }
  };
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
    calls.push({ url, body });
    if (url === "/api/agent/new") return json({ sessionId: "created-id" });
    if (url === "/api/workbench/modules") return body
      ? reject ? json({ error: "conflict" }, 409) : json({ revision: 4 })
      : json({ revision: 3 });
    if (url === "/api/agent/created-id" && body) return json({ success: true, data: null });
    if (url.includes("/lease")) return json({ running: false });
    return json({});
  };
  const hook = renderHook(useAgentSession, {
    session: null, newSessionCwd: "/project", newSessionDraftKey: "new:workflow-test", t: (key) => key,
    onNewSessionChoicesChange: (value) => choices.push(value),
    onSessionCreated: (value) => created.push(value.id),
    chatInputRef: { current: { restoreSubmission: (...args) => restored.push(args), rekeyDraft() {} } },
  });
  await settle(); hook.flush();
  hook.result.handleNewWorkflowChange(workflow); hook.flush();
  await settle(); hook.flush();
  assert.equal(calls.filter((c) => c.url === "/api/agent/new").length, 0, "Picking a module is local only");
  assert.deepEqual(choices.at(-1).workflow, workflow);
  if (precreated) hook.result.sessionIdRef.current = "created-id";
  return { hook, calls, restored, created, close: () => { hook.unmount(); for (const source of sources) source.close(); globalThis.fetch = fetchBefore; globalThis.EventSource = eventSourceBefore; } };
}
for (const precreated of [false, true]) {
  test(`a new composer persists its workflow before the first prompt (${precreated ? "runtime already ensured" : "runtime not created"})`, async () => {
    const f = await fixture({ precreated });
    try {
      await f.hook.result.handleSend("User's first task"); await settle(); f.hook.flush();
      const saved = f.calls.findIndex((c) => c.body?.action?.type === "save-workflow");
      const prompt = f.calls.findIndex((c) => c.body?.type === "prompt");
      assert.ok(saved >= 0 && saved < prompt);
      assert.equal(f.calls[saved].body.action.sessionId, "created-id");
      assert.deepEqual(f.calls[saved].body.action.workflow, workflow);
      assert.equal(f.calls[prompt].body.message, "User's first task");
      assert.deepEqual(f.created, ["created-id"]);
    } finally { f.close(); }
  });
}
test("a stale workflow save preserves the first draft and prevents model dispatch", async () => {
  const f = await fixture({ reject: true });
  const previous = console.error; console.error = () => {};
  try {
    await f.hook.result.handleSend("Keep this first task"); await settle(); f.hook.flush();
    assert.equal(f.calls.some((c) => c.body?.type === "prompt"), false);
    assert.equal(f.restored[0][0], "Keep this first task");
    assert.deepEqual(f.created, []);
  } finally { console.error = previous; f.close(); }
});
