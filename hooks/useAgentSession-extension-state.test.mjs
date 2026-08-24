import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const chatWindowSource = readFileSync(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const loadStart = source.indexOf("  const applyLoadedAgentState = useCallback");
const loadEnd = source.indexOf("  const loadContext = useCallback", loadStart);
const loadSource = source.slice(loadStart, loadEnd);

test("hydrates extension status without waiting for the session transcript", () => {
  assert.notEqual(loadStart, -1);
  assert.notEqual(loadEnd, -1);
  assert.match(loadSource, /const agentStatePromise = includeState/);
  assert.match(loadSource, /applyLoadedAgentState\(sid, agentState\)/);
  assert.match(loadSource, /liveState\.extensionStatuses !== undefined[\s\S]*?setExtensionStatuses/);

  const stateRequest = loadSource.indexOf("const agentStatePromise = includeState");
  const transcriptRequest = loadSource.indexOf("const params = new URLSearchParams");
  const immediateApply = loadSource.indexOf("applyLoadedAgentState(sid, agentState)");
  const transcriptApply = loadSource.indexOf("setMessages(persistedMessages)");

  assert.ok(stateRequest < transcriptRequest);
  assert.ok(immediateApply < transcriptApply);
});

test("keeps extension status visible while a long transcript is loading", () => {
  const loadingStart = chatWindowSource.indexOf("  if (loading) {");
  const loadingEnd = chatWindowSource.indexOf("  if (error) {", loadingStart);
  const loadingSource = chatWindowSource.slice(loadingStart, loadingEnd);

  assert.notEqual(loadingStart, -1);
  assert.notEqual(loadingEnd, -1);
  assert.match(loadingSource, /<ExtensionStatusBar/);
  assert.match(loadingSource, /statuses=\{extensionStatuses\}/);
  assert.match(loadingSource, /loadMcpTools=\{loadMcpToolCatalog\}/);
});
