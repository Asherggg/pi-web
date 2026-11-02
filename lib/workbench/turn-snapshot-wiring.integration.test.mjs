import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { TURN_SNAPSHOT_EXTENSION_PATH } = await jiti.import("./turn-snapshot.ts");

test("startRpcSession narrowly wires the named recorder into a Chat-only saved session runtime", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-snapshot-wiring-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-snapshot-wiring-cwd-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
  manager.appendMessage({ role: "user", content: "saved before runtime start", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "saved response" }], timestamp: Date.now() });
  const { startRpcSession } = await jiti.import("../rpc-manager.ts");
  const { session } = await startRpcSession(manager.getSessionId(), manager.getSessionFile(), undefined, { toolNames: [] });
  t.after(async () => {
    await session.shutdown();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true });
  });
  await session.waitUntilReady();
  const extensions = session.inner.resourceLoader.getExtensions().extensions;
  assert.ok(extensions.some((extension) => extension.path === TURN_SNAPSHOT_EXTENSION_PATH));
  assert.ok(!session.inner.getAllTools().some((tool) => tool.name.includes("snapshot")), "recording adds no model-callable tool");
  assert.deepEqual(manager.getEntries().map((entry) => entry.type), ["message", "message"]);
});
