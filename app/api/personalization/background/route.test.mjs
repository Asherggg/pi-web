import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

function request(url, init = {}) {
  return new Request(url, {
    ...init,
    headers: { host: "localhost", ...init.headers },
  });
}

test("background API persists, serves, updates, and deletes an image", async (t) => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-background-api-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });

  const { DELETE, GET, PATCH, PUT } = await jiti.import("./route.ts");
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const putResponse = await PUT(request("http://localhost/api/personalization/background", {
    method: "PUT",
    headers: {
      "Content-Type": "image/png",
      "X-Pi-Background-Name": encodeURIComponent("桌面.png"),
      "X-Pi-Background-Strength": "0.42",
      "X-Pi-Background-Fit": "contain",
    },
    body: png,
  }));
  assert.equal(putResponse.status, 200);

  const getResponse = await GET(request("http://localhost/api/personalization/background"));
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(decodeURIComponent(getResponse.headers.get("x-pi-background-name")), "桌面.png");
  assert.equal(getResponse.headers.get("x-pi-background-strength"), "0.42");
  assert.equal(getResponse.headers.get("x-pi-background-fit"), "contain");
  assert.deepEqual(new Uint8Array(await getResponse.arrayBuffer()), png);

  const patchResponse = await PATCH(request("http://localhost/api/personalization/background", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ strength: 0.7, fit: "cover" }),
  }));
  assert.equal(patchResponse.status, 200);
  const updatedResponse = await GET(request("http://localhost/api/personalization/background"));
  assert.equal(updatedResponse.headers.get("x-pi-background-strength"), "0.7");
  assert.equal(updatedResponse.headers.get("x-pi-background-fit"), "cover");

  const deleteResponse = await DELETE(request("http://localhost/api/personalization/background", {
    method: "DELETE",
  }));
  assert.equal(deleteResponse.status, 200);
  assert.equal((await GET(request("http://localhost/api/personalization/background"))).status, 404);
});

test("background API rejects cross-origin writes", async () => {
  const { PUT } = await jiti.import("./route.ts");
  const response = await PUT(request("http://localhost/api/personalization/background", {
    method: "PUT",
    headers: {
      Origin: "http://attacker.example",
      "Sec-Fetch-Site": "cross-site",
      "Content-Type": "image/png",
    },
    body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  }));
  assert.equal(response.status, 403);
});
