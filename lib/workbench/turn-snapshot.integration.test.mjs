import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { TurnSnapshotStore } = await jiti.import("./turn-snapshot-store.ts");
const { createTurnSnapshotExtension } = await jiti.import("./turn-snapshot-extension.ts");
const exec = promisify(execFile);
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, { stop = false, continueOnce = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-snapshot-sdk-"));
  const cwd = join(root, "checkout"); const agentDir = join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  await exec("git", ["init", "--template=", "-q"], { cwd });
  await writeFile(join(cwd, "a.txt"), "original");
  await exec("git", ["-c", "core.fsmonitor=false", "add", "."], { cwd });
  const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
  manager.appendMessage({ role: "user", content: "history before opt in", timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage([fauxText("history has no snapshot")]));
  const store = new TurnSnapshotStore(agentDir);
  const faux = fauxProvider({ models: [{ id: "snapshot-model" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const toolStarted = gate();
  let toolBaseline;
  let continued = false;
  const extension = (pi) => {
    pi.registerTool({ name: "mutate", label: "mutate", description: "fixture mutation", parameters: { type: "object", properties: {} },
      execute: async (_call, _params, signal) => {
        const state = JSON.parse(await readFile(join(store.directory, "state.json"), "utf8"));
        const record = state.records.find((r) => r.sessionId === manager.getSessionId() && r.status === "open");
        assert.ok(record, "an open record was stored before the first tool");
        const manifest = JSON.parse(await readFile(join(store.directory, "records", record.snapshotId, "before.json"), "utf8"));
        assert.equal(manifest.capture.state, "complete", "the baseline finished before any tool could execute");
        toolBaseline = record.beforeEntryId;
        await writeFile(join(cwd, "a.txt"), "tool changed");
        toolStarted.resolve();
        if (stop) {
          await new Promise((done) => signal.aborted ? done() : signal.addEventListener("abort", done, { once: true }));
          await writeFile(join(cwd, "cleanup.txt"), "written while Stop unwound");
        }
        return { content: [{ type: "text", text: "done" }], details: undefined };
      },
    });
    if (continueOnce) pi.on("agent_before_settle", async (_event, ctx) => {
      if (continued || !await store.isEnabled(ctx.sessionManager.getSessionId())) return;
      continued = true;
      return { continue: true, entries: [{ type: "custom_message", customType: "fixture-continuation", content: "Complete one final verification", display: false }] };
    });
  };
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [createTurnSnapshotExtension(store), extension],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel("snapshot-model"), sessionManager: manager, settingsManager, resourceLoader });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "rpc" });
  return { cwd, agentDir, manager, store, faux, session, toolStarted, baseline: () => toolBaseline };
}

test("Pi 1.4 awaits BEFORE capture before tools and final capture before settled subscribers and prompt completion", async (t) => {
  const { cwd, manager, store, faux, session, baseline } = await fixture(t, { continueOnce: true });
  faux.setResponses([fauxAssistantMessage([fauxText("uncaptured run")])]);
  await session.prompt("not enabled yet");
  assert.deepEqual((await store.list(session.sessionId)).snapshots, []);
  await store.setEnabled(session.sessionId, true);
  const beforeLeaf = manager.getLeafId();
  let settledState; let starts = 0;
  session.subscribe((event) => {
    if (event.type === "agent_start") starts++;
    if (event.type === "agent_settled") settledState = JSON.parse(readFileSync(join(store.directory, "state.json"), "utf8"));
  });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("mutate", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("first response")]),
    fauxAssistantMessage([fauxText("continued response")]),
  ]);
  await session.prompt("mutate and continue");
  const listing = await store.list(session.sessionId);
  assert.equal(listing.snapshots.length, 1);
  const [snapshot] = listing.snapshots;
  assert.equal(snapshot.status, "completed"); assert.equal(snapshot.before.state, "complete"); assert.equal(snapshot.after.state, "complete");
  assert.equal(starts, 2, "automatic continuation shares the first baseline"); assert.equal(baseline(), beforeLeaf);
  const atEmission = settledState.records.find((r) => r.snapshotId === snapshot.snapshotId);
  assert.equal(atEmission.status, "completed"); assert.equal(atEmission.after.state, "complete");
  assert.equal(snapshot.afterEntryId, manager.getLeafId());
  assert.deepEqual((await store.detail(session.sessionId, snapshot.snapshotId)).files, [{ path: "a.txt", kind: "modified", before: "original", after: "tool changed" }]);
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "tool changed");
  assert.ok(!manager.getEntries().some((e) => e.customType?.includes("snapshot")), "recording adds no session JSONL entries");
});

test("Stop captures final tool cleanup at the awaited settled boundary using a fresh capture signal", async (t) => {
  const { store, faux, session, toolStarted } = await fixture(t, { stop: true });
  await store.setEnabled(session.sessionId, true);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("mutate", {})], { stopReason: "toolUse" })]);
  const prompting = session.prompt("mutate until stopped");
  await toolStarted.promise;
  await session.abort();
  await prompting;
  const [snapshot] = (await store.list(session.sessionId)).snapshots;
  assert.equal(snapshot.status, "stopped"); assert.equal(snapshot.after.state, "complete");
  const detail = await store.detail(session.sessionId, snapshot.snapshotId);
  assert.deepEqual(detail.files.map((f) => [f.path, f.after]), [["a.txt", "tool changed"], ["cleanup.txt", "written while Stop unwound"]]);
  assert.equal(detail.coverage.state, "partial");
});

test("extension preserves unknown outcomes, disables mid-run only affect future turns, and shutdown is interrupted", async (t) => {
  const { manager, cwd, store } = await fixture(t);
  await store.setEnabled(manager.getSessionId(), true);
  const handlers = new Map();
  createTurnSnapshotExtension(store)({ on: (event, handler) => { handlers.set(event, handler); } });
  const ctx = { cwd, sessionManager: manager, signal: undefined };
  await handlers.get("agent_start")({}, ctx);
  await store.setEnabled(manager.getSessionId(), false);
  await writeFile(join(cwd, "a.txt"), "changed during unknown run");
  await handlers.get("agent_settled")({ aborted: false }, ctx);
  const [unknown] = (await store.list(manager.getSessionId())).snapshots;
  assert.equal(unknown.status, "unknown");
  await handlers.get("agent_start")({}, ctx); await handlers.get("agent_settled")({ aborted: false }, ctx);
  assert.equal((await store.list(manager.getSessionId())).snapshots.length, 1);
  await store.setEnabled(manager.getSessionId(), true);
  await handlers.get("agent_start")({}, ctx); await handlers.get("session_shutdown")({}, ctx);
  const interrupted = (await store.list(manager.getSessionId())).snapshots.find((s) => s.status === "interrupted");
  assert.ok(interrupted); assert.equal(interrupted.after, null); assert.equal(interrupted.coverage.state, "unavailable");
});
