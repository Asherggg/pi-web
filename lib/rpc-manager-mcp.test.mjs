import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

function makeInner(execute) {
  return {
    sessionId: "mcp-catalog-test-session",
    sessionFile: undefined,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    model: undefined,
    modelRuntime: { getModel: () => undefined, refresh: async () => {} },
    sessionManager: { getCwd: () => process.cwd() },
    settingsManager: { setProjectTrusted: () => {} },
    agent: { state: {} },
    extensionRunner: {
      getRegisteredCommands: () => [],
      getToolDefinition: (name) => name === "mcp" ? { execute } : undefined,
      createContext: () => ({ mode: "rpc" }),
      setUIContext: () => {},
      emit: async () => {},
    },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    subscribe: () => () => {},
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    pendingMessageCount: 0,
    getAllTools: () => [],
    getActiveToolNames: () => [],
    dispose: () => {},
    reload: async () => {},
  };
}

test("loads the MCP catalog through the proxy tool without adding chat messages", async () => {
  const calls = [];
  const execute = async (_id, params) => {
    calls.push(params);
    if (params.server === undefined) {
      return {
        details: {
          servers: [
            { name: "alpha", status: "cached" },
            { name: "beta", status: "disabled", disabled: true },
            { name: "gamma", status: "connected" },
          ],
        },
      };
    }
    if (params.server === "alpha") {
      return { details: { tools: ["alpha.read", "alpha.write"] } };
    }
    throw new Error("gamma list failed");
  };

  const wrapper = new AgentSessionWrapper(makeInner(execute));
  const catalog = await wrapper.send({ type: "get_mcp_tools" });

  assert.deepEqual(calls, [{}, { server: "alpha" }, { server: "gamma" }]);
  assert.deepEqual(catalog, {
    servers: [
      { name: "alpha", status: "cached", tools: ["alpha.read", "alpha.write"] },
      { name: "beta", status: "disabled", disabled: true, tools: [] },
      { name: "gamma", status: "connected", tools: [], error: "gamma list failed" },
    ],
    totalTools: 2,
  });
  wrapper.destroy();
});
