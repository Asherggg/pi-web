import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { initialWorkbenchState } = await jiti.import("./workflow.ts");
const { assignDraftModule, persistInitialWorkflow, readWorkflowDraft, writeWorkflowDraft, rekeyWorkflowDraft } = await jiti.import("./draft-workflow.ts");

test("new composers copy a module template and preserve their own edited stage plan", () => {
  const state = initialWorkbenchState();
  let plan = assignDraftModule(state, null, "research");
  plan.steps[0].goal = "A user-specific task";
  assert.equal(state.modules[1].steps[0].goal, "");
  plan = assignDraftModule(state, plan, null);
  assert.equal(plan.disabled, true);
  plan = assignDraftModule(state, plan, "research");
  assert.equal(plan.disabled, undefined);
  assert.equal(plan.steps[0].goal, "A user-specific task");
});

test("workflow drafts survive composer rekeying but do not leak into other drafts", () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  globalThis.window = { sessionStorage: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) } };
  try {
    const plan = assignDraftModule(initialWorkbenchState(), null, "github");
    writeWorkflowDraft("new:first", plan);
    rekeyWorkflowDraft("new:first", "new:next");
    assert.equal(readWorkflowDraft("new:first"), null);
    assert.deepEqual(readWorkflowDraft("new:next"), plan);
    assert.equal(readWorkflowDraft("new:unrelated"), null);
    values.set("pi-web:lancer-workflow-draft:invalid", "{broken");
    assert.equal(readWorkflowDraft("invalid"), null);
  } finally { globalThis.window = previousWindow; }
});

test("the first prompt's workflow snapshot is saved with the current revision and real session id", async () => {
  const fetchBefore = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    return new Response(JSON.stringify(options.method === "POST" ? { revision: 8 } : { revision: 7 }), { status: 200 });
  };
  try {
    const plan = assignDraftModule(initialWorkbenchState(), null, "research");
    await persistInitialWorkflow("real-id", plan);
    assert.equal(requests.length, 2);
    const saved = JSON.parse(requests[1].body);
    assert.equal(saved.revision, 7);
    assert.equal(saved.action.sessionId, "real-id");
    assert.deepEqual(saved.action.workflow, plan);
    requests.length = 0;
    await persistInitialWorkflow("real-id", { ...plan, disabled: true });
    assert.equal(requests.length, 0);
  } finally { globalThis.fetch = fetchBefore; }
});

test("a conflicting workflow write rejects without hiding the conflict or replaying", async () => {
  const fetchBefore = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async (_url, options = {}) => {
    if (!options.method) return new Response(JSON.stringify({ revision: 1 }));
    writes++;
    return new Response(JSON.stringify({ error: "conflict" }), { status: 409 });
  };
  try {
    await assert.rejects(persistInitialWorkflow("real-id", assignDraftModule(initialWorkbenchState(), null, "research")), { code: "conflict" });
    assert.equal(writes, 1);
  } finally { globalThis.fetch = fetchBefore; }
});
